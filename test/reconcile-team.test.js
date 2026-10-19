import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { run } from '../src/process.js';

const git = async (root, args) => (await run(['git'], ['-C', root, ...args], { timeoutMs: 60_000 })).stdout.trim();
async function commit(root, file, content) {
  writeFileSync(join(root, file), content, 'utf8');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', file]);
  return git(root, ['rev-parse', 'HEAD']);
}
async function fixture(t, options = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'reconcile-team-')), root = join(temp, 'repo'), dataDir = join(temp, 'data');
  let team;
  t.after(async () => { try { await team?.close(); } finally { rmSync(temp, { recursive: true, force: true }); } });
  await run(['git'], ['init', '-b', 'master', root]);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await commit(root, 'hello.txt', 'initial\n');
  const config = { demo: true, backup: false, planApproval: false, ...options,
    agents: ['lead', 'builder', 'reviewer', 'verifier'].map(id => ({ id, provider: 'mock' })),
    pipeline: { manager: 'lead', builders: ['builder'], reviewer: 'reviewer', verifier: 'verifier' },
    projects: [{ id: 'p', path: root, tests: [] }] };
  team = new Team(config, dataDir, { runAgent: async () => ({ status: 'completed', verdict: 'approved', summary: 'Mock', findings: [] }) });
  team.kick = () => {};
  const faults = []; team.on('fault', error => faults.push(error.message));
  const job = await team.create({ project: 'p', title: 'Reconcile job', goal: 'Change hello', paused: true });
  job.revision = await commit(job.worktree, 'hello.txt', 'changed\n');
  Object.assign(job, { kind: 'code', status: 'ready', stage: 'verify', risk: 'low', tested: job.revision, reviewed: job.revision, verified: job.revision });
  team.save(job);
  return { team, job, root, dataDir, faults };
}

test('reconcile detects a manual master merge without saving the job; throttles and forces refresh', async t => {
  const { team, job, root } = await fixture(t);
  const body = JSON.stringify(team.get(job.id)); let changes = 0;
  team.on('change', () => changes++);
  await team.reconcile();
  assert.equal(team.state().jobs[0].git.state, 'awaiting_owner');
  assert.equal(team.state().decisions.filter(d => d.jobId === job.id).length, 1);
  const checkedAt = team.state().jobs[0].git.checkedAt;
  await team.reconcile({ force: true }); assert.equal(changes, 1);
  await git(root, ['merge', '--ff-only', job.branch]);
  await team.reconcile(); assert.equal(team.state().jobs[0].git.state, 'awaiting_owner');
  await team.reconcile({ force: true });
  assert.equal(team.state().jobs[0].git.state, 'in_master');
  assert(team.state().jobs[0].git.checkedAt >= checkedAt);
  assert.deepEqual(team.state().decisions, []);
  assert.equal(JSON.stringify(team.get(job.id)), body);
  assert.equal(changes, 2);
});

test('ready conflicts appear once with files; new revisions clear mergeFailure', async t => {
  const { team, job } = await fixture(t);
  job.mergeFailure = { kind: 'conflict', files: ['hello.txt'] }; team.save(job);
  await team.reconcile({ force: true });
  assert.deepEqual(team.state().decisions[0], { jobId: job.id, title: job.title, state: 'merge_stuck', reason: 'conflict', kind: 'conflict', files: ['hello.txt'] });
  job.revision = await commit(job.worktree, 'later.txt', 'later'); team.save(job);
  assert.equal(team.get(job.id).mergeFailure, undefined);
});

test('base moved automatically syncs cleanly and invalidates every gate for retest', async t => {
  const { team, job, root } = await fixture(t);
  await commit(root, 'other.txt', 'other');
  await assert.rejects(team.merge(job.id));
  const fresh = team.get(job.id);
  assert.equal(fresh.status, 'queued'); assert.equal(fresh.stage, 'test');
  assert.notEqual(fresh.revision, job.revision);
  assert.equal(fresh.mergeFailure, undefined);
  assert.equal(fresh.tested, null); assert.equal(fresh.reviewed, null); assert.equal(fresh.verified, null);
});

test('automatic sync conflicts wait for owner; manual sync still assigns conflict repair', async t => {
  const { team, job, root } = await fixture(t);
  await commit(root, 'hello.txt', 'conflict\n');
  await assert.rejects(team.merge(job.id));
  let fresh = team.get(job.id);
  assert.equal(fresh.status, 'ready'); assert.equal(fresh.tasks.length, job.tasks.length);
  assert.deepEqual(fresh.mergeFailure.files, ['hello.txt']);
  assert.equal(await git(job.worktree, ['status', '--porcelain']), '');
  await team.control(job.id, 'sync'); fresh = team.get(job.id);
  assert.equal(fresh.stage, 'implement'); assert.equal(fresh.status, 'queued');
  assert.equal(fresh.mergeFailure.kind, 'conflict');
});

test('merge conflicts retain exact files without assigning an AI', async t => {
  const { team, job, root } = await fixture(t), target = { type: 'existing', branch: 'release' };
  await git(root, ['checkout', '-b', 'release']); await commit(root, 'hello.txt', 'conflict\n'); await git(root, ['checkout', 'master']);
  await assert.rejects(team.merge(job.id, { target }), /Merge conflicts/);
  assert.equal(team.get(job.id).status, 'ready'); assert.equal(team.get(job.id).tasks.length, job.tasks.length);
  assert.deepEqual(team.get(job.id).mergeFailure.files, ['hello.txt']);
});

test('failed merge-commit tests return to builder and preserve the target', async t => {
  const { team, job, root } = await fixture(t), target = { type: 'existing', branch: 'release' };
  await git(root, ['checkout', '-b', 'release']); const tip = await commit(root, 'other.txt', 'other'); await git(root, ['checkout', 'master']);
  team.runTests = async current => { current.reports.push({ stage: 'test', summary: 'Test failed: mock' }); return false; };
  await assert.rejects(team.merge(job.id, { target }), /tests failed/);
  const fresh = team.get(job.id);
  assert.equal(fresh.mergeFailure.kind, 'tests_failed'); assert.equal(fresh.stage, 'rework'); assert.equal(fresh.status, 'queued');
  assert.equal(fresh.reports.at(-1).summary, 'Test failed: mock');
  assert.equal(await git(root, ['rev-parse', 'release']), tip);
});

test('delete guards unmerged code then archives before deleting all job refs', async t => {
  const { team, job, root } = await fixture(t);
  await assert.rejects(team.control(job.id, 'delete'), error => error.code === 409 && error.details.branches.some(b => b.name === job.branch));
  assert.equal(team.get(job.id).id, job.id);
  await team.control(job.id, 'delete', { archive: true });
  assert.throws(() => team.get(job.id));
  assert.equal(await git(root, ['rev-parse', `archive/${job.id}`]), job.revision);
  assert.equal(await git(root, ['branch', '--list', `${job.branch}*`]), '');
  assert(!(await git(root, ['worktree', 'list', '--porcelain'])).includes(job.id));
});

test('dirty worktrees block deletion even with archive consent; release keeps them', async t => {
  const { team, job, root } = await fixture(t);
  writeFileSync(join(job.worktree, 'dirty.txt'), 'unsaved', 'utf8');
  await assert.rejects(team.control(job.id, 'delete', { archive: true }), error => error.code === 409 && error.details.worktrees[0].worktree === job.worktree.replaceAll('\\', '/'));
  await team.releaseGit(job);
  assert.equal(readFileSync(join(job.worktree, 'dirty.txt'), 'utf8'), 'unsaved');
  assert.equal(await git(root, ['rev-parse', job.branch]), job.revision);
});

test('deleteSession preserves the session and reports blocked jobs', async t => {
  const { team, job } = await fixture(t);
  await assert.rejects(team.deleteSession(job.sessionId), error => error.code === 409 && error.details.jobs[0].jobId === job.id);
  assert(team.sessions().some(s => s.id === job.sessionId)); assert.equal(team.get(job.id).id, job.id);
});

test('deletion keeps the job if its worktree becomes dirty after the initial inventory', async t => {
  const { team, job } = await fixture(t), release = team.releaseGit.bind(team);
  team.releaseGit = async current => {
    writeFileSync(join(current.worktree, 'late.txt'), 'owner edit', 'utf8');
    return release(current);
  };
  await assert.rejects(team.control(job.id, 'delete', { archive: true }), error => error.code === 409 && error.details.worktrees.length === 1);
  assert.equal(team.get(job.id).id, job.id);
  assert.equal(readFileSync(join(job.worktree, 'late.txt'), 'utf8'), 'owner edit');
});

test('deletion archives a branchless WIP checkpoint before removing its job', async t => {
  const { team, job, root } = await fixture(t);
  const scratch = join(team.dataDir, 'worktrees', `${job.id}-t1`);
  await git(root, ['worktree', 'add', '--detach', scratch, job.base]);
  const wip = await commit(scratch, 'wip.txt', 'recoverable');
  job.tasks = [{ id: 'T1', checkpoint: { wip: { commit: wip } } }]; team.save(job);
  await assert.rejects(team.control(job.id, 'delete'), error => error.code === 409 && error.details.wip[0].commit === wip);
  await team.control(job.id, 'delete', { archive: true });
  assert.equal(await git(root, ['rev-parse', `archive/${job.id}-wip-T1`]), wip);
});

test('linked repositories participate in deletion guards and archive recovery', async t => {
  const { team, job, root } = await fixture(t), linkedRoot = join(root, '..', 'linked');
  await run(['git'], ['init', '-b', 'master', linkedRoot]);
  await git(linkedRoot, ['config', 'core.autocrlf', 'false']);
  const base = await commit(linkedRoot, 'initial.txt', 'linked base');
  const worktree = join(team.dataDir, 'worktrees', `${job.id}@linked`);
  await git(linkedRoot, ['worktree', 'add', '-b', job.branch, worktree]);
  const revision = await commit(worktree, 'changed.txt', 'linked change');
  team.config.projects.push({ ...team.project('p'), id: 'linked', path: linkedRoot });
  job.linked = [{ path: linkedRoot, project: 'linked', branch: job.branch, baseBranch: 'master', worktree, base, revision }]; team.save(job);
  await assert.rejects(team.control(job.id, 'delete'), error => error.code === 409 && error.details.repos[0].root === linkedRoot);
  await team.control(job.id, 'delete', { archive: true });
  assert.equal(await git(linkedRoot, ['rev-parse', `archive/${job.id}`]), revision);
  assert.equal(await git(linkedRoot, ['branch', '--list', `${job.branch}*`]), '');
  assert(!(await git(linkedRoot, ['worktree', 'list', '--porcelain'])).includes(job.id));
});

test('orphans lists refs of missing jobs with inMain and contributes an owner decision', async t => {
  const { team, job, root } = await fixture(t);
  team.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
  let items = await team.orphans();
  assert(items.some(item => item.kind === 'branch' && item.branch === job.branch && !item.inMain && item.lastCommitAt));
  await team.reconcile({ force: true }); assert(team.state().decisions.some(d => d.kind === 'orphans' && d.count === 2));
  await git(root, ['merge', '--ff-only', job.branch]); items = await team.orphans();
  assert(items.every(item => item.inMain));
  await team.reconcile({ force: true }); assert.deepEqual(team.state().decisions, []);
});

test('queued orphan cleanup archives unmerged branches and removes registered worktrees', async t => {
  const { team, job, root } = await fixture(t);
  team.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
  const items = await team.orphans();
  const result = await team.deleteOrphans([...items.filter(i => i.kind === 'worktree'), ...items.filter(i => i.kind === 'branch')]);
  assert(result.results.every(r => r.status === 'ok'), JSON.stringify(result.results));
  assert.equal(await git(root, ['rev-parse', `archive/${job.id}`]), job.revision);
  assert.deepEqual(await team.orphans(), []);
});

test('successful merge removes all registered review worktrees and job branches', async t => {
  const { team, job, root, dataDir } = await fixture(t);
  await git(root, ['worktree', 'add', '--detach', join(dataDir, 'worktrees', `${job.id}-review-12345678`), job.revision]);
  await git(root, ['branch', `${job.branch}-t1`, job.revision]);
  await team.merge(job.id);
  assert.equal(team.get(job.id).status, 'merged');
  assert(!(await git(root, ['worktree', 'list', '--porcelain'])).includes(job.id));
  assert.equal(await git(root, ['branch', '--list', `ai-team/${job.id}*`]), '');
});

test('new locale keys parse and contain no mojibake', () => {
  for (const locale of ['vi', 'en', 'ja']) {
    const values = JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8'));
    for (const key of ['delete_unmerged', 'delete_dirty', 'delete_changed', 'session_delete_blocked']) {
      assert.equal(typeof values[`srv.team.${key}`], 'string');
      assert(!/[Ã\uFFFD]|á»/.test(values[`srv.team.${key}`]));
    }
  }
});
