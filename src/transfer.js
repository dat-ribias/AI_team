import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { run } from './process.js';
import { hash } from './memory.js';
import { obligations } from './discussions.js';

const git = async (cwd, args) => (await run(['git'], ['-C', cwd, ...args], { timeoutMs: 120000 })).stdout.trim();
export const secret = path => /(^|\/)(\.env(?:\..*)?|auth\.json|controller\.token|id_(?:rsa|ed25519).*|[^/]*\.(?:pem|key|pfx))$/i.test(path);
function safePath(root, path) {
  if (typeof path !== 'string' || !path || path.length > 1000 || /[\\:\x00-\x1f]|^\/|(^|\/)\.\.?($|\/)|(^|\/)(?:\.git|\.team|\.codex|\.aws)(\/|$)/i.test(path) || secret(path)) throw new Error('Unsafe transfer path');
  const base = realpathSync(root), target = resolve(root, path);
  if (!target.startsWith(base + sep)) throw new Error('Transfer path is outside the worktree');
  for (let p = target; p !== base; p = dirname(p)) if (existsSync(p) && (lstatSync(p).isSymbolicLink() || !realpathSync(p).startsWith(base + sep))) throw new Error('Transfer cannot write through symlinks');
  return target;
}
async function changes(worktree) {
  const paths = [...new Set((await git(worktree, ['diff', '--no-ext-diff', '--name-only', '-z', 'HEAD']) + '\0' + await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))];
  let bytes = 0;
  return paths.map(path => {
    const file = safePath(worktree, path), deleted = !existsSync(file), data = deleted ? null : readFileSync(file);
    bytes += data?.length || 0;
    if (bytes > 50 * 2 ** 20) throw new Error('Uncommitted transfer files exceed 50 MiB');
    return { path, data: data?.toString('base64') ?? null, hash: data ? hash(data) : null };
  });
}

export async function exportTransfer(team, id) {
  const job = team.get(id);
  if (team.runs.has(id) || ['running','queued','merging'].includes(job.status)) throw new Error('Pause the job before exporting it');
  // ponytail: one repository per transfer; add explicit project mappings when linked-repository transfers are needed.
  if (job.linked?.length) throw new Error('Linked-repository jobs require a separate transfer for each repository');
  const lock = { job: id, agents: new Set(), abort: new AbortController() };
  team.runs.set(id, lock);
  const dir = mkdtempSync(join(team.dataDir, 'transfer-'));
  try {
    const commit = await git(job.worktree, ['rev-parse', 'HEAD']);
    const files = await changes(job.worktree), original = JSON.stringify(job);
    // Git bundles contain history too. Refuse known credential paths anywhere in that history.
    const objects = await git(job.worktree, ['rev-list', '--objects', commit]);
    if (objects.split('\n').some(line => secret(line.slice(line.indexOf(' ') + 1)))) throw new Error('Repository history contains credential files; transfer code separately after removing them');
    const bundle = join(dir, 'repository.bundle');
    await git(job.worktree, ['bundle', 'create', bundle, job.branch]);
    const data = readFileSync(bundle);
    if (data.length > 50 * 2 ** 20) throw new Error('Repository bundle exceeds 50 MiB');
    if (JSON.stringify(team.get(id)) !== original || await git(job.worktree, ['rev-parse', 'HEAD']) !== commit || JSON.stringify(await changes(job.worktree)) !== JSON.stringify(files)) throw new Error('Job changed during export; try again');
    const pick = (value, fields) => Object.fromEntries(fields.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
    const payload = { format: 'ai-team-transfer', version: 1, exportedAt: new Date().toISOString(), project: job.project,
      code: { base: job.base, commit, branch: job.branch, bundle: data.toString('base64'), sha256: hash(data), files },
      work: { id: job.id, goal: job.goal, kind: job.kind || 'code', stage: job.stage, tasks: (job.tasks.length ? job.tasks : job.transfer?.tasks || []).map(t => pick(t, ['instruction','kind','difficulty','files','context','dependsOn','done','checkpoint','contextGaps'])), reports: [...(job.transfer?.reports || []), ...job.reports].map(r => pick(r, ['agent','stage','task','summary','status','verdict','findings','tests','checkpoint','sources','conclusion'])), messages: [...(job.transfer?.messages || []), ...job.messages], discussions: [...(job.transfer?.discussions || []), ...(job.discussions || [])] },
      memory: team.memoryStore.export(job.project) };
    payload.work.obligations = [...(job.obligations || []).filter(o => o.status === 'unmapped'), ...obligations(job.discussions)];
    // Redact text records, never alter the Git bundle or binary file data.
    payload.work = JSON.parse(team.memoryStore.redact(JSON.stringify(payload.work)));
    return payload;
  } finally { if (!resolve(dir).startsWith(resolve(team.dataDir) + sep)) throw new Error('Invalid transfer temp directory'); rmSync(dir, { recursive: true, force: true }); team.runs.delete(id); team.emit('change'); }
}

export async function importTransfer(team, project, pack) {
  team.project(project);
  if (pack?.format !== 'ai-team-transfer' || pack.version !== 1 || !pack.code || !pack.work || typeof pack.work.goal !== 'string' || !pack.work.goal.trim() || pack.work.goal.length > 20000 || !['code','research'].includes(pack.work.kind) || !Array.isArray(pack.work.tasks) || pack.work.tasks.length > 100 || !Array.isArray(pack.work.reports) || pack.work.reports.length > 1000 || !Array.isArray(pack.work.messages) || !Array.isArray(pack.code.files) || pack.code.files.length > 10000) throw new Error('Invalid work transfer');
  const { code, work } = pack;
  if (work.discussions !== undefined && (!Array.isArray(work.discussions) || work.discussions.length > 1000)) throw new Error('Invalid discussion history');
  if (work.obligations !== undefined && (!Array.isArray(work.obligations) || work.obligations.length > 1000 || work.obligations.some(o => !o || typeof o.id !== 'string' || o.id.length > 100))) throw new Error('Invalid discussion obligations');
  const pending = (work.obligations ?? obligations(work.discussions)).map(o => {
    if (!o || typeof o.id !== 'string' || !o.id || o.id.length > 100) throw new Error('Invalid obligation ID');
    const text = (v, max = 2000) => typeof v === 'string' ? v.slice(0, max) : '';
    return { id: o.id, topic: text(o.topic, 200), reason: text(o.reason), status: 'unmapped', claims: (Array.isArray(o.claims) ? o.claims : []).slice(0, 12).map(c => ({ id: text(c?.id, 20), statement: text(c?.statement) })), pending: (Array.isArray(o.pending) ? o.pending : []).slice(0, 4).map(m => ({ id: text(m?.id, 50), text: text(m?.text), claimIds: (Array.isArray(m?.claimIds) ? m.claimIds : []).slice(0, 8).map(id => text(id, 20)) })), remaining: (Array.isArray(o.remaining) ? o.remaining : []).slice(0, 6).map(s => text(s, 500)) };
  });
  if (typeof work.id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(work.id)) throw new Error('Invalid source job');
  team.memoryStore.import(project, pack.memory, { [work.id]: 'validation' }, true);
  if (!/^[a-f0-9]{40,64}$/.test(code.base) || !/^[a-f0-9]{40,64}$/.test(code.commit) || !/^ai-team\/[a-z0-9-]+$/.test(code.branch) || typeof code.bundle !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(code.bundle)) throw new Error('Invalid repository bundle');
  const data = Buffer.from(code.bundle, 'base64');
  if (data.length > 50 * 2 ** 20 || hash(data) !== code.sha256) throw new Error('Repository bundle checksum failed');
  const root = team.project(project).path;
  if (accessLinked(team, project)) throw new Error('Import into a project without linked repositories');
  if (await git(root, ['rev-parse', 'HEAD']) !== code.base) throw new Error('Destination repository must be checked out at the exported base commit');
  // Validate the complete file manifest before creating a job or writing anything.
  let bytes = 0;
  const files = code.files.map(f => {
    safePath(root, f?.path);
    if (f.data !== null && (typeof f.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data))) throw new Error('Invalid transfer file');
    const content = f.data === null ? null : Buffer.from(f.data, 'base64'); bytes += content?.length || 0;
    if (bytes > 50 * 2 ** 20 || (content ? hash(content) : null) !== f.hash) throw new Error('Transfer file checksum failed');
    return { path: f.path, content };
  });
  const dir = mkdtempSync(join(team.dataDir, 'import-')), ref = `refs/ai-team-import/${randomUUID()}`;
  let job;
  try {
    const bundle = join(dir, 'repository.bundle'); writeFileSync(bundle, data);
    await git(root, ['bundle', 'verify', bundle]);
    await git(root, ['fetch', '--no-tags', bundle, `refs/heads/${code.branch}:${ref}`]);
    if (await git(root, ['rev-parse', ref]) !== code.commit || (await run(['git'], ['-C', root, 'merge-base', '--is-ancestor', code.base, code.commit], { allowFailure: true })).code !== 0) throw new Error('Bundle does not match exported commits');
    if ((await git(root, ['rev-list', '--objects', code.commit])).split('\n').some(line => secret(line.slice(line.indexOf(' ') + 1)))) throw new Error('Imported history contains credential files');
    job = await team.create({ project, goal: work.goal, paused: true, mode: 'full' });
    await git(job.worktree, ['-c', `core.hooksPath=${join(dir, 'no-hooks')}`, '-c', 'submodule.recurse=false', 'merge', '--ff-only', code.commit]);
    for (const f of files) {
      const target = safePath(job.worktree, f.path);
      if (f.content === null) { if (existsSync(target) && !lstatSync(target).isFile()) throw new Error('Transfer cannot delete a directory'); rmSync(target, { force: true }); }
      else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, f.content); }
    }
    job.revision = code.commit; job.kind = work.kind; job.status = 'paused'; job.stage = 'plan';
    job.transfer = JSON.parse(team.memoryStore.redact(JSON.stringify(work)));
    // Restore obligations as data; current task/recipient mappings need an explicit human action.
    job.obligations = JSON.parse(team.memoryStore.redact(JSON.stringify(pending.filter((o, i, all) => all.findIndex(x => x.id === o.id) === i))));
    job.transferFile = `.ai-team/transfer-${job.id}.json`;
    mkdirSync(join(job.worktree, '.ai-team'), { recursive: true });
    writeFileSync(join(job.worktree, job.transferFile), JSON.stringify(job.transfer, null, 2), { flag: 'wx' });
    job.messages = [{ at: new Date().toISOString(), from: 'user', text: 'Imported work: inspect the existing code and transfer checkpoints before planning. Continue unfinished work; validate previous results again.' }];
    // Old tests, approvals, account identity and CLI sessions are history, never execution authority.
    job.tested = job.reviewed = job.verified = null; job.tasks = []; job.reports = [];
    team.save(job);
    const memory = team.memoryStore.import(project, pack.memory, { [work.id]: job.id });
    team.event(job.id, 'user', 'team', 'IMPORT', 'Imported job is paused; review the code and continue when ready', { sourceJob: work.id, memory });
    return { job, memory };
  } catch (e) {
    if (job) { job.status = 'paused'; job.error = e.message; team.save(job); }
    throw e;
  } finally {
    await run(['git'], ['-C', root, 'update-ref', '-d', ref], { allowFailure: true });
    if (!resolve(dir).startsWith(resolve(team.dataDir) + sep)) throw new Error('Invalid transfer temp directory');
    rmSync(dir, { recursive: true, force: true });
  }
}
function accessLinked(team, project) { return team.project(project).access?.repos?.length; }
