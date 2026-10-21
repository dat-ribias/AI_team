import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { classify } from '../src/reconcile.js';
import { msg } from '../src/i18n.js';
import { run } from '../src/process.js';

const git = async (root, args) => (await run(['git'], ['-C', root, ...args], { timeoutMs: 60_000 })).stdout.trim();
async function commit(root, file, content) {
  writeFileSync(join(root, file), content, 'utf8');
  await git(root, ['add', file]);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', file]);
  return git(root, ['rev-parse', 'HEAD']);
}
async function fixture(t, options = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'job-depends-')), root = join(temp, 'repo'), calls = [], faults = [];
  let team;
  t.after(async () => { try { await team?.close(); } finally { rmSync(temp, { recursive: true, force: true }); } });
  await run(['git'], ['init', '-b', 'master', root]);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await commit(root, 'hello.txt', 'initial\n');
  team = new Team({ demo: true, backup: false, planApproval: false,
    agents: ['lead', 'builder', 'reviewer', 'verifier'].map(id => ({ id, provider: 'mock' })),
    pipeline: { manager: 'lead', builders: ['builder'], reviewer: 'reviewer', verifier: 'verifier' },
    projects: [{ id: 'p', path: root, tests: [] }] }, join(temp, 'data'), {
    runAgent: async (agent, context, ...args) => {
      calls.push({ agent: agent.id, stage: context.stage, context });
      return options.runAgent ? options.runAgent(agent, context, ...args) : { status: 'completed', verdict: 'approved', summary: 'Mock', findings: [] };
    },
  });
  team.kick = () => {};
  team.capacity = () => ({ start: 3 });
  team.on('fault', error => faults.push(error.message));
  const create = async (extra = {}) => team.create({ project: 'p', goal: 'Update hello', paused: true, ...extra });
  const implement = job => {
    Object.assign(job, { status: 'queued', stage: 'implement', kind: 'code', risk: 'low', rigor: 'light',
      tasks: [{ agent: 'builder', difficulty: 1, instruction: 'Update hello', files: ['hello.txt'], dependsOn: [] }] });
    team.save(job); return job;
  };
  const merged = async (dep, branch = 'master') => {
    dep.revision = await commit(dep.worktree, `${dep.id}.txt`, 'dependency\n');
    await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'merge', '--no-ff', '-m', 'dependency merged', dep.branch]);
    dep.status = 'merged'; dep.mergedInto = { branch, commit: await git(root, ['rev-parse', 'HEAD']) }; team.save(dep);
    return dep.mergedInto.commit;
  };
  return { team, root, calls, faults, create, implement, merged };
}

test('implement waits without calling an agent and emits a wait only when its reason changes', async t => {
  const { team, calls, create, implement, faults } = await fixture(t), dep = await create();
  const job = implement(await create({ dependsOn: [dep.id] }));
  await team.tick(); await team.tick();
  const fresh = team.get(job.id);
  assert.equal(fresh.status, 'waiting'); assert.equal(fresh.stage, 'implement');
  assert.deepEqual(fresh.blockedReason, { kind: 'depends', ids: [dep.id] });
  assert.equal(fresh.dependWait.results[dep.id].reason, 'not_merged');
  assert.equal(team.events(job.id).filter(e => e.type === 'DEPENDS_WAIT').length, 1);
  assert.deepEqual(calls, []); assert.deepEqual(faults, []);
  assert.deepEqual(classify(fresh, { repos: [] }), { state: 'working', reason: 'depends' });
});

test('a merged dependency with no own commits never satisfies the gate', async t => {
  const { team, calls, create, implement } = await fixture(t), dep = await create();
  dep.status = 'merged'; dep.mergedInto = { branch: 'master', commit: dep.base }; team.save(dep);
  const job = implement(await create({ dependsOn: [dep.id] }));
  assert.equal(team.state().jobs.find(j => j.id === job.id).depends[0].met, false);
  await team.tick();
  assert.deepEqual(team.get(job.id).dependWait.results[dep.id], { met: false, reason: 'no_commits' });
  assert.equal(team.get(job.id).status, 'waiting'); assert.deepEqual(calls, []);
});

test('F3: a dependency merged only into release stays unmet before and after tick', async t => {
  const { team, root, calls, create, implement, merged } = await fixture(t), dep = await create();
  const job = implement(await create({ dependsOn: [dep.id] }));
  await git(root, ['checkout', '-b', 'release']); await merged(dep, 'release'); await git(root, ['checkout', 'master']);
  assert.equal(team.state().jobs.find(j => j.id === job.id).depends[0].met, false);
  await team.tick();
  assert.deepEqual(team.get(job.id).dependWait.results[dep.id], { met: false, reason: 'not_in_base' });
  assert.equal(team.state().jobs.find(j => j.id === job.id).depends[0].met, false);
  assert.deepEqual(calls, []);
});

test('a real merged dependency syncs an untouched branch and resumes implement automatically', async t => {
  const { team, calls, faults, create, implement, merged } = await fixture(t), dep = await create();
  const job = implement(await create({ dependsOn: [dep.id] }));
  await team.tick(); const head = await merged(dep);
  await team.tick();
  const fresh = team.get(job.id);
  assert.equal(fresh.base, head); assert.equal(fresh.revision, head); assert.equal(fresh.stage, 'test');
  assert.equal(fresh.baseMovedSincePlan, true); assert.equal(fresh.blockedReason, undefined);
  assert.equal(await git(job.worktree, ['rev-parse', 'HEAD']), head);
  assert.equal(team.events(job.id).filter(e => e.type === 'DEPENDS_MET').length, 1);
  assert.equal(calls.filter(c => c.stage === 'implement').length, 1); assert.deepEqual(faults, []);
  const assignment = team.events(job.id).find(e => e.type === 'TASK_ASSIGNMENT' && e.details.stage === 'implement');
  assert.match(assignment.details.prompt, /relocate code by symbol name before editing/);
  assert.equal(team.state().jobs.find(j => j.id === job.id).depends[0].met, true);
  team.capacity = () => ({ start: 0 }); await team.tick();
  assert.equal(team.events(job.id).filter(e => e.type === 'DEPENDS_MET').length, 1, 'satisfied dependencies do not trigger repeated syncs');
  const stale = team.get(job.id); stale.dependWait.baseTip = job.base; team.save(stale);
  assert.equal(team.state().jobs.find(j => j.id === job.id).depends[0].met, false, 'cached results require the checked base tip');
});

test('dependency sync preserves existing commits and the current stage', async t => {
  const { team, root, create, implement, merged } = await fixture(t), dep = await create();
  const job = implement(await create({ dependsOn: [dep.id] }));
  job.revision = await commit(job.worktree, 'own.txt', 'own work\n'); team.save(job);
  const own = job.revision, head = await merged(dep);
  team.capacity = () => ({ start: 0 }); await team.tick();
  const fresh = team.get(job.id);
  assert.equal(fresh.stage, 'implement'); assert.equal(fresh.status, 'queued'); assert.equal(fresh.base, head);
  assert.equal(await git(root, ['merge-base', own, fresh.revision]), own);
  assert.equal(await git(root, ['merge-base', head, fresh.revision]), head);
});

test('dependency sync aborts conflicts and blocks without dispatching an agent', async t => {
  const { team, calls, create, implement, root } = await fixture(t), dep = await create();
  const job = implement(await create({ dependsOn: [dep.id] }));
  job.revision = await commit(job.worktree, 'hello.txt', 'own\n'); team.save(job);
  dep.revision = await commit(dep.worktree, 'hello.txt', 'dependency\n');
  await git(root, ['merge', '--ff-only', dep.branch]); dep.status = 'merged'; team.save(dep);
  await team.tick();
  const fresh = team.get(job.id);
  assert.equal(fresh.status, 'blocked'); assert.equal(fresh.stage, 'implement');
  assert.deepEqual(fresh.mergeFailure.files, ['hello.txt']); assert.equal(fresh.mergeFailure.kind, 'conflict');
  assert.equal(await git(job.worktree, ['status', '--porcelain']), ''); assert.deepEqual(calls, []);
});

test('validation rejects cycles, self, missing, other projects and malformed dependency lists', async t => {
  const { team, root, create } = await fixture(t), a = await create(), b = await create({ dependsOn: [a.id] });
  const invalid = async (job, ids, key) => assert.rejects(team.control(job.id, 'set-depends', { ids }), { message: msg(`srv.team.depends_${key}`, { 0: Array.isArray(ids) ? ids.join(', ') : String(ids) }) });
  await invalid(a, [b.id], 'cycle'); await invalid(a, [a.id], 'self'); await invalid(a, ['missing'], 'missing');
  const other = await create(); other.project = 'other'; team.save(other);
  await invalid(a, [other.id], 'project'); await invalid(a, 'bad', 'missing'); await invalid(a, Array(11).fill(b.id), 'missing');
  const before = await git(root, ['worktree', 'list', '--porcelain']);
  await assert.rejects(create({ dependsOn: ['missing'] }), { message: msg('srv.team.depends_missing', { 0: 'missing' }) });
  assert.equal(await git(root, ['worktree', 'list', '--porcelain']), before);
  for (const status of ['merged', 'cancelled', 'done', 'merging']) {
    const job = await create(); job.status = status; team.save(job);
    await assert.rejects(team.control(job.id, 'set-depends', { ids: [] }));
  }
  team.runs.set(a.id, { agents: new Set(), abort: new AbortController() });
  try { await assert.rejects(team.control(a.id, 'set-depends', { ids: [] })); } finally { team.runs.delete(a.id); }
});

test('cancelled and deleted dependencies need an owner decision; wait acknowledges and clearing resumes', async t => {
  const { team, create, implement } = await fixture(t), dep = await create(), deleted = await create();
  const job = implement(await create({ dependsOn: [dep.id, deleted.id] }));
  dep.status = 'cancelled'; team.save(dep); team.db.prepare('DELETE FROM jobs WHERE id=?').run(deleted.id);
  await team.tick();
  assert.equal(team.get(job.id).dependWait.results[dep.id].reason, 'cancelled');
  assert.equal(team.get(job.id).dependWait.results[deleted.id].reason, 'deleted');
  assert.deepEqual(team.decisions().find(d => d.jobId === job.id && d.kind === 'depends_broken').deps, [dep.id, deleted.id]);
  await team.control(job.id, 'depends-wait'); await team.tick();
  assert(!team.decisions().some(d => d.jobId === job.id)); assert.equal(team.get(job.id).status, 'waiting');
  const fresh = await team.control(job.id, 'set-depends', { ids: [] });
  assert.equal(fresh.status, 'queued'); assert.equal(fresh.blockedReason, undefined); assert.deepEqual(fresh.dependsOn, []);
  assert(team.events(job.id).some(e => e.type === 'DEPENDS_SET'));
});

test('set-depends resumes a waiting job when its remaining dependencies are already met', async t => {
  const { team, create, implement, merged, calls } = await fixture(t), a = await create(), b = await create();
  const job = implement(await create({ dependsOn: [a.id, b.id] }));
  await team.tick(); const head = await merged(b);
  const fresh = await team.control(job.id, 'set-depends', { ids: [b.id] });
  assert.equal(fresh.status, 'queued'); assert.equal(fresh.base, head); assert.equal(fresh.stage, 'implement');
  assert.equal(fresh.blockedReason, undefined); assert.deepEqual(calls, []);
});

test('planning stays available and records validated related jobs, overlap and owner choices', async t => {
  let relatedId;
  const { team, create, calls } = await fixture(t, { runAgent: async (agent, context) => {
    assert.equal(context.stage, 'plan');
    return { status: 'planned', summary: 'Plan', kind: 'code', risk: 'low', rigor: 'standard',
      tasks: [{ agent: 'builder', difficulty: 2, instruction: 'Update hello', files: ['hello.txt'], dependsOn: [] }],
      relatedJobs: [{ id: relatedId, reason: 'Shared file', mode: 'sequential' }, { id: 'missing', reason: 'Invalid', mode: 'parallel' },
        { id: relatedId, reason: 'Duplicate', mode: 'parallel' }, { id: relatedId, reason: 'x'.repeat(301), mode: 'parallel' }] };
  } });
  const dep = await create(); dep.tasks = [{ files: ['hello.txt', 'other.txt'] }]; team.save(dep); relatedId = dep.id;
  for (const choice of ['sequential', 'parallel', 'none']) {
    const job = await create({ planApproval: true }); job.status = 'queued'; team.save(job);
    await team.tick(); await team.tick();
    const fresh = team.get(job.id), p = fresh.plans.at(-1);
    assert.equal(fresh.status, 'waiting'); assert(fresh.planGate);
    assert.deepEqual(fresh.relatedJobs, [{ id: dep.id, reason: 'Shared file', mode: 'sequential' }]);
    assert.deepEqual(p.relatedJobs, fresh.relatedJobs);
    assert.deepEqual(fresh.planOverlap.find(j => j.id === dep.id), { id: dep.id, title: dep.title, files: ['hello.txt'] });
    assert.equal(fresh.dependsOn, undefined, 'suggestions never assign dependencies');
    const prompt = team.events(job.id).find(e => e.type === 'TASK_ASSIGNMENT').details.prompt;
    assert.match(prompt, new RegExp(dep.branch)); assert.match(prompt, /only the owner chooses/);
    const payload = { version: p.version, hash: p.hash, ...(choice !== 'none' ? { related: { [dep.id]: choice } } : {}) };
    if (choice === 'sequential') {
      dep.dependsOn = [job.id]; team.save(dep);
      await assert.rejects(team.control(job.id, 'approve-plan', payload), { message: msg('srv.team.depends_cycle') });
      delete dep.dependsOn; team.save(dep);
    }
    const approved = await team.control(job.id, 'approve-plan', payload);
    assert.deepEqual(approved.dependsOn, choice === 'sequential' ? [dep.id] : undefined);
    if (choice === 'sequential') assert.doesNotMatch(team.events(job.id).find(e => e.type === 'DEPENDS_SET').summary, /\{\d+\}/);
    assert.deepEqual(approved.relatedChoices, choice === 'none' ? undefined : { [dep.id]: choice });
    approved.status = 'paused'; team.save(approved);
  }
  assert.equal(calls.length, 3);
  const job = await create({ dependsOn: [dep.id], planApproval: false }); job.status = 'queued'; team.save(job);
  await team.tick(); assert.equal(calls.length, 4, 'plan can run while a dependency is unmet');
  await team.tick(); assert.equal(team.get(job.id).status, 'waiting'); assert.equal(calls.length, 4);
});

test('legacy jobs without dependsOn still dispatch implement', async t => {
  const { team, create, implement, calls, faults } = await fixture(t), job = implement(await create());
  assert.equal(job.dependsOn, undefined);
  await team.tick();
  assert.equal(calls.filter(c => c.stage === 'implement').length, 1);
  assert.equal(team.get(job.id).stage, 'test'); assert.deepEqual(faults, []);
  assert.deepEqual(team.state().jobs.find(j => j.id === job.id).depends, []);
});

for (const risk of ['low', 'high']) test(`F1: ${risk} risk completes planning and approval before waiting for dependencies`, async t => {
  const { team, create, calls, faults } = await fixture(t, { runAgent: async (agent, context) => {
    if (context.stage === 'challenge') return { status: 'completed', objections: [] };
    assert.equal(context.stage, 'plan');
    return { status: 'planned', summary: 'Plan', kind: 'code', risk, rigor: 'standard',
      tasks: [{ agent: 'builder', difficulty: 2, instruction: 'Update hello', files: ['hello.txt'], dependsOn: [] }] };
  } });
  const dep = await create(), job = await create({ dependsOn: [dep.id], planApproval: true });
  job.status = 'queued'; team.save(job);
  await team.tick();
  const legacy = team.get(job.id);
  legacy.status = 'waiting'; legacy.blockedReason = { kind: 'depends', ids: [dep.id] }; legacy.error = 'Legacy dependency wait'; team.save(legacy);
  if (risk === 'high') { assert.equal(team.get(job.id).stage, 'challenge'); await team.tick(); }
  await team.tick();
  const proposed = team.get(job.id), plan = proposed.plans.at(-1);
  assert.equal(proposed.status, 'waiting'); assert(proposed.planGate);
  assert.equal(proposed.blockedReason, undefined);
  assert.equal(calls.filter(c => c.stage === 'challenge').length, risk === 'high' ? 1 : 0);
  assert.equal(team.events(job.id).filter(e => e.type === 'PLAN_PROPOSED').length, 1);
  await team.control(job.id, 'approve-plan', { version: plan.version, hash: plan.hash });
  await team.tick();
  assert.equal(team.get(job.id).blockedReason.kind, 'depends');
  assert.equal(calls.filter(c => c.stage === 'implement').length, 0); assert.deepEqual(faults, []);
});

for (const stage of ['review', 'verify', 'final']) test(`F1: dependency sync at ${stage} requires new tests before checks can finish`, async t => {
  const { team, root, create, implement, merged, calls, faults } = await fixture(t), dep = await create();
  const job = implement(await create({ dependsOn: [dep.id] }));
  await merged(dep); team.capacity = () => ({ start: 0 }); await team.tick();
  const before = team.get(job.id);
  Object.assign(before, { stage, tested: before.revision, reviewed: before.revision, verified: before.revision, skipped: ['review', 'verify'] }); team.save(before);
  const head = await commit(root, 'later.txt', 'late base change\n');
  await team.tick();
  const fresh = team.get(job.id);
  assert.equal(fresh.base, head); assert.equal(fresh.stage, 'test'); assert.notEqual(fresh.revision, before.revision);
  assert.equal(fresh.tested, null); assert.equal(fresh.reviewed, null); assert.equal(fresh.verified, null); assert.deepEqual(fresh.skipped, []);
  await assert.rejects(team.assertReady(fresh));
  team.capacity = () => ({ start: 3 }); await team.tick();
  assert.equal(team.get(job.id).tested, fresh.revision); assert.deepEqual(calls, []); assert.deepEqual(faults, []);
});

test('F3: dependency errors and events interpolate every placeholder', async t => {
  const { team, create, implement, merged } = await fixture(t), dep = await create(), job = implement(await create({ dependsOn: [dep.id] }));
  for (const ids of ['bad', [], Array(11).fill(dep.id), [''], [null]]) {
    if (Array.isArray(ids) && !ids.length) continue;
    await assert.rejects(team.control(job.id, 'set-depends', { ids }), error => !/\{\d+\}/.test(error.message));
  }
  await team.control(job.id, 'set-depends', { ids: [dep.id] });
  await team.tick(); await merged(dep); team.capacity = () => ({ start: 0 }); await team.tick();
  for (const type of ['DEPENDS_SET', 'DEPENDS_MET']) {
    const event = team.events(job.id).find(e => e.type === type);
    assert(event); assert.doesNotMatch(event.summary, /\{\d+\}/);
    assert.match(event.summary, new RegExp(type === 'DEPENDS_SET' ? dep.id : 'master'));
  }
});

test('F4: stable dependency ticks never save rows or reserve ready and paused jobs', async t => {
  const { team, create, implement, merged } = await fixture(t), dep = await create();
  const waiting = implement(await create({ dependsOn: [dep.id] }));
  team.capacity = () => ({ start: 0 }); await team.tick();
  const checkNoop = async ids => {
    const before = ids.map(id => team.get(id)), saves = [], checks = [], original = team.save.bind(team), check = team.checkDepends.bind(team);
    let changes = 0;
    const changed = () => { changes++; };
    team.save = (...args) => { saves.push(args[0].id); return original(...args); };
    team.checkDepends = async job => { checks.push(job.id); return check(job); };
    team.on('change', changed);
    try {
      await team.tick(); await team.tick();
      assert.deepEqual(ids.map(id => team.get(id)), before); assert.deepEqual(saves, []); assert.equal(changes, 0);
      for (const id of ids) assert.equal(team.runs.has(id), false);
      return checks;
    } finally { team.save = original; team.checkDepends = check; team.off('change', changed); }
  };
  await checkNoop([waiting.id]);
  await merged(dep); await team.tick();
  const ready = await create({ dependsOn: [dep.id] }), paused = await create({ dependsOn: [dep.id] });
  ready.status = 'ready'; team.save(ready);
  const checks = await checkNoop([waiting.id, ready.id, paused.id]);
  assert(!checks.includes(ready.id)); assert(!checks.includes(paused.id));
});
