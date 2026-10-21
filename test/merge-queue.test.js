import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { run } from '../src/process.js';

const git = async (root, args) => (await run(['git'], ['-C', root, ...args], { timeoutMs: 60_000 })).stdout.trim();
async function commit(root, file, content) {
  writeFileSync(join(root, file), content, 'utf8');
  await git(root, ['add', file]);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', file]);
  return git(root, ['rev-parse', 'HEAD']);
}
async function fixture(t, { preview } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'merge-queue-')), root = join(temp, 'repo'), faults = [], releases = [], calls = [];
  let team;
  t.after(async () => {
    try { for (const release of releases) await release(); await team?.close(); }
    finally { rmSync(temp, { recursive: true, force: true }); }
  });
  await run(['git'], ['init', '-b', 'master', root]);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await commit(root, 'hello.js', 'module.exports = 1;\n');
  team = new Team({ demo: true, backup: false, planApproval: false,
    agents: ['lead', 'builder', 'reviewer', 'verifier'].map(id => ({ id, provider: 'mock' })),
    pipeline: { manager: 'lead', builders: ['builder'], reviewer: 'reviewer', verifier: 'verifier' },
    projects: [{ id: 'p', path: root, tests: [['node', '--check', 'hello.js']], ...(preview ? { preview: { command: 'node preview.cjs {port}', ...preview } } : {}) }] }, join(temp, 'data'), {
    runAgent: async (agent, context) => { calls.push(context.stage); return { status: 'completed', verdict: 'approved', summary: 'Mock', findings: [] }; },
  });
  team.kick = () => {};
  team.runPreview = async () => {};
  team.capacity = () => ({ start: 3 });
  team.on('fault', error => faults.push(error.message));
  const ready = async (file, content = 'change\n', extra = {}) => {
    const job = await team.create({ project: 'p', title: file, goal: 'Change a file', paused: true });
    job.revision = await commit(job.worktree, file, content);
    Object.assign(job, { kind: 'code', status: 'ready', stage: 'verify', risk: 'low', rigor: 'light',
      tested: job.revision, reviewed: job.revision, verified: job.revision, ...extra });
    team.save(job);
    if (preview) { job.acceptance = { revision: job.revision }; team.save(job); }
    return job;
  };
  const queue = async (first, second, options = {}) => {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const original = team.assertReady.bind(team);
    team.assertReady = async job => { await original(job); if (job.id === first.id) { enter(); await gate; } };
    const merging = team.merge(first.id, options.first);
    const finish = async () => { release(); return merging; };
    releases.push(async () => { release(); await merging.catch(() => {}); });
    await entered;
    const queued = await team.merge(second.id, options.second);
    return { queued, finish };
  };
  const drain = async (id, status = 'merged') => {
    for (let i = 0; i < 12 && team.get(id).status !== status; i++) await team.tick();
    assert.equal(team.get(id).status, status, JSON.stringify({ job: team.get(id), faults }));
  };
  return { team, root, ready, queue, drain, faults, calls };
}

test('base queue serializes merges, syncs and retests the new revision automatically', async t => {
  const { team, root, ready, queue, drain, faults } = await fixture(t);
  const first = await ready('one.txt'), second = await ready('two.txt'), before = second.revision;
  const { queued, finish } = await queue(first, second);
  assert.equal(queued.status, 'ready'); assert.equal(team.runs.has(second.id), false);
  const state = team.state().jobs.find(j => j.id === second.id);
  assert.equal(state.mergeQueue.position, 1); assert.equal(state.mergeQueue.branch, 'master');
  assert.equal(state.mergeQueue.approved, true); assert.equal(state.mergeQueue.key, 'p|master');
  assert.equal(team.events(second.id).filter(e => e.type === 'MERGE_QUEUED').length, 1);
  await team.tick(); assert.equal(team.get(second.id).revision, before);
  await finish();
  const synced = team.get(second.id);
  assert.equal(synced.status, 'queued'); assert.equal(synced.stage, 'test');
  assert.equal(synced.base, first.revision); assert.notEqual(synced.revision, before);
  assert.equal(synced.tested, null); assert.equal(synced.reviewed, null); assert.equal(synced.verified, null);
  assert.equal(synced.mergeQueue.wait, 'sync');
  await team.tick();
  assert.equal(team.get(second.id).tested, synced.revision);
  assert(team.get(second.id).checkResults.some(r => r.revision === synced.revision && r.code === 0));
  await drain(second.id);
  assert.equal(await git(root, ['show', 'master:one.txt']), 'change');
  assert.equal(await git(root, ['show', 'master:two.txt']), 'change');
  assert.equal(team.get(second.id).mergeQueue, undefined);
  assert(team.events(second.id).some(e => e.type === 'MERGE_QUEUE_NEXT'));
  assert.deepEqual(faults, []);
});

test('F1: existing release queue tests a merge commit on the new release tip before approval', async t => {
  const { team, root, ready, queue, drain, faults } = await fixture(t), target = { type: 'existing', branch: 'release' };
  await git(root, ['branch', 'release']); const master = await git(root, ['rev-parse', 'master']);
  const first = await ready('one.txt'), second = await ready('two.txt');
  await team.mergeCheck(second.id, target);
  const { finish } = await queue(first, second, { first: { target }, second: { target } });
  await finish(); assert.equal(team.get(second.id).base, master);
  await team.tick();
  const pending = team.get(second.id).pendingMerge;
  assert.equal(pending.tip, first.revision); assert.equal(pending.target.branch, 'release'); assert.equal(pending.passed, true);
  assert.equal(await git(root, ['rev-parse', 'release']), first.revision);
  assert(team.get(second.id).checkResults.some(r => r.revision === pending.commit && r.code === 0));
  assert.equal(await git(root, ['rev-parse', `${pending.commit}^1`]), first.revision);
  await drain(second.id);
  assert.equal(team.get(second.id).mergedInto.commit, pending.commit);
  assert.equal(await git(root, ['show', 'release:one.txt']), 'change');
  assert.equal(await git(root, ['show', 'release:two.txt']), 'change');
  assert.equal(await git(root, ['rev-parse', 'master']), master); assert.deepEqual(faults, []);
});

test('F2: synced preview revision waits once for acceptance and accept kicks the queue', async t => {
  const { team, ready, queue, drain, faults } = await fixture(t, { preview: { requireAcceptance: true } });
  const first = await ready('one.txt'), second = await ready('two.txt');
  const { finish } = await queue(first, second); await finish();
  await drain(second.id, 'ready'); await team.tick(); await team.tick();
  const fresh = team.get(second.id);
  assert.equal(fresh.mergeQueue.wait, 'acceptance'); assert.equal(fresh.acceptance, null);
  assert.equal(team.events(second.id).filter(e => e.type === 'MERGE_QUEUE_WAIT_ACCEPTANCE').length, 1);
  let kicks = 0; team.kick = () => { kicks++; };
  await assert.rejects(team.control(second.id, 'accept', { revision: second.revision }));
  await team.control(second.id, 'accept', { revision: fresh.revision }); assert.equal(kicks, 1);
  await drain(second.id); assert.deepEqual(faults, []);
});

for (const kind of ['strict', 'needsConfirm']) test(`${kind}: validates confirmation at enqueue and renews it after sync`, async t => {
  const { team, root, ready, drain, faults } = await fixture(t);
  const first = await ready('one.txt'), second = await ready(kind === 'needsConfirm' ? 'package.json' : 'two.txt', '{}\n', kind === 'strict' ? { rigor: 'strict' } : {});
  let release, enter;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
  const original = team.assertReady.bind(team);
  team.assertReady = async job => { await original(job); if (job.id === first.id) { enter(); await gate; } };
  const merging = team.merge(first.id); await entered;
  try {
    await assert.rejects(team.merge(second.id, { confirm: 'wrong' }));
    assert.equal(team.get(second.id).mergeQueue, undefined);
    await team.merge(second.id, { confirm: second.revision.slice(0, 8) });
    assert.equal(team.get(second.id).mergeQueue.confirmCode, second.revision.slice(0, 8));
  } finally { release(); await merging; }
  assert.notEqual(team.get(second.id).revision.slice(0, 8), second.revision.slice(0, 8));
  await drain(second.id); assert.deepEqual(faults, []);
  assert.equal(await git(root, ['show', `master:${kind === 'needsConfirm' ? 'package.json' : 'two.txt'}`]), '{}');
});

test('sync conflict leaves the queue with conflict evidence and does not run agents', async t => {
  const { team, root, ready, queue, calls, faults } = await fixture(t);
  const first = await ready('hello.js', 'module.exports = 2;\n'), second = await ready('hello.js', 'module.exports = 3;\n');
  const { finish } = await queue(first, second); await finish();
  const fresh = team.get(second.id);
  assert.equal(fresh.status, 'ready'); assert.equal(fresh.mergeQueue, undefined);
  assert.equal(fresh.mergeFailure.kind, 'conflict'); assert.deepEqual(fresh.mergeFailure.files, ['hello.js']);
  assert.equal(await git(second.worktree, ['status', '--porcelain']), '');
  await team.tick(); assert.deepEqual(calls, []); assert.deepEqual(faults, []);
  assert.equal(await git(root, ['show', 'master:hello.js']), 'module.exports = 2;');
});

test('merge-dequeue removes authorization, emits an event and never merges that job', async t => {
  const { team, ready, queue } = await fixture(t), first = await ready('one.txt'), second = await ready('two.txt');
  const { finish } = await queue(first, second);
  await team.control(second.id, 'merge-dequeue'); assert.equal(team.get(second.id).mergeQueue, undefined);
  assert(team.events(second.id).some(e => e.type === 'MERGE_DEQUEUED'));
  await finish(); await team.tick(); assert.equal(team.get(second.id).status, 'ready');
});

for (const action of ['message', 'set-depends', 'cancel', 'pause', 'review']) test(`${action} clears a queued merge`, async t => {
  const { team, ready, queue } = await fixture(t), first = await ready('one.txt'), second = await ready('two.txt');
  const { finish } = await queue(first, second);
  await team.control(second.id, action, { message: 'Change scope', ids: [] });
  assert.equal(team.get(second.id).mergeQueue, undefined); await finish();
});

test('FIFO cannot be bypassed while the queue head is retesting', async t => {
  const { team, root, ready, queue, drain, faults } = await fixture(t);
  const first = await ready('one.txt'), second = await ready('two.txt'), third = await ready('three.txt');
  const { finish } = await queue(first, second);
  await team.merge(third.id);
  assert.equal(team.state().jobs.find(j => j.id === third.id).mergeQueue.position, 2);
  await finish();
  team.capacity = () => ({ start: 0 });
  await team.tick();
  assert.equal(team.get(second.id).status, 'queued'); assert.equal(team.get(third.id).status, 'queued');
  assert.equal(await git(root, ['rev-parse', 'master']), first.revision);
  team.capacity = () => ({ start: 3 });
  await drain(third.id);
  assert.equal(team.get(second.id).status, 'merged'); assert.deepEqual(faults, []);
  assert.equal(await git(root, ['show', 'master:three.txt']), 'change');
});

test('failed queued merge-commit tests remove the queue and keep the target unchanged', async t => {
  const { team, root, ready, queue, faults } = await fixture(t), target = { type: 'existing', branch: 'release' };
  await git(root, ['branch', 'release']);
  const first = await ready('one.txt'), second = await ready('hello.js', 'invalid javascript !\n');
  const { finish } = await queue(first, second, { first: { target }, second: { target } }); await finish();
  team.capacity = () => ({ start: 0 }); await team.tick();
  const fresh = team.get(second.id);
  assert.equal(fresh.mergeQueue, undefined); assert.equal(fresh.mergeFailure.kind, 'tests_failed');
  assert.equal(fresh.status, 'queued'); assert.equal(fresh.stage, 'rework'); assert.equal(fresh.tested, null);
  assert.equal(fresh.pendingMerge.passed, false);
  assert(fresh.checkResults.some(r => r.revision === fresh.pendingMerge.commit && r.code !== 0));
  assert.equal(await git(root, ['rev-parse', 'release']), first.revision);
  assert.equal(faults.length, 1); assert.match(faults[0], /tests failed/);
});

test('dequeue during retesting cannot be overwritten by the running job snapshot', async t => {
  const { team, ready, queue, faults } = await fixture(t), first = await ready('one.txt'), second = await ready('two.txt');
  const { finish } = await queue(first, second); await finish();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const original = team.runTests.bind(team);
  team.runTests = async (...args) => { enter(); await gate; return original(...args); };
  const testing = team.tick(); await entered;
  try { await team.control(second.id, 'merge-dequeue'); }
  finally { release(); await testing; }
  await team.tick();
  assert.equal(team.get(second.id).status, 'ready'); assert.equal(team.get(second.id).mergeQueue, undefined);
  assert.deepEqual(faults, []);
});

test('manual sync withdraws queued approval while automatic sync preserves it', async t => {
  const { team, root, ready, queue, drain, faults } = await fixture(t), first = await ready('one.txt'), second = await ready('two.txt');
  const { finish } = await queue(first, second); await finish(); await drain(second.id, 'ready');
  assert(team.get(second.id).mergeQueue);
  const head = await commit(root, 'owner.txt', 'owner change\n');
  await team.control(second.id, 'sync');
  const fresh = team.get(second.id);
  assert.equal(fresh.base, head); assert.equal(fresh.status, 'queued'); assert.equal(fresh.stage, 'test');
  assert.equal(fresh.mergeQueue, undefined); assert.equal(fresh.tested, null); assert.deepEqual(faults, []);
});

for (const kind of ['dirty-root', 'dirty-worktree', 'target-exists', 'linked-base']) test(`F2: queue error ${kind} is attempted once and requires an owner decision`, async t => {
  const { team, root, ready, queue, drain, faults } = await fixture(t);
  const first = await ready('one.txt'), second = await ready('two.txt');
  const target = { type: 'new', branch: 'release' };
  const { finish } = await queue(first, second, kind === 'target-exists' ? { first: { target }, second: { target } } : {});
  if (kind === 'dirty-worktree') writeFileSync(join(second.worktree, 'dirty.txt'), 'dirty\n', 'utf8');
  if (kind === 'linked-base') {
    const fresh = team.get(second.id);
    fresh.linked = [{ project: 'linked', path: root, baseBranch: 'master', base: first.base }]; team.save(fresh);
  }
  await finish();
  if (kind === 'dirty-root') {
    await drain(second.id, 'ready');
    writeFileSync(join(root, 'dirty.txt'), 'dirty\n', 'utf8');
  }
  await team.tick();
  const failed = team.get(second.id);
  assert.equal(failed.mergeQueue, undefined); assert.equal(failed.status, 'ready');
  assert.equal(failed.mergeFailure.kind, 'queue_error'); assert(failed.error); assert.equal(failed.mergeFailure.error, failed.error);
  assert.equal(team.decisions().find(d => d.jobId === second.id).state, 'merge_stuck');
  const errors = faults.length, attempts = team.events(second.id).filter(e => e.type === 'MERGE_QUEUE_NEXT').length, updated = failed.updatedAt;
  assert.equal(errors, 1);
  for (let i = 0; i < 3; i++) await team.tick();
  assert.equal(faults.length, errors); assert.equal(team.get(second.id).updatedAt, updated);
  assert.equal(team.events(second.id).filter(e => e.type === 'MERGE_QUEUE_NEXT').length, attempts);
});
