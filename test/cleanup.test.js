import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { planJob, planPeriodic, apply, storageStats } from '../src/cleanup.js';
import { collect } from '../src/evidence.js';
import { run } from '../src/process.js';
import { Team, validateConfig } from '../src/team.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const day = 86400_000, now = Date.now();
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'ai-team-cleanup-'));
  const dataDir = join(temp, 'data'), home = join(temp, 'member');
  mkdirSync(dataDir); mkdirSync(home);
  const ctx = { temp, dataDir, agents: [{ id: 'test', home }], jobs: [], now, run };
  t.after(async () => { await ctx.stopServer?.(); if (ctx.team) { ctx.team.runs.clear(); ctx.team.previews.clear(); await ctx.team.close(); } rmSync(temp, { recursive: true, force: true }); });
  return ctx;
}
function file(path, size = 8, days = 0) {
  mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, Buffer.alloc(size));
  if (days) utimesSync(path, new Date(now - days * day), new Date(now - days * day));
  return path;
}
function oldDir(path, days = 40) { utimesSync(path, new Date(now - days * day), new Date(now - days * day)); }
function manual(items, dryRun = false) { return { id: 'test-manifest', at: new Date(now).toISOString(), reason: 'Test', dryRun, items }; }
async function git(ctx, args) {
  const r = await run(['git'], ['-C', ctx.root, ...args], { allowFailure: true });
  assert.equal(r.code, 0, r.stderr); return r.stdout.trim();
}
async function repository(t) {
  const ctx = fixture(t); ctx.root = join(ctx.temp, 'repo');
  await run(['git'], ['init', '-b', 'main', ctx.root]);
  await git(ctx, ['config', 'core.autocrlf', 'false']);
  file(join(ctx.root, 'hello.txt'));
  await git(ctx, ['add', '.']);
  await git(ctx, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  ctx.jobs = [{ id: 'abcdef12', status: 'merged', project: 'p', baseBranch: 'main', tasks: [] }];
  return ctx;
}

test('dry-run records results without deleting worktrees, branches, files or events', async t => {
  const ctx = await repository(t), job = ctx.jobs[0];
  const target = join(ctx.dataDir, 'worktrees', job.id);
  await git(ctx, ['worktree', 'add', '-b', `ai-team/${job.id}`, target, 'main']);
  let pages = 0, transactions = 0;
  ctx.events = { page: (_, after) => { pages++; return after ? [] : [{ seq: 1, job: job.id, type: 'ACTIVITY' }]; }, transaction: () => { transactions++; } };
  const backup = file(join(ctx.dataDir, 'backups', 'team-old.sqlite'));
  const plan = await planJob({ ...ctx, job });
  plan.items.push({ kind: 'backup', target: backup, bytes: 8, reason: 'Old' });
  const result = await apply(plan, ctx);
  assert.ok(existsSync(target)); assert.ok(existsSync(backup));
  assert.equal(transactions, 0); assert.equal(pages, 2);
  assert.ok((await git(ctx, ['branch', '--list', `ai-team/${job.id}`])).includes(job.id));
  assert.ok(result.results.every(r => r.status === 'skipped'));
  assert.equal(JSON.parse(readFileSync(join(ctx.dataDir, 'cleanup', `${plan.id}.json`))).dryRun, true);
});

test('merged branches are removed, unmerged branches and similar job prefixes are kept', async t => {
  const ctx = await repository(t), job = ctx.jobs[0];
  await git(ctx, ['branch', `ai-team/${job.id}`]);
  await git(ctx, ['branch', `ai-team/${job.id}0`]);
  await git(ctx, ['checkout', '-b', `ai-team/${job.id}-t1`]);
  file(join(ctx.root, 'new.txt'));
  await git(ctx, ['add', '.']);
  await git(ctx, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'unmerged']);
  await git(ctx, ['checkout', 'main']);
  const plan = await planJob({ ...ctx, job }); plan.dryRun = false;
  assert.equal(plan.items.find(i => i.target.endsWith('-t1')).reason, 'unmerged – kept');
  assert.equal(plan.items.some(i => i.target.endsWith(`${job.id}0`)), false);
  const result = await apply(plan, ctx);
  assert.equal(result.results.find(i => i.target === `ai-team/${job.id}`).status, 'ok');
  assert.equal(await git(ctx, ['branch', '--list', `ai-team/${job.id}`]), '');
  assert.ok((await git(ctx, ['branch', '--list', `ai-team/${job.id}-t1`])).includes('-t1'));
});

test('apply rechecks ancestry after planning and uses mergedInto.commit', async t => {
  const ctx = await repository(t), job = ctx.jobs[0];
  job.mergedInto = { commit: await git(ctx, ['rev-parse', 'HEAD']) };
  job.baseBranch = 'missing-base';
  await git(ctx, ['branch', `ai-team/${job.id}`]);
  const plan = await planJob({ ...ctx, job }); plan.dryRun = false;
  await git(ctx, ['checkout', `ai-team/${job.id}`]);
  file(join(ctx.root, 'new.txt')); await git(ctx, ['add', '.']);
  await git(ctx, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'late change']);
  await git(ctx, ['checkout', 'main']);
  const result = await apply(plan, ctx);
  assert.equal(result.results[0].status, 'skipped');
  assert.equal(result.results[0].detail, 'unmerged – kept');
});

test('registered job and child worktrees are removed and pruned; unrelated worktrees are kept', async t => {
  const ctx = await repository(t), job = ctx.jobs[0];
  const names = [job.id, `${job.id}-t1`, `${job.id}-review-12345678`, `${job.id}-consult-12345678`, `${job.id}-preview-12345678`, `${job.id}-merge-12345678`, `${job.id}@p`, `${job.id}0`, `${job.id}-random`];
  for (const name of names) await git(ctx, ['worktree', 'add', '--detach', join(ctx.dataDir, 'worktrees', name), 'main']);
  const plan = await planJob({ ...ctx, job }); plan.dryRun = false;
  assert.equal(plan.items.filter(i => i.kind === 'worktree').length, 7);
  const result = await apply(plan, ctx);
  assert.ok(result.results.every(r => r.status === 'ok'));
  for (const name of names.slice(0, 7)) assert.equal(existsSync(join(ctx.dataDir, 'worktrees', name)), false);
  for (const name of names.slice(7)) assert.ok(existsSync(join(ctx.dataDir, 'worktrees', name)));
  assert.equal((await git(ctx, ['worktree', 'list', '--porcelain'])).includes(`${job.id}-t1`), false);
});

test('outside paths, forged kinds, root directories and non ai-team branches are rejected', async t => {
  const ctx = fixture(t), outside = file(join(ctx.temp, 'outside', 'team-old.sqlite'));
  const database = file(join(ctx.dataDir, 'team.sqlite'));
  const result = await apply(manual([
    { kind: 'backup', target: outside }, { kind: 'evidence', target: database },
    { kind: 'evidence', target: ctx.dataDir }, { kind: 'branch', target: 'main', jobId: 'abcdef12' },
    { kind: 'session', target: join(ctx.agents[0].home, 'auth.json') },
  ]), ctx);
  assert.ok(result.results.every(r => r.status === 'error'));
  assert.ok(existsSync(outside)); assert.ok(existsSync(database));
});

test('junctions and symlinks introduced after planning are rejected without deleting their targets', async t => {
  const ctx = fixture(t), outside = file(join(ctx.temp, 'outside', 'keep.txt'));
  const target = join(ctx.dataDir, 'evidence', 'abcdef12'); mkdirSync(target, { recursive: true });
  const plan = manual([{ kind: 'evidence', target, jobId: 'abcdef12' }]);
  rmSync(target, { recursive: true }); symlinkSync(join(ctx.temp, 'outside'), target, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await apply(plan, ctx);
  assert.equal(result.results[0].status, 'error'); assert.match(result.results[0].detail, /Symlink|junction/);
  assert.ok(existsSync(outside));
  const parent = join(ctx.dataDir, 'evidence', 'parent'); mkdirSync(parent);
  symlinkSync(join(ctx.temp, 'outside'), join(parent, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const nested = await apply(manual([{ kind: 'evidence', target: parent }]), ctx);
  assert.equal(nested.results[0].status, 'error'); assert.ok(existsSync(outside));
});

test('backups respect count and byte caps while always keeping the newest', async t => {
  const ctx = fixture(t), dir = join(ctx.dataDir, 'backups');
  for (let i = 1; i <= 5; i++) file(join(dir, `team-${i}.sqlite`), 600 * 1024, i);
  file(join(dir, 'other.sqlite'));
  ctx.config = { maxBackups: 2, maxBackupMB: 1 };
  const plan = await planPeriodic(ctx); plan.dryRun = false;
  assert.equal(plan.items.filter(i => i.kind === 'backup').length, 4);
  await apply(plan, ctx);
  assert.deepEqual(readdirSync(dir), ['other.sqlite', 'team-1.sqlite']);
  ctx.config = { maxBackups: 1, maxBackupMB: 10 };
  file(join(dir, 'team-2.sqlite'), 12 * 1024 * 1024);
  const oversized = await planPeriodic(ctx); oversized.dryRun = false;
  await apply(oversized, ctx);
  assert.deepEqual(readdirSync(dir), ['other.sqlite', 'team-2.sqlite']);
});

test('backup byte limits retain a prefix of the newest files, including with small older files', async t => {
  const ctx = fixture(t), dir = join(ctx.dataDir, 'backups');
  file(join(dir, 'team-1.sqlite'), 600 * 1024, 1);
  file(join(dir, 'team-2.sqlite'), 600 * 1024, 2);
  file(join(dir, 'team-3.sqlite'), 8, 3);
  ctx.config = { maxBackups: 3, maxBackupMB: 1 };
  const plan = await planPeriodic(ctx); plan.dryRun = false;
  await apply(plan, ctx);
  assert.deepEqual(readdirSync(dir), ['team-1.sqlite']);
});

test('evidence retention keeps active, recently updated and recent folders, and removes Chrome profiles', async t => {
  const ctx = fixture(t), dir = join(ctx.dataDir, 'evidence');
  ctx.jobs = [{ id: 'ended', status: 'cancelled', updatedAt: new Date(now - 40 * day).toISOString() }, { id: 'running', status: 'running' }, { id: 'updated', status: 'done', updatedAt: new Date(now).toISOString() }];
  for (const id of ['ended', 'missing', 'running', 'updated', 'recent']) { file(join(dir, id, 'report.log')); if (id !== 'recent') oldDir(join(dir, id)); }
  for (const name of ['chrome-profile', 'user-data', 'user-data-dir', 'User Data', 'custom']) file(join(dir, 'running', name, name === 'custom' ? 'Local State' : 'Cookies'));
  const plan = await planPeriodic(ctx); plan.dryRun = false;
  assert.equal(plan.items.filter(i => i.reason === 'Browser profile').length, 5);
  const result = await apply(plan, ctx); assert.ok(result.results.every(r => r.status === 'ok'));
  for (const id of ['ended', 'missing']) assert.equal(existsSync(join(dir, id)), false);
  for (const id of ['running', 'updated', 'recent']) assert.ok(existsSync(join(dir, id, 'report.log')));
  for (const name of ['chrome-profile', 'user-data', 'user-data-dir', 'User Data', 'custom']) assert.equal(existsSync(join(dir, 'running', name)), false);
});

test('old CLI sessions are removed while active UUIDs, recent sessions and credentials are kept', async t => {
  const ctx = fixture(t), home = ctx.agents[0].home;
  ctx.jobs = [{ id: 'active', status: 'paused', tasks: [{ cliSession: { id: 'keep-uuid' } }] }];
  const kept = file(join(home, 'sessions', '2026', '01', '01', 'rollout-keep-uuid.jsonl'), 8, 40);
  const old = file(join(home, 'projects', 'project', 'old-uuid.jsonl'), 8, 40);
  const recent = file(join(home, 'sessions', 'new.jsonl'));
  const auth = file(join(home, 'auth.json'), 8, 40), config = file(join(home, 'projects', 'config.json'), 8, 40);
  const plan = await planPeriodic(ctx); plan.dryRun = false;
  assert.deepEqual(plan.items.map(i => i.target), [old]);
  await apply(plan, ctx);
  assert.equal(existsSync(old), false);
  for (const path of [kept, recent, auth, config]) assert.ok(existsSync(path));
  const late = file(join(home, 'sessions', 'late-uuid.jsonl'), 8, 40);
  const second = await planPeriodic(ctx); second.dryRun = false;
  ctx.jobs[0].tasks.push({ cliSession: { id: 'late-uuid' } });
  assert.equal((await apply(second, ctx)).results[0].status, 'skipped'); assert.ok(existsSync(late));
});

test('apply preserves evidence refreshed after planning and jobs that have resumed', async t => {
  const ctx = fixture(t), dir = join(ctx.dataDir, 'evidence');
  ctx.config = { retentionDays: 10 };
  ctx.jobs = [{ id: 'resumed', status: 'done', tasks: [] }];
  for (const name of ['refreshed', 'resumed']) { file(join(dir, name, 'report.log')); oldDir(join(dir, name), 20); }
  const plan = await planPeriodic(ctx); plan.dryRun = false;
  ctx.jobs[0].status = 'running';
  oldDir(join(dir, 'refreshed'), 0);
  const result = await apply(plan, ctx);
  assert.ok(result.results.every(r => r.status === 'skipped'));
  for (const name of ['refreshed', 'resumed']) assert.ok(existsSync(join(dir, name, 'report.log')));
});

test('events paginate beyond 2000 rows and verify the archive before deleting only archived ACTIVITY', async t => {
  const ctx = fixture(t), job = { id: 'abcdef12', status: 'cancelled' }; ctx.jobs = [job];
  let rows = Array.from({ length: 2505 }, (_, i) => ({ seq: i + 1, body: JSON.stringify({ job: job.id, type: i % 3 ? 'ACTIVITY' : 'USAGE', from: i % 2 ? 'one' : 'two', details: { index: i } }) }));
  let deletes = 0, inserts = 0, archiveRows;
  ctx.events = {
    page: (id, after, limit) => { assert.equal(id, job.id); return rows.filter(r => r.seq > after).slice(0, Math.min(limit, 700)); },
    transaction: fn => {
      const archive = readdirSync(join(ctx.dataDir, 'evidence', job.id)).find(n => n.endsWith('.json.gz'));
      archiveRows = JSON.parse(gunzipSync(readFileSync(join(ctx.dataDir, 'evidence', job.id, archive))));
      assert.equal(archiveRows.length, 2505);
      rows.push({ seq: 2506, body: JSON.stringify({ job: job.id, type: 'ACTIVITY', from: 'late' }) });
      fn({
        deleteActivity: (id, seqs) => { deletes++; assert.equal(id, job.id); assert.equal(seqs.length, 1670); rows = rows.filter(r => !seqs.includes(r.seq)); },
        insert: (id, event) => { inserts++; assert.equal(event.type, 'ACTIVITY_SUMMARY'); assert.equal(event.details.count, 1670); assert.equal(Object.values(event.details.byAgent).reduce((a, b) => a + b), 1670); assert.ok(existsSync(join(ctx.dataDir, event.details.archive))); rows.push({ seq: 2507, body: JSON.stringify(event) }); },
      });
    },
  };
  const plan = await planJob({ ...ctx, job }); plan.dryRun = false;
  const result = await apply(plan, ctx);
  assert.equal(result.results[0].status, 'ok'); assert.equal(deletes, 1); assert.equal(inserts, 1);
  assert.equal(rows.filter(r => JSON.parse(r.body).type === 'USAGE').length, 835);
  assert.ok(rows.some(r => r.seq === 2506)); assert.equal(archiveRows[2504].details.index, 2504);
  assert.equal((await planJob({ ...ctx, job })).items.length, 1);
});

test('failed archive creation never starts a DB transaction', async t => {
  const ctx = fixture(t), job = { id: 'abcdef12', status: 'done', kind: 'research' }; ctx.jobs = [job];
  let transactions = 0;
  ctx.events = { page: (_, after) => after ? [] : [{ seq: 1, type: 'ACTIVITY' }], transaction: () => { transactions++; } };
  const plan = await planJob({ ...ctx, job }); plan.dryRun = false;
  file(join(ctx.dataDir, 'evidence'));
  const result = await apply(plan, ctx);
  assert.equal(result.results[0].status, 'error'); assert.equal(transactions, 0);
});

test('transaction failure leaves the full archive and rolls back ACTIVITY deletion', async t => {
  const ctx = fixture(t), job = { id: 'abcdef12', status: 'merged' }; ctx.jobs = [job];
  let rows = [{ seq: 1, type: 'ACTIVITY', from: 'test' }];
  ctx.events = {
    page: (_, after) => rows.filter(r => r.seq > after),
    transaction: fn => {
      const before = [...rows];
      try { fn({ deleteActivity: () => { rows = []; }, insert: () => { throw new Error('Insert failed'); } }); }
      catch (e) { rows = before; throw e; }
    },
  };
  const plan = await planJob({ ...ctx, job }); plan.dryRun = false;
  const result = await apply(plan, ctx);
  assert.equal(result.results[0].status, 'error'); assert.equal(rows.length, 1);
  const archive = readdirSync(join(ctx.dataDir, 'evidence', job.id))[0];
  assert.equal(JSON.parse(gunzipSync(readFileSync(join(ctx.dataDir, 'evidence', job.id, archive)))).length, 1);
});

test('periodic dry-run keeps old evidence and CLI sessions', async t => {
  const ctx = fixture(t), evidence = join(ctx.dataDir, 'evidence', 'missing');
  file(join(evidence, 'report.log')); oldDir(evidence);
  const session = file(join(ctx.agents[0].home, 'sessions', 'old.jsonl'), 8, 40);
  const plan = await planPeriodic(ctx);
  assert.equal(plan.items.length, 2);
  const result = await apply(plan, ctx);
  assert.ok(result.results.every(r => r.status === 'skipped'));
  assert.ok(existsSync(session)); assert.ok(existsSync(evidence));
});

test('periodic cleanup removes finished orphan worktrees and keeps active or unknown jobs', async t => {
  const ctx = await repository(t), job = ctx.jobs[0];
  ctx.projects = [{ id: 'p', path: ctx.root }];
  const orphan = join(ctx.dataDir, 'worktrees', '12345678-review-abcd1234');
  const finished = join(ctx.dataDir, 'worktrees', '87654321-review-abcd1234');
  await git(ctx, ['worktree', 'add', '--detach', orphan, 'main']);
  await git(ctx, ['worktree', 'add', '--detach', finished, 'main']);
  ctx.jobs.push({ id: '87654321', project: 'p', status: 'cancelled', baseBranch: 'main' });
  await git(ctx, ['branch', 'ai-team/12345678']);
  await git(ctx, ['branch', `ai-team/${job.id}`]);
  ctx.isActive = id => id === job.id;
  const plan = await planPeriodic(ctx); plan.dryRun = false;
  assert.ok(plan.items.some(i => i.target === orphan));
  assert.equal(plan.items.some(i => i.jobId === job.id), false);
  await apply(plan, ctx);
  assert.ok(existsSync(orphan)); assert.equal(existsSync(finished), false);
  assert.equal(plan.items.find(i => i.target === orphan).reason, 'Unknown job status – kept');
  assert.ok((await git(ctx, ['branch', '--list', 'ai-team/12345678'])).includes('12345678'));
});

test('collect excludes profiles by name and Local State, including directly selected files', t => {
  const ctx = fixture(t), worktree = join(ctx.temp, 'work'); mkdirSync(worktree);
  file(join(worktree, 'reports', 'good.log'));
  for (const name of ['chrome-profile', 'user-data', 'user-data-dir', 'User Data', 'custom']) {
    file(join(worktree, 'reports', name, 'Cookies'));
    if (name === 'custom') file(join(worktree, 'reports', name, 'Local State'));
  }
  const result = collect({ worktree, paths: ['reports', 'reports/custom/Cookies'], dest: join(ctx.dataDir, 'archive'), maxBytes: 1024 });
  assert.deepEqual(result.files.map(f => f.path), ['reports/good.log']);
  assert.equal(result.skipped.filter(s => s.reason === 'Browser profile').length, 6);
});

test('storageStats counts regular files and ignores symlink targets', t => {
  const ctx = fixture(t); file(join(ctx.dataDir, 'one.txt'), 10); file(join(ctx.dataDir, 'sub', 'two.txt'), 20);
  const outside = join(ctx.temp, 'outside'); file(join(outside, 'large'), 500);
  symlinkSync(outside, join(ctx.dataDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const stats = storageStats(ctx.dataDir);
  assert.equal(stats.dataDirBytes, 30); assert.ok(stats.freeBytes > 0);
});

async function controller(t, options = {}) {
  const ctx = await repository(t);
  ctx.config = { demo: true, backup: false, planApproval: false, agents: [{ id: 'builder', provider: 'mock' }],
    pipeline: { manager: 'builder', builders: ['builder'], reviewer: 'builder', verifier: 'builder' },
    projects: [{ id: 'p', path: ctx.root, tests: [] }], ...options };
  ctx.team = new Team(ctx.config, ctx.dataDir, { runAgent: async () => ({ status: 'completed', summary: 'Mock report', verdict: 'approved', findings: [] }) });
  ctx.team.closed = true;
  return ctx;
}
async function changedJob(ctx) {
  const job = await ctx.team.create({ project: 'p', goal: 'Change hello', paused: true });
  writeFileSync(join(job.worktree, 'hello.txt'), 'Updated\n');
  await run(['git'], ['-C', job.worktree, 'add', '.']);
  await run(['git'], ['-C', job.worktree, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'change']);
  job.revision = (await run(['git'], ['-C', job.worktree, 'rev-parse', 'HEAD'])).stdout.trim();
  Object.assign(job, { status: 'ready', kind: 'code', risk: 'low', tested: job.revision, reviewed: job.revision, verified: job.revision });
  ctx.team.save(job);
  ctx.team.event(job.id, 'builder', 'team', 'ACTIVITY', 'First activity', { action: 'update' });
  ctx.team.event(job.id, 'builder', 'team', 'ACTIVITY', 'Second activity');
  return job;
}
function manifests(ctx, jobId) {
  const dir = join(ctx.dataDir, 'cleanup');
  return existsSync(dir) ? readdirSync(dir).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))).filter(m => m.items.some(i => i.jobId === jobId)) : [];
}

test('controller merge creates exactly one manifest, removes merged trees/branches and archives all events', async t => {
  const ctx = await controller(t), job = await changedJob(ctx), { team } = ctx;
  const child = join(ctx.dataDir, 'worktrees', `${job.id}-t1`);
  await git(ctx, ['worktree', 'add', '-b', `${job.branch}-t1`, child, job.revision]);
  const stop = team.stopPreview.bind(team), stopped = [];
  team.stopPreview = async (id, reason) => { stopped.push(reason); assert.ok(existsSync(job.worktree)); return stop(id, reason); };
  const result = await team.merge(job.id);
  assert.equal(result.status, 'merged'); assert.ok(result.cleanedAt);
  assert.equal(existsSync(job.worktree), false); assert.equal(existsSync(child), false);
  assert.equal(await git(ctx, ['branch', '--list', `${job.branch}*`]), '');
  assert.ok(stopped.includes('merged'));
  const events = team.events(job.id), summaries = events.filter(e => e.type === 'ACTIVITY_SUMMARY');
  assert.equal(events.filter(e => e.type === 'ACTIVITY').length, 0); assert.equal(summaries.length, 1);
  const archive = JSON.parse(gunzipSync(readFileSync(join(ctx.dataDir, summaries[0].details.archive))));
  assert.equal(archive.filter(e => e.type === 'ACTIVITY').length, 2); assert.ok(archive.some(e => e.type === 'MERGED'));
  assert.equal(manifests(ctx, job.id).length, 1);
  await team.cleanupJob(job.id); await team.cleanupJob(job.id);
  assert.equal(manifests(ctx, job.id).length, 1);
});

test('controller cancel drains the run, keeps unmerged branch and writes cleanedAt for cancelled snapshots', async t => {
  const ctx = await controller(t), job = await changedJob(ctx), { team } = ctx;
  const abort = new AbortController();
  abort.signal.addEventListener('abort', () => setTimeout(() => team.runs.delete(job.id), 30), { once: true });
  team.runs.set(job.id, { abort, agents: new Set() });
  const result = await team.control(job.id, 'cancel');
  assert.equal(result.status, 'cancelled'); assert.ok(result.cleanedAt); assert.equal(team.runs.has(job.id), false);
  assert.equal(existsSync(job.worktree), false); assert.equal(await git(ctx, ['branch', '--list', job.branch]), job.branch);
  assert.equal(team.events(job.id).filter(e => e.type === 'ACTIVITY_SUMMARY').length, 1);
  await team.control(job.id, 'cancel'); assert.equal(manifests(ctx, job.id).length, 1);
});

test('cleanupOnMerge=false retains ACTIVITY and the legacy releaseGit behavior', async t => {
  const ctx = await controller(t, { cleanupOnMerge: false }), job = await changedJob(ctx);
  await ctx.team.merge(job.id);
  assert.equal(existsSync(job.worktree), false);
  assert.equal(await git(ctx, ['branch', '--list', job.branch]), '');
  assert.equal(ctx.team.events(job.id).filter(e => e.type === 'ACTIVITY').length, 2);
  assert.equal(ctx.team.events(job.id).filter(e => e.type === 'ACTIVITY_SUMMARY').length, 0);
  assert.equal(manifests(ctx, job.id).length, 0);
  await ctx.team.cleanup();
  assert.equal(ctx.team.events(job.id).filter(e => e.type === 'ACTIVITY').length, 2);
});

test('research done cleans once and retains cleanedAt through the runJob final save', async t => {
  const ctx = await controller(t), job = await changedJob(ctx), { team } = ctx;
  Object.assign(job, { kind: 'research', stage: 'final', fast: true, reports: [{ stage: 'research', agent: 'builder', summary: 'Research conclusion' }] });
  team.save(job); await team.runJob(job);
  const result = team.get(job.id);
  assert.equal(result.status, 'done'); assert.ok(result.cleanedAt);
  assert.equal(existsSync(job.worktree), false); assert.equal(await git(ctx, ['branch', '--list', job.branch]), job.branch);
  assert.equal(manifests(ctx, job.id).length, 1);
  assert.ok(team.events(job.id).some(e => e.type === 'CONCLUSION'));
});

test('cleanupJob serializes duplicate requests and saves cleanedAt from the newest snapshot', async t => {
  const ctx = await controller(t), job = await changedJob(ctx), { team } = ctx;
  job.status = 'done'; team.save(job);
  const context = team.cleanupContext.bind(team); let updated = false;
  team.cleanupContext = (...args) => {
    const value = context(...args), page = value.events.page;
    value.events.page = (...params) => {
      if (!updated) { const fresh = team.get(job.id); fresh.messages.push({ text: 'Concurrent update' }); fresh.ownerNote = 'Keep this'; team.save(fresh); updated = true; }
      return page(...params);
    };
    return value;
  };
  await Promise.all([team.cleanupJob(job.id), team.cleanupJob(job.id)]);
  const result = team.get(job.id);
  assert.ok(result.cleanedAt); assert.equal(result.ownerNote, 'Keep this'); assert.equal(result.messages.at(-1).text, 'Concurrent update');
  assert.equal(manifests(ctx, job.id).length, 1);
});

test('startup with cleanupOnMerge=false preserves unmerged research branches and retries failed compaction', async t => {
  const ctx = await controller(t, { cleanupOnMerge: false }), job = await changedJob(ctx), { team } = ctx;
  job.status = 'done'; team.save(job);
  const context = team.cleanupContext.bind(team), faults = [];
  team.on('fault', e => faults.push(e.message));
  team.cleanupContext = (...args) => { const value = context(...args); value.events.transaction = () => { throw new Error('Mock transaction failure'); }; return value; };
  team.start(); await team.cleanupStartup;
  assert.ok(faults.some(f => f.includes('Mock transaction failure')));
  assert.equal(team.get(job.id).cleanedAt, undefined);
  assert.equal(await git(ctx, ['branch', '--list', job.branch]), job.branch);
  assert.equal(team.events(job.id).filter(e => e.type === 'ACTIVITY').length, 2);
  team.cleanupContext = context; await team.cleanupJob(job.id);
  assert.ok(team.get(job.id).cleanedAt);
  assert.equal(team.events(job.id).filter(e => e.type === 'ACTIVITY_SUMMARY').length, 1);
  assert.equal(await git(ctx, ['branch', '--list', job.branch]), job.branch);
});

test('startup cleans previously released jobs and periodic cleanup excludes runs, previews and unfinished jobs', async t => {
  const ctx = await controller(t), job = await changedJob(ctx), { team } = ctx;
  job.status = 'done'; job.released = true; team.save(job);
  const running = await team.create({ project: 'p', goal: 'Still running', paused: true });
  running.status = 'done'; team.save(running);
  const preview = await team.create({ project: 'p', goal: 'Still previewing', paused: true });
  preview.status = 'done'; team.save(preview);
  const paused = await team.create({ project: 'p', goal: 'Unfinished', paused: true });
  team.runs.set(running.id, { abort: new AbortController(), agents: new Set() }); team.previews.set(preview.id, {});
  t.after(() => { team.runs.clear(); team.previews.clear(); });
  team.start(); await team.cleanupStartup;
  assert.ok(team.get(job.id).cleanedAt); assert.equal(existsSync(job.worktree), false);
  assert.equal(team.cleanupTimer._idleTimeout, 24 * 3600_000);
  for (const kept of [running, preview, paused]) { assert.ok(existsSync(kept.worktree)); assert.equal(team.get(kept.id).cleanedAt, undefined); }
  team.runs.clear(); team.previews.clear();
  await team.close(); assert.equal(team.cleanupTimer._destroyed, true);
});

test('controller dry-run is read-only, rejects obsolete/expired ids and rechecks resumed jobs', async t => {
  const ctx = await controller(t), job = await changedJob(ctx), { team } = ctx;
  job.status = 'done'; team.save(job);
  const first = await team.cleanup({ dryRun: true }), second = await team.cleanup({ dryRun: true });
  assert.equal(manifests(ctx, job.id).length, 0); assert.ok(existsSync(job.worktree));
  assert.equal(team.events(job.id).filter(e => e.type === 'ACTIVITY').length, 2);
  await assert.rejects(team.cleanup({ id: first.id }), { code: 409 });
  team.cleanupPreview.at = new Date(Date.now() - 11 * 60_000).toISOString();
  await assert.rejects(team.cleanup({ id: second.id }), { code: 409 });
  const current = await team.cleanup({ dryRun: true });
  job.status = 'paused'; team.save(job);
  const result = await team.cleanup({ id: current.id });
  assert.ok(result.results.filter(r => r.jobId === job.id).every(r => r.status === 'skipped'));
  assert.ok(existsSync(job.worktree)); assert.equal(team.get(job.id).cleanedAt, undefined);
  await assert.rejects(team.cleanup({ id: current.id }), { code: 409 });
});

test('backup uses shared manifests for count and size limits and keeps the newest backup', async t => {
  const ctx = await controller(t, { maxBackups: 2, maxBackupMB: 0 }), { team } = ctx;
  const old = file(join(ctx.dataDir, 'backups', 'team-old.sqlite'), 8, 2);
  const newest = team.backup('manual'); assert.ok(existsSync(newest)); await team.cleanupPending;
  assert.equal(existsSync(old), false); assert.ok(existsSync(newest));
  assert.ok(readdirSync(join(ctx.dataDir, 'cleanup')).map(f => JSON.parse(readFileSync(join(ctx.dataDir, 'cleanup', f), 'utf8'))).some(m => m.items.some(i => i.kind === 'backup' && i.target === old)));
  team.config.maxBackupMB = 2048; team.config.maxBackups = 1;
  const older = file(join(ctx.dataDir, 'backups', 'team-another.sqlite'), 8, 1);
  await team.cleanup({ backupsOnly: true }); assert.equal(existsSync(older), false); assert.ok(existsSync(newest));
});

test('storage caches directory stats for ten minutes and exposes the agreed warning fields', async t => {
  const ctx = await controller(t), { team } = ctx;
  const first = team.state().storage; file(join(ctx.dataDir, 'larger.log'), 5000);
  assert.equal(team.state().storage.dataDirBytes, first.dataDirBytes);
  team.storageCache.at -= 10 * 60_000;
  assert.ok(team.state().storage.dataDirBytes > first.dataDirBytes);
  team.storageCache = { at: Date.now(), dataDirBytes: 2 ** 30 + 1, freeBytes: 10e9 - 1 };
  assert.deepEqual(team.state().storage.warn, { dataDir: true, disk: true });
  team.storageCache = { at: Date.now(), dataDirBytes: 2 ** 30, freeBytes: 10e9 };
  assert.deepEqual(team.state().storage.warn, { dataDir: false, disk: false });
  await team.cleanup(); assert.ok(team.state().storage.lastCleanup.id);
});

test('validateConfig sets cleanup defaults and rejects invalid values/types', () => {
  const config = () => ({ demo: true, agents: [{ id: 'test', provider: 'mock' }], projects: [] });
  const defaults = validateConfig(config());
  assert.equal(defaults.retentionDays, 30); assert.equal(defaults.maxBackups, 14); assert.equal(defaults.maxBackupMB, 2048); assert.equal(defaults.cleanupOnMerge, true);
  assert.equal(validateConfig({ ...config(), backupKeep: 3 }).maxBackups, 3);
  assert.equal(validateConfig({ ...config(), retentionDays: 0.5, maxBackups: 1, maxBackupMB: 0, cleanupOnMerge: false }).cleanupOnMerge, false);
  for (const [key, values] of Object.entries({ retentionDays: [0, -1, '30', null, NaN, Infinity], maxBackups: [0, -1, 1.5, '3', null, Infinity], maxBackupMB: [-1, '1', null, NaN, Infinity], cleanupOnMerge: [0, 1, 'true', null] })) {
    for (const value of values) assert.throws(() => validateConfig({ ...config(), [key]: value }), new RegExp(key));
  }
});

test('GET/POST cleanup API requires CSRF and a matching latest dry-run manifest', { timeout: 30_000 }, async t => {
  const ctx = await controller(t), { team } = ctx;
  const finished = await changedJob(ctx); await team.control(finished.id, 'cancel');
  await team.close();
  const old = file(join(ctx.dataDir, 'backups', 'team-api-old.sqlite'), 8, 2);
  const newest = file(join(ctx.dataDir, 'backups', 'team-api-new.sqlite'), 8);
  const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r)); assert.notEqual(port, 3333);
  const configFile = join(ctx.temp, 'server-config.json');
  writeFileSync(configFile, JSON.stringify({ ...ctx.config, dataDir: ctx.dataDir, port, maxBackups: 1 }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url)), '--config', configFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const timeout = setTimeout(() => child.kill(), 25_000);
  ctx.stopServer = async () => {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; }
  };
  const origin = `http://127.0.0.1:${port}`;
  let response;
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    assert.equal(child.exitCode, null, output);
    try { response = await fetch(origin); if (response.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(response?.ok, output);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const post = id => fetch(`${origin}/api/cleanup`, { method: 'POST', headers: { cookie, 'x-team-request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(id === undefined ? {} : { id }) });
  assert.equal((await post()).status, 409);
  const forbidden = await fetch(`${origin}/api/cleanup`, { method: 'POST', headers: { cookie }, body: '{}' }); assert.equal(forbidden.status, 403);
  // Startup may already enforce the limit; recreate a backup after it finishes.
  for (const deadline = Date.now() + 5000; existsSync(old) && Date.now() < deadline;) await new Promise(r => setTimeout(r, 30));
  assert.equal(existsSync(old), false); file(old, 8, 2);
  const first = await (await fetch(`${origin}/api/cleanup`, { headers: { cookie } })).json();
  assert.equal(first.dryRun, true); assert.ok(first.items.some(i => i.target === old)); assert.ok(existsSync(old));
  const latest = await (await fetch(`${origin}/api/cleanup`, { headers: { cookie } })).json();
  assert.equal((await post(first.id)).status, 409);
  const applied = await post(latest.id); assert.equal(applied.status, 200);
  const result = await applied.json(); assert.equal(result.id, latest.id); assert.ok(result.results.some(r => r.target === old && r.status === 'ok'));
  assert.equal(existsSync(old), false); assert.ok(existsSync(newest)); assert.equal((await post(latest.id)).status, 409);
});
