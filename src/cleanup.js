import { lstatSync, realpathSync, readdirSync, mkdirSync, readFileSync, writeFileSync, rmSync, statfsSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { browserProfile } from './evidence.js';

const day = 86400_000;
const terminal = job => ['merged', 'cancelled', 'done'].includes(job?.status);
const same = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const within = (root, target) => { const rel = relative(resolve(root), resolve(target)); return !!rel && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..'; };
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id);
const treeName = (name, id) => validId(id) && (name === id || name.startsWith(`${id}@`) && /^[\w.-]+$/.test(name.slice(id.length + 1)) || name.startsWith(`${id}-`) && /^(t\d+|(?:review|consult|preview|merge)-[\w-]+)$/.test(name.slice(id.length + 1)));
const branchName = (name, id) => validId(id) && (name === `ai-team/${id}` || name.startsWith(`ai-team/${id}-`));
const manifest = (reason, now = Date.now()) => ({ id: randomUUID(), at: new Date(now).toISOString(), reason, dryRun: true, items: [] });
const item = (kind, target, bytes, reason, extra = {}) => ({ kind, target, bytes, reason, ...extra });
function entries(path) { try { return readdirSync(path).sort(); } catch { return []; } }
function stat(path) { try { return lstatSync(path); } catch { return null; } }

// Check every component, including ancestors of the allowed directory.
function safePath(path, root, missing = false) {
  const target = resolve(path), base = resolve(root);
  if (!within(base, target)) throw new Error('Target outside allowed directory');
  for (let p = target;; p = dirname(p)) {
    const s = stat(p);
    if (!s && !missing) throw new Error('Target does not exist');
    if (s?.isSymbolicLink()) throw new Error('Symlink or junction');
    if (p === dirname(p)) break;
  }
  const actual = realpathSync(base);
  if (!same(actual, base)) throw new Error('Unsafe allowed directory');
  if (stat(target) && !within(actual, realpathSync(target))) throw new Error('Target outside allowed directory');
  return target;
}

function walk(path, visit) {
  const s = stat(path);
  if (!s || s.isSymbolicLink()) return;
  if (visit(path, s) === false) return;
  if (s.isDirectory()) for (const name of entries(path)) walk(join(path, name), visit);
}
function bytes(path) { let total = 0; walk(path, (_, s) => { if (s.isFile()) total += s.size; }); return total; }
function noLinks(path) {
  const s = lstatSync(path);
  if (s.isSymbolicLink()) throw new Error('Symlink or junction');
  if (s.isDirectory()) for (const name of readdirSync(path)) noLinks(join(path, name));
}

async function command(root, args, { run }) {
  if (!run) throw new Error('Missing run dependency');
  return run(['git'], ['-C', root, ...args], { allowFailure: true, timeoutMs: 60_000 });
}
async function query(root, args, ctx) {
  if (ctx.git) {
    const result = await ctx.git(root, args);
    if (typeof result === 'string') return result;
    if (result.code !== 0) throw new Error(result.stderr || 'Git query failed');
    return result.stdout;
  }
  const result = await command(root, args, ctx);
  if (result.code !== 0) throw new Error(result.stderr || 'Git query failed');
  return result.stdout;
}
async function trees(root, ctx) {
  return (await query(root, ['worktree', 'list', '--porcelain', '-z'], ctx)).split(/[\0\r\n]/).filter(l => l.startsWith('worktree ')).map(l => resolve(l.slice(9)));
}
async function branches(root, ctx) {
  return (await query(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/ai-team/'], ctx)).split(/\r?\n/).filter(l => l.startsWith('refs/heads/ai-team/')).map(l => l.slice(11));
}
async function merged(root, branch, destination, ctx) {
  if (!destination || destination.startsWith('-')) return false;
  const result = await command(root, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, destination], ctx);
  if (result.code > 1) throw new Error(result.stderr || 'Cannot verify branch ancestry');
  return result.code === 0;
}

// events.page(jobId, afterSeq, limit) returns raw {seq, body} or parsed events.
// events.transaction(fn) atomically calls fn(tx); tx.deleteActivity(jobId, seqs)
// and tx.insert(jobId, event) are synchronous DB callbacks. Delete only those seqs.
async function allEvents(events, jobId) {
  if (!events?.page) throw new Error('Missing paginated events dependency');
  const rows = []; let after = 0;
  for (;;) {
    const page = await events.page(jobId, after, 1000);
    if (!Array.isArray(page)) throw new Error('Invalid event page');
    if (!page.length) return rows;
    for (const row of page) {
      if (!Number.isSafeInteger(row.seq) || row.seq <= after) throw new Error('Invalid event pagination');
      const body = typeof row.body === 'string' ? JSON.parse(row.body) : row.body || row;
      if (body.job && body.job !== jobId) throw new Error('Event belongs to another job');
      rows.push({ ...body, seq: row.seq }); after = row.seq;
    }
  }
}

async function planGit(out, { job, dataDir, root, run, git }) {
  const ctx = { run, git }, dir = join(dataDir, 'worktrees');
  for (const target of await trees(root, ctx)) if (within(dir, target) && same(dirname(target), dir) && treeName(basename(target), job.id)) {
    out.items.push(item('worktree', target, bytes(target), 'Finished job worktree', { root, jobId: job.id }));
  }
  const destination = job.mergedInto?.commit || job.baseBranch;
  for (const target of await branches(root, ctx)) if (branchName(target, job.id)) {
    const keep = !await merged(root, target, destination, ctx);
    out.items.push(item('branch', target, 0, keep ? 'unmerged – kept' : 'Merged job branch', { root, jobId: job.id, destination, keep }));
  }
}

export async function planJob({ job, dataDir, root, run, git, events }) {
  const out = manifest('Finished job cleanup');
  if (!terminal(job)) return out;
  if (!validId(job.id)) throw new Error('Invalid job id');
  if (root) await planGit(out, { job, dataDir, root, run, git });
  for (const linked of job.linked || []) if (linked.path) await planGit(out, { job: { ...job, ...linked, id: job.id, mergedInto: linked.mergedInto }, dataDir, root: linked.path, run, git });
  if (events) {
    const rows = await allEvents(events, job.id);
    if (rows.some(e => e.type === 'ACTIVITY')) out.items.push(item('events', job.id, Buffer.byteLength(JSON.stringify(rows)), 'Archive and compact ACTIVITY', { jobId: job.id }));
  }
  return out;
}

function finite(value, fallback) { return Number.isFinite(value) && value >= 0 ? value : fallback; }
function protectedSessions(jobs) { return jobs.filter(j => !terminal(j)).flatMap(j => (j.tasks || []).map(t => t.cliSession?.id).filter(Boolean)); }
function expiredEvidence(path, job, cutoff) {
  if (job && !terminal(job)) return false;
  const s = stat(path), updated = Date.parse(job?.updatedAt || '');
  return s?.isDirectory() && Math.max(s.mtimeMs, Number.isFinite(updated) ? updated : 0) < cutoff;
}

export async function planPeriodic({ jobs = [], dataDir, projects = [], agents = [], config = {}, now = Date.now(), run, git, isActive = () => false }) {
  const out = manifest('Periodic cleanup', now);
  for (const job of jobs) if (terminal(job) && !await isActive(job.id)) {
    const root = projects.find(p => p.id === job.project)?.path;
    const planned = await planJob({ job, dataDir, root, run, git });
    out.items.push(...planned.items);
  }
  // Missing jobs have no proven terminal status or merge destination.
  for (const project of projects) {
    const dir = join(dataDir, 'worktrees');
    for (const target of await trees(project.path, { run, git })) {
      const id = basename(target).match(/^([0-9a-f]{8})(?:$|@|-)/i)?.[1];
      if (id && !jobs.some(j => j.id === id) && !await isActive(id) && same(dirname(target), dir) && treeName(basename(target), id)) out.items.push(item('worktree', target, bytes(target), 'Unknown job status – kept', { root: project.path, jobId: id, keep: true }));
    }
    for (const target of await branches(project.path, { run, git })) {
      const id = target.match(/^ai-team\/([0-9a-f]{8})(?:$|-)/i)?.[1];
      if (id && !jobs.some(j => j.id === id) && !await isActive(id)) out.items.push(item('branch', target, 0, 'unmerged – kept', { root: project.path, jobId: id, keep: true }));
    }
  }
  const backupDir = resolve(config.backupDir || join(dataDir, 'backups'));
  const backups = entries(backupDir).filter(n => /^team-.*\.sqlite$/.test(n)).map(n => ({ path: join(backupDir, n), stat: stat(join(backupDir, n)) })).filter(b => b.stat?.isFile()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || basename(b.path).localeCompare(basename(a.path)));
  let total = 0, kept = 0, full = false;
  for (const b of backups) {
    if (!kept || !full && kept < Math.max(1, finite(config.maxBackups, 14)) && total + b.stat.size <= finite(config.maxBackupMB, 512) * 1024 * 1024) { total += b.stat.size; kept++; }
    else { full = true; out.items.push(item('backup', b.path, b.stat.size, 'Backup count or size limit')); }
  }
  const evidence = join(dataDir, 'evidence'), cutoff = new Date(now).getTime() - finite(config.retentionDays, 30) * day;
  for (const name of entries(evidence)) {
    const path = join(evidence, name), job = jobs.find(j => j.id === name);
    if (expiredEvidence(path, job, cutoff) && !await isActive(name)) { out.items.push(item('evidence', path, bytes(path), 'Evidence retention expired', { jobId: name, retentionDays: finite(config.retentionDays, 30) })); continue; }
    walk(path, (target, s) => {
      if (s.isDirectory() && browserProfile(target)) { out.items.push(item('evidence', target, bytes(target), 'Browser profile')); return false; }
    });
  }
  const protectedIds = protectedSessions(jobs), sessionCutoff = new Date(now).getTime() - 30 * day;
  for (const agent of agents) if (agent.home) for (const dir of ['sessions', 'projects']) walk(join(agent.home, dir), (path, s) => {
    if (s.isFile() && path.endsWith('.jsonl') && s.mtimeMs < sessionCutoff && !protectedIds.some(id => basename(path).includes(id))) out.items.push(item('session', path, s.size, 'CLI session older than 30 days', { agentId: agent.id }));
  });
  out.items = out.items.filter((entry, i, all) => all.findIndex(e => e.kind === entry.kind && e.target === entry.target && e.root === entry.root) === i);
  return out;
}

function repo(entry, ctx) {
  const roots = [ctx.root, ...(ctx.projects || []).map(p => p.path)].filter(Boolean);
  const root = roots.find(r => same(r, entry.root));
  if (!root) throw new Error('Unknown repository');
  return root;
}
async function eligible(entry, ctx) {
  if (!entry.jobId) return true;
  if (await ctx.isActive?.(entry.jobId)) return false;
  const job = ctx.jobs?.find(j => j.id === entry.jobId);
  return !job || terminal(job);
}

function fsTarget(entry, ctx) {
  const { dataDir } = ctx;
  if (entry.kind === 'session') {
    if (!entry.target.endsWith('.jsonl')) throw new Error('Invalid session file');
    for (const agent of ctx.agents || []) if (agent.home && (!entry.agentId || entry.agentId === agent.id)) for (const dir of ['sessions', 'projects']) {
      const root = join(agent.home, dir);
      if (within(root, entry.target)) return safePath(entry.target, root);
    }
    throw new Error('Session outside member directories');
  }
  const target = safePath(entry.target, dataDir);
  if (entry.kind === 'worktree' && (!same(dirname(target), join(dataDir, 'worktrees')) || !treeName(basename(target), entry.jobId))) throw new Error('Invalid job worktree');
  if (entry.kind === 'backup' && (!same(dirname(target), ctx.config?.backupDir || join(dataDir, 'backups')) || !/^team-.*\.sqlite$/.test(basename(target)) || !lstatSync(target).isFile())) throw new Error('Invalid backup file');
  if (entry.kind === 'evidence' && (!within(join(dataDir, 'evidence'), target) || !lstatSync(target).isDirectory())) throw new Error('Invalid evidence directory');
  return target;
}

async function compact(entry, ctx) {
  if (!validId(entry.target) || entry.target !== entry.jobId) throw new Error('Invalid events job');
  const rows = await allEvents(ctx.events, entry.target), activities = rows.filter(e => e.type === 'ACTIVITY');
  if (!activities.length) return false;
  if (!ctx.events.transaction) throw new Error('Missing event transaction');
  const archive = join(ctx.dataDir, 'evidence', entry.target, `events-full-${Date.now()}.json.gz`);
  safePath(archive, ctx.dataDir, true);
  mkdirSync(dirname(archive), { recursive: true });
  safePath(archive, ctx.dataDir, true);
  const json = Buffer.from(JSON.stringify(rows));
  writeFileSync(archive, gzipSync(json), { flag: 'wx' });
  if (!gunzipSync(readFileSync(archive)).equals(json)) throw new Error('Event archive verification failed');
  const byAgent = Object.create(null);
  for (const e of activities) { const agent = e.from || 'unknown'; byAgent[agent] = (byAgent[agent] || 0) + 1; }
  const details = { count: activities.length, byAgent, archive: relative(ctx.dataDir, archive).replace(/\\/g, '/') };
  await ctx.events.transaction(tx => {
    tx.deleteActivity(entry.target, activities.map(e => e.seq));
    tx.insert(entry.target, { timestamp: new Date().toISOString(), job: entry.target, from: 'controller', to: 'team', type: 'ACTIVITY_SUMMARY', summary: `${activities.length} ACTIVITY events archived`, details });
  });
  return true;
}

// ctx supplies dataDir, root/projects, run/git, events, agents and current jobs.
// Pass current jobs/isActive again so a preview cannot delete a resumed job.
export async function apply(plan, ctx) {
  if (typeof plan.id !== 'string' || !/^[\w-]+$/.test(plan.id) || !Array.isArray(plan.items) || typeof plan.dryRun !== 'boolean') throw new Error('Invalid cleanup manifest');
  const file = join(ctx.dataDir, 'cleanup', `${plan.id}.json`);
  safePath(file, ctx.dataDir, true);
  mkdirSync(dirname(file), { recursive: true });
  safePath(file, ctx.dataDir, true);
  const result = { ...plan, results: [] };
  const save = () => { safePath(file, ctx.dataDir, true); writeFileSync(file, JSON.stringify(result, null, 2)); };
  save();
  for (const entry of plan.items) {
    let status = 'skipped', detail;
    try {
      if (!['worktree', 'branch', 'events', 'backup', 'evidence', 'session'].includes(entry.kind)) throw new Error('Unknown cleanup kind');
      if (entry.kind === 'branch') {
        if (!/^ai-team\//.test(entry.target) || !branchName(entry.target, entry.jobId)) throw new Error('Invalid cleanup branch');
        const root = repo(entry, ctx);
        if (!plan.dryRun && !entry.keep && await eligible(entry, ctx)) {
          const job = ctx.jobs?.find(j => j.id === entry.jobId);
          const current = job?.linked?.find(l => l.path && same(l.path, root)) || job;
          const destination = current ? current.mergedInto?.commit || current.baseBranch : entry.destination;
          if (await merged(root, entry.target, destination, ctx)) {
            const r = await command(root, ['branch', '-D', '--', entry.target], ctx);
            if (r.code !== 0) throw new Error(r.stderr || 'Branch removal failed');
            status = 'ok';
          } else detail = 'unmerged – kept';
        }
      } else if (entry.kind === 'events') {
        if (!validId(entry.target) || entry.target !== entry.jobId) throw new Error('Invalid events job');
        safePath(join(ctx.dataDir, 'evidence', entry.target), ctx.dataDir, true);
        if (!plan.dryRun && await eligible(entry, ctx) && await compact(entry, ctx)) status = 'ok';
      } else {
        const target = fsTarget(entry, ctx);
        noLinks(target);
        if (entry.reason === 'Browser profile' && (entry.kind !== 'evidence' || !browserProfile(target))) throw new Error('Not a browser profile');
        if (!plan.dryRun && !entry.keep && (entry.reason === 'Browser profile' || await eligible(entry, ctx))) {
          if (entry.kind === 'worktree') {
            const root = repo(entry, ctx);
            if (!(await trees(root, ctx)).some(p => same(p, target))) throw new Error('Worktree is not registered');
            safePath(target, ctx.dataDir); noLinks(target);
            const r = await command(root, ['worktree', 'remove', '--force', target], ctx);
            if (r.code !== 0) throw new Error(r.stderr || 'Worktree removal failed');
            const prune = await command(root, ['worktree', 'prune'], ctx);
            if (prune.code !== 0) throw new Error(prune.stderr || 'Worktree prune failed');
            status = 'ok';
          } else if (entry.kind === 'session' && (protectedSessions(ctx.jobs || []).some(id => basename(target).includes(id)) || lstatSync(target).mtimeMs >= new Date(ctx.now ?? Date.now()).getTime() - 30 * day)) detail = 'Recent or active session – kept';
          else if (entry.kind === 'evidence' && entry.reason === 'Evidence retention expired' && !expiredEvidence(target, ctx.jobs?.find(j => j.id === entry.jobId), new Date(ctx.now ?? Date.now()).getTime() - finite(ctx.config?.retentionDays, finite(entry.retentionDays, 30)) * day)) detail = 'Recent evidence – kept';
          else if (entry.kind === 'backup' && entries(dirname(target)).filter(n => /^team-.*\.sqlite$/.test(n) && stat(join(dirname(target), n))?.isFile()).sort((a, b) => stat(join(dirname(target), b)).mtimeMs - stat(join(dirname(target), a)).mtimeMs || b.localeCompare(a))[0] === basename(target)) detail = 'Newest backup – kept';
          else {
            safePath(target, entry.kind === 'session' ? dirname(target) : ctx.dataDir); noLinks(target);
            rmSync(target, { recursive: entry.kind === 'evidence', force: false }); status = 'ok';
          }
        }
      }
    } catch (e) { status = 'error'; detail = e.message; }
    result.results.push({ ...entry, status, ...(detail ? { detail } : {}) }); save();
  }
  return result;
}

export function storageStats(dataDir) {
  const dataDirBytes = bytes(dataDir);
  let freeBytes = null;
  try { const s = statfsSync(dataDir); freeBytes = Number(s.bavail) * Number(s.bsize); } catch {}
  return { dataDirBytes, freeBytes };
}
