import { existsSync } from 'node:fs';
import { basename, join, relative, resolve, isAbsolute } from 'node:path';

const same = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const within = (root, target) => { const rel = relative(resolve(root), resolve(target)); return !!rel && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..'; };
const branchId = name => name?.match(/^ai-team\/([0-9a-f]{8})(?:$|-)/i)?.[1] || null;
const treeId = path => basename(path).match(/^([0-9a-f]{8})(?:$|@|-)/i)?.[1] || null;
const lines = value => value.split(/\r?\n/).filter(Boolean);

// Một lượt reconcile chỉ đọc git: ctx.memo gom các lệnh trùng (for-each-ref, worktree list, nhánh chính...) giữa các job cùng repo.
const cached = (ctx, key, fn) => { if (!ctx.memo) return fn(); if (!ctx.memo.has(key)) ctx.memo.set(key, fn()); return ctx.memo.get(key); };
async function command(root, args, ctx) {
  return cached(ctx, `c\0${root}\0${args.join('\0')}`, () => ctx.run(['git'], ['--no-optional-locks', '-C', root, ...args], { allowFailure: true, timeoutMs: 60_000 }));
}
async function query(root, args, ctx) {
  if (ctx.git) return cached(ctx, `q\0${root}\0${args.join('\0')}`, () => ctx.git(root, ['--no-optional-locks', ...args]));
  const result = await command(root, args, ctx);
  if (result.code !== 0) throw new Error(result.stderr || 'Git query failed');
  return result.stdout.trim();
}
async function hasBranch(root, name, git) {
  const ref = `refs/heads/${name}`;
  return lines(await git(root, ['for-each-ref', '--format=%(refname)', ref])).includes(ref);
}

export async function mainBranchOf(root, project, git) {
  if (project?.mainBranch) return project.mainBranch;
  for (const name of ['master', 'main']) if (await hasBranch(root, name, git)) return name;
  return null;
}

export async function integrationBranchOf(root, project, git) {
  const name = project?.integrationBranch;
  return name && await hasBranch(root, name, git) ? name : null;
}

async function ancestor(root, commit, destination, ctx) {
  if (!commit || !destination) return false;
  const result = await command(root, ['merge-base', '--is-ancestor', commit, destination], ctx);
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || 'Cannot verify commit ancestry');
  return result.code === 0;
}
async function commitOf(root, revision, ctx) {
  if (!revision) return null;
  const result = await command(root, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], ctx);
  if (result.code === 0) return result.stdout.trim();
  if (result.code === 1 || result.code === 128) return null;
  throw new Error(result.stderr || 'Cannot resolve commit');
}
async function heads(root, ctx) {
  return lines(await query(root, ['for-each-ref', '--format=%(refname:strip=2)%09%(objectname)%09%(committerdate:iso-strict)', 'refs/heads/'], ctx)).map(line => {
    const [name, tip, lastCommitAt] = line.split('\t');
    return { name, tip, lastCommitAt };
  });
}
async function worktrees(root, ctx) {
  const output = await query(root, ['worktree', 'list', '--porcelain', '-z'], ctx);
  return output.split('\0\0').filter(Boolean).map(record => {
    const tree = { prunable: false };
    for (const field of record.split('\0')) {
      if (field.startsWith('worktree ')) tree.worktree = field.slice(9);
      else if (field.startsWith('HEAD ')) tree.tip = field.slice(5);
      else if (field.startsWith('branch refs/heads/')) tree.branch = field.slice(18);
      else if (field === 'prunable' || field.startsWith('prunable ')) tree.prunable = true;
    }
    return tree;
  }).filter(tree => tree.worktree);
}
async function dirtyFiles(tree, ctx) {
  if (tree.prunable || !existsSync(tree.worktree)) return [];
  const result = await command(tree.worktree, ['status', '--porcelain', '--untracked-files=all', '-z'], ctx);
  if (result.code !== 0) throw new Error(result.stderr || 'Cannot inspect worktree');
  const output = result.stdout;
  // Do not trim porcelain: the first column can be a significant space.
  const records = output.split('\0'), files = [];
  for (let i = 0; i < records.length; i++) if (records[i]) {
    files.push(records[i].slice(3));
    if (/[RC]/.test(records[i].slice(0, 2)) && records[i + 1]) files.push(records[++i]);
  }
  return [...new Set(files)];
}
async function count(root, base, tip, ctx) {
  return base ? Number(await query(root, ['rev-list', '--count', `${base}..${tip}`], ctx)) : null;
}

export async function inventoryJob({ job, root, project, dataDir, git, run, memo }) {
  const ctx = { git, run, memo }, repos = [];
  const sources = [{ ...job, path: root, config: project }, ...(job?.linked || []).map(linked => ({ ...linked, config: linked }))];
  for (const source of sources) {
    const repoRoot = source.path, read = (path, args) => query(path, args, ctx);
    const main = await mainBranchOf(repoRoot, source.config, read), integration = await integrationBranchOf(repoRoot, source.config, read);
    const refs = await heads(repoRoot, ctx), mainTip = refs.find(b => b.name === main)?.tip, integrationTip = refs.find(b => b.name === integration)?.tip;
    const branches = [], wip = [], dirty = [];
    // Match the job id prefix so both legacy names and title slugs include every child.
    const prefix = source.branch?.match(/^ai-team\/[0-9a-f]{8}(?=$|-)/i)?.[0] || source.branch || (job?.id ? `ai-team/${job.id}` : null);
    for (const branch of refs) if (prefix && (branch.name === prefix || branch.name.startsWith(`${prefix}-`))) {
      branches.push({ ...branch, ownCommits: await count(repoRoot, source.base, branch.tip, ctx), inMain: await ancestor(repoRoot, branch.tip, mainTip, ctx), inIntegration: await ancestor(repoRoot, branch.tip, integrationTip, ctx) });
    }
    for (const [i, task] of (source.tasks || []).entries()) if (task.checkpoint?.wip?.commit) {
      const commit = task.checkpoint.wip.commit, resolved = await commitOf(repoRoot, commit, ctx);
      const reachable = !!resolved && !!(await query(repoRoot, ['for-each-ref', `--contains=${resolved}`, '--format=%(refname)', 'refs/heads/'], ctx));
      wip.push({ task: task.id ?? i, commit, reachable, inMain: !!resolved && await ancestor(repoRoot, resolved, mainTip, ctx) });
    }
    for (const tree of await worktrees(repoRoot, ctx)) if (within(join(dataDir, 'worktrees'), tree.worktree) && job?.id && basename(tree.worktree).startsWith(job.id)) {
      const files = await dirtyFiles(tree, ctx);
      if (files.length) dirty.push({ worktree: tree.worktree, files });
    }
    const commit = source.revision || null, resolved = await commitOf(repoRoot, commit, ctx);
    const revision = { commit, exists: !!resolved, inMain: !!resolved && await ancestor(repoRoot, resolved, mainTip, ctx), inIntegration: !!resolved && await ancestor(repoRoot, resolved, integrationTip, ctx) };
    repos.push({ root: repoRoot, main, integration, branches, wip, dirty, revision });
  }
  return { repos };
}

export function classify(job, inventory) {
  const status = job?.status, repos = inventory?.repos || [];
  if (['running', 'queued', 'merging', 'paused'].includes(status)) return { state: 'working', reason: status === 'paused' ? 'paused' : status };
  const sources = [job, ...(job?.linked || [])];
  const merged = repos.map((repo, i) => {
    const own = repo.branches.filter(branch => branch.ownCommits > 0);
    const revision = repo.revision;
    const hasOwn = own.length > 0 || !!revision?.commit && !!sources[i]?.base && revision.commit !== sources[i].base;
    return !!repo.main && hasOwn && own.every(branch => branch.inMain) && (!revision?.commit || revision.exists && revision.inMain) && (repo.wip || []).every(wip => wip.inMain);
  });
  if (merged.length && merged.every(Boolean)) return { state: 'in_master', reason: 'mọi repo đã vào nhánh chính' };
  if (merged.some(Boolean)) return { state: 'merge_stuck', reason: `repo chưa vào nhánh chính: ${repos.filter((_, i) => !merged[i]).map(repo => repo.root).join(', ')}` };
  if (status === 'merged') {
    if (repos.length && repos.every(repo => repo.integration && repo.revision?.exists && repo.revision.inIntegration)) {
      return { state: 'awaiting_owner', reason: repos.map(repo => `đã vào ${repo.integration}, chờ duyệt RC lên ${repo.main || 'nhánh chính'}`).join('; ') };
    }
    const missing = repos.filter(repo => !repo.revision?.inMain);
    return { state: 'merge_stuck', reason: (missing.length ? missing : repos).map(repo => `đã ghi merged nhưng commit ${repo.revision?.commit || '?'} không có trong ${repo.main || 'nhánh chính'}`).join('; ') || 'đã ghi merged nhưng không có bằng chứng git' };
  }
  if (status === 'ready') {
    if (job.mergeFailure) {
      const { kind, files } = job.mergeFailure;
      return { state: 'merge_stuck', reason: kind, kind, ...(files ? { files } : {}) };
    }
    return { state: 'awaiting_owner', reason: 'chờ chủ duyệt' };
  }
  if (status === 'blocked') return { state: 'awaiting_owner', reason: job.error || 'blocked' };
  if (!job || status === 'cancelled') {
    const remaining = repos.flatMap(repo => [
      ...repo.branches.filter(branch => branch.ownCommits > 0 && !branch.inMain).map(branch => `branch ${branch.name} (${repo.root})`),
      ...(repo.wip || []).filter(wip => !wip.inMain).map(wip => `wip ${wip.commit} (${repo.root})`),
      ...(repo.dirty || []).map(tree => `worktree ${tree.worktree}: ${tree.files.join(', ')}`),
    ]);
    return { state: remaining.length ? 'cancelled_unmerged' : 'cancelled_clean', reason: remaining.join('; ') || 'không còn code chưa vào nhánh chính' };
  }
  if (job.kind === 'research' || status === 'done') return { state: 'done', reason: 'done' };
  if (status === 'waiting' && job.blockedReason?.kind === 'depends') return { state: 'working', reason: 'depends' };
  return { state: 'working', reason: status || 'working' };
}

export async function listOrphans({ projects, jobs, dataDir, git, run, memo }) {
  const ctx = { git, run, memo }, items = [];
  const known = id => id && jobs.some(job => job.id.toLowerCase() === id.toLowerCase());
  const owned = tree => known(branchId(tree.branch)) || known(treeId(tree.worktree)) || jobs.some(job => [job, ...(job.linked || [])].some(source => source.worktree && same(source.worktree, tree.worktree) || source.branch && tree.branch && (tree.branch === source.branch || tree.branch.startsWith(`${source.branch}-`))));
  for (const project of projects) {
    const root = project.path, read = (path, args) => query(path, args, ctx);
    const refs = await heads(root, ctx), main = await mainBranchOf(root, project, read), mainTip = refs.find(branch => branch.name === main)?.tip;
    for (const branch of refs) {
      const jobId = branchId(branch.name);
      if (jobId && !known(jobId)) items.push({ kind: 'branch', root, target: branch.name, branch: branch.name, tip: branch.tip, lastCommitAt: branch.lastCommitAt, inMain: await ancestor(root, branch.tip, mainTip, ctx), ownCommits: await count(root, mainTip, branch.tip, ctx), dirty: false, prunable: false, jobId });
    }
    const trees = await worktrees(root, ctx);
    for (const tree of trees) {
      if (same(root, tree.worktree) || same(trees[0].worktree, tree.worktree) || owned(tree) || !(tree.branch?.startsWith('ai-team/') || within(join(dataDir, 'worktrees'), tree.worktree))) continue;
      const tip = await commitOf(root, tree.tip, ctx), files = await dirtyFiles(tree, ctx);
      items.push({ kind: 'worktree', root, target: tree.worktree, ...(tree.branch ? { branch: tree.branch } : {}), tip, lastCommitAt: tip ? await query(root, ['show', '-s', '--format=%cI', tip], ctx) : null, inMain: await ancestor(root, tip, mainTip, ctx), ownCommits: tip ? await count(root, mainTip, tip, ctx) : null, dirty: files.length > 0, prunable: tree.prunable, jobId: branchId(tree.branch) || treeId(tree.worktree) });
    }
  }
  return items;
}
