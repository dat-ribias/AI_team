import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { run } from '../src/process.js';

const options = { timeout: 20000 };
const approved = () => ({ summary: 'Checked', status: 'completed', verdict: 'approved', findings: [] });

async function fixture(t, beforeCall = async () => {}) {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-roster-'));
  const data = mkdtempSync(join(tmpdir(), 'ai-team-roster-state-'));
  let team;
  t.after(async () => {
    try { if (team) await team.close(); }
    finally { for (const dir of [path, data]) rmSync(dir, { recursive: true, force: true }); }
  });
  await run(['git'], ['init', '-b', 'main', path]);
  await run(['git'], ['-C', path, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n', 'utf8');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, planApproval: false, maxRamPercent: 100, maxCpuPercent: 100,
    agents: ['codex-1', 'codex-2', 'codex-3', 'codex-4', 'gemini'].map(id => ({ id, label: id, role: id, provider: 'mock' })),
    pipeline: { manager: 'codex-1', builders: ['codex-2', 'codex-4'], reviewer: 'gemini', verifier: 'codex-3' },
    projects: [{ id: 'test', path, tests: [] }],
  };
  const seen = [];
  team = new Team(config, data, { runAgent: async (agent, task, prompt, opts) => {
    seen.push({ agent: agent.id, stage: task.stage });
    await beforeCall(agent, task, opts);
    return approved();
  } });
  // Drive one controller step explicitly; do not start timers or background ticks.
  team.kick = () => {};
  const job = await team.create({ project: 'test', goal: 'Update hello', mode: 'full', paused: true });
  Object.assign(job, { stage: 'review', kind: 'code', rigor: 'standard', risk: 'low',
    flow: { reviewer: 'gemini', verifier: 'codex-3', requested: { steps: ['review', 'verify'] } },
    checkers: { reviewer: 'gemini', verifier: 'codex-3' }, implementers: ['codex-2'],
    tasks: [{ kind: 'implement', agent: 'codex-2', ranBy: 'codex-2', difficulty: 2,
      instruction: 'Update hello.txt', files: ['hello.txt'], done: true,
      checkpoint: { done: 'Saved work', remaining: 'Review', next: 'Review' } }], tested: job.revision });
  team.save(job);
  const pipeline = changes => { team.config = { ...team.config, pipeline: { ...team.config.pipeline, ...changes } }; };
  return { team, job, seen, pipeline };
}

function warning(team, job, from, to) {
  assert(team.events(job.id).some(e => e.type === 'WARNING' && e.summary.includes(from) && e.summary.includes(to)),
    `Expected roster-change WARNING naming ${from} and ${to}`);
}

for (const [stage, role, from, to] of [
  ['review', 'reviewer', 'gemini', 'codex-1'],
  ['verify', 'verifier', 'codex-3', 'codex-4'],
  ['plan', 'manager', 'codex-1', 'codex-4'],
]) {
  test(`roster A1/A2: ${stage} replaces saved ${role} after reassignment and warns`, options, async t => {
    const { team, job, pipeline } = await fixture(t);
    job.stage = stage;
    pipeline({ [role]: to });
    const selected = role === 'manager' ? team.pickMember(job, role) : team.checker(job, role, job.roster);
    assert.equal(selected, to, `Saved ${role} ${from} no longer holds this role`);
    warning(team, job, from, to);
  });
}

test('roster A1: removing the old reviewer account selects the current reviewer and warns', options, async t => {
  const { team, job, pipeline } = await fixture(t);
  pipeline({ reviewer: 'codex-4' });
  team.config = { ...team.config, agents: team.config.agents.filter(a => a.id !== 'gemini') };
  assert.equal(team.checker(job, 'reviewer', job.roster), 'codex-4');
  warning(team, job, 'gemini', 'codex-4');
});

test('roster A3: implement replaces a task agent removed from current builders', options, async t => {
  const { team, job, pipeline } = await fixture(t);
  job.stage = 'implement'; job.tasks[0].done = false;
  pipeline({ builders: ['codex-4'] });
  const selected = team.chooseBuilder(job, job.tasks[0]);
  assert.equal(selected, 'codex-4', 'Removed builder must not be retained from the task or job roster');
});

test('roster A4: replacement reviewer is independent of the actual implementer', options, async t => {
  const { team, job, pipeline } = await fixture(t);
  pipeline({ reviewer: 'codex-2' });
  const selected = team.checker(job, 'reviewer', job.roster);
  assert(!job.implementers.includes(selected), 'Replacement must not review its own code');
  assert.notEqual(selected, 'gemini', 'Independence must not restore the revoked reviewer');
  assert(team.events(job.id).some(e => e.type === 'REROUTE' && e.details.from === 'codex-2' && e.details.to === selected));
  warning(team, job, 'gemini', selected);
});

test('roster B1: no reviewer waits for the owner with a role reason without a rework round', options, async t => {
  const { team, job, pipeline, seen } = await fixture(t);
  pipeline({ reviewer: null });
  await team.runJob(job);
  const waiting = team.get(job.id);
  assert.equal(waiting.status, 'waiting', 'A missing reviewer role must wait for the owner');
  assert.equal(waiting.blockedReason?.kind, 'role');
  assert.equal(waiting.blockedReason.role, 'reviewer');
  assert.match(waiting.error, /reviewer/i);
  assert.equal(waiting.round, 0);
  assert.equal(seen.length, 0, 'Do not invoke a revoked reviewer or an arbitrary enabled agent');
  assert(!team.events(job.id).some(e => e.type === 'BLOCKER'));
});

test('roster B2: assigning a reviewer wakes an existing role-waiting job without resume', options, async t => {
  const { team, job, pipeline } = await fixture(t);
  pipeline({ reviewer: null });
  // Seed the expected B1 persisted state so recovery is tested independently of B1.
  Object.assign(job, { status: 'waiting', error: 'No agent has role reviewer',
    blockedReason: { kind: 'role', role: 'reviewer' } });
  team.save(job);
  pipeline({ reviewer: 'codex-1' });
  team.syncRoster();
  // Keep tick from starting another stage: this test observes recovery to queued.
  team.capacity = () => ({ start: false, reason: 'test scheduling gate' });
  await team.tick();
  const queued = team.get(job.id);
  assert.equal(queued.status, 'queued', 'Restoring the role must wake a waiting job without owner resume');
  assert.equal(queued.blockedReason, undefined);
  assert(!queued.error);
  assert.equal(queued.round, 0);
  assert.equal(team.checker(queued, 'reviewer', queued.roster), 'codex-1');
});

test('roster B3: resume of a legacy blocked job ignores stale flow and checker assignments', options, async t => {
  const { team, job, pipeline, seen } = await fixture(t);
  Object.assign(job, { status: 'blocked', error: 'Reviewer no longer has role',
    blockedReason: { kind: 'role', role: 'reviewer', agent: 'gemini' } });
  team.save(job);
  pipeline({ reviewer: 'codex-1' });
  await team.control(job.id, 'resume');
  await team.runJob(team.get(job.id));
  assert.equal(seen.find(s => s.stage === 'review')?.agent, 'codex-1');
  assert.equal(team.get(job.id).round, 0);
  assert(!team.events(job.id).some(e => e.type === 'BLOCKER'));
});

function gate() {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  let signal;
  const beforeCall = async (agent, task, opts) => {
    if (task.stage !== 'review') return;
    signal = opts.signal; entered();
    signal.throwIfAborted();
    let aborted;
    try {
      await Promise.race([finish, new Promise((resolve, reject) => {
        aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', aborted); }
  };
  return { started, release: () => release(), beforeCall, signal: () => signal };
}

for (const removed of [true, false]) {
  test(`roster B4: ${removed ? 'removing a running agent from all roles aborts and requeues with checkpoint' : 'changing a running agent role lets its current call finish'}`, options, async t => {
    const g = gate();
    const { team, job, pipeline } = await fixture(t, g.beforeCall);
    const checkpoint = structuredClone(job.tasks[0].checkpoint), revision = job.revision;
    const running = team.runJob(job);
    let timer;
    try {
      await Promise.race([g.started, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture review call did not start')), 5000);
      })]);
      clearTimeout(timer);
      pipeline({ reviewer: 'codex-1', ...(removed ? {} : { verifier: 'gemini' }) });
      team.syncRoster();
      // Allow asynchronous cancellation handling to settle; keep the mock call gated.
      await Promise.race([running, new Promise(resolve => { timer = setTimeout(resolve, 100); })]);
      clearTimeout(timer);
      assert.equal(g.signal().aborted, removed, removed ? 'Revoked agent call must be aborted' : 'A role change must not abort the current call');
      if (removed) {
        await running;
        const queued = team.get(job.id);
        assert.equal(queued.status, 'queued');
        assert.equal(queued.stage, 'review');
        assert.equal(queued.revision, revision);
        assert.deepEqual(queued.tasks[0].checkpoint, checkpoint);
        assert.equal(queued.round, 0);
        assert(!team.events(job.id).some(e => e.type === 'BLOCKER'));
      } else {
        g.release(); await running;
        const next = team.get(job.id);
        assert.equal(next.status, 'queued');
        assert.equal(next.reviewed, revision);
        assert.deepEqual(next.tasks[0].checkpoint, checkpoint);
        assert(!team.events(job.id).some(e => e.type === 'BLOCKER'));
      }
    } finally { clearTimeout(timer); g.release(); await running; }
  });
}

test('roster control: unchanged reviewer selection runs a real mock review successfully', options, async t => {
  const { team, job, seen } = await fixture(t);
  await team.runJob(job);
  const next = team.get(job.id);
  assert.equal(seen[0].agent, 'gemini');
  assert.equal(next.status, 'queued');
  assert.equal(next.stage, 'verify');
  assert.equal(next.reviewed, next.revision);
  assert(!team.events(job.id).some(e => e.type === 'BLOCKER'));
});

for (const [role, from, changes, to] of [
  ['reviewer', 'gemini', { reviewer: 'codex-1', verifier: 'gemini' }, 'codex-1'],
  ['verifier', 'codex-3', { verifier: 'codex-4', builders: ['codex-2', 'codex-3'] }, 'codex-4'],
]) {
  test(`roster F1: saved ${role} loses its original role while keeping another`, options, async t => {
    const { team, job, pipeline } = await fixture(t);
    pipeline(changes);
    assert.equal(team.checker(job, role, job.roster), to);
    assert.equal(job.flow[role], undefined);
    assert.equal(job.flowRoles?.[role], undefined);
    warning(team, job, from, to);
    assert.equal(job.round, 0);
    assert(!team.events(job.id).some(e => e.type === 'BLOCKER'));
  });
}

for (const selector of ['pickMember', 'checker']) {
  test(`roster F1: ${selector} keeps a manager-selected builder until its recorded role is revoked`, options, async t => {
    const { team, job, pipeline } = await fixture(t);
    const select = () => team[selector](job, 'reviewer', selector === 'checker' ? job.roster : {});
    job.flow.reviewer = 'codex-4';
    assert.equal(select(), 'codex-4');
    assert.deepEqual(job.flowRoles.reviewer, ['builder']);
    pipeline({ builders: ['codex-2'], verifier: 'codex-4' });
    assert.equal(select(), 'gemini');
    assert.equal(job.flow.reviewer, undefined);
    assert.equal(job.flowRoles.reviewer, undefined);
    pipeline({ builders: ['codex-2', 'codex-4'] });
    assert.equal(select(), 'gemini', 'An expired flow choice must not become active again');
    warning(team, job, 'codex-4', 'gemini');
  });
}

for (const [stage, role, from, to] of [
  ['plan', 'manager', 'codex-1', 'codex-4'],
  ['review', 'reviewer', 'gemini', 'codex-1'],
]) {
  test(`roster F2: ${stage} warns after syncRoster and step refresh the saved roster`, options, async t => {
    const { team, job, seen, pipeline } = await fixture(t);
    job.stage = stage;
    if (stage === 'plan') {
      job.flowRoles = { reviewer: ['verifier'] };
      // A valid one-step plan keeps this test focused on manager selection.
      const call = team.call.bind(team);
      team.call = async (...args) => {
        const report = await call(...args);
        return { ...report, kind: 'code', rigor: 'standard', risk: 'low', flow: { reviewer: 'codex-4' },
          tasks: [{ kind: 'implement', agent: 'codex-2', difficulty: 2,
            instruction: 'Update hello.txt', files: ['hello.txt'], dependsOn: [] }] };
      };
    } else job.flow.reviewer = null;
    team.save(job);
    pipeline({ [role]: to });
    team.syncRoster();
    const refreshed = team.get(job.id);
    assert.equal(refreshed.roster[role], to);
    assert.equal(refreshed.rosterSeen[role], from);
    await team.runJob(refreshed);
    const next = team.get(job.id);
    assert.equal(seen.find(s => s.stage === stage)?.agent, to);
    assert.equal(next.rosterSeen[role], to);
    warning(team, next, from, to);
    assert.equal(next.round, 0);
    assert(!team.events(job.id).some(e => e.type === 'BLOCKER'));
    if (stage === 'plan') {
      assert.equal(team.checker(next, 'reviewer', next.roster), 'codex-4', 'New plans must not inherit the previous flow role snapshot');
      assert.deepEqual(next.flowRoles.reviewer, ['manager', 'builder']);
    }
    const count = team.events(job.id).filter(e => e.type === 'WARNING').length;
    if (role === 'manager') team.pickMember(next, role);
    else team.checker(next, role, next.roster);
    assert.equal(team.events(job.id).filter(e => e.type === 'WARNING').length, count);
  });
}

for (const removed of [false, true]) {
  test(`roster F3: ${removed ? 'removed' : 'disabled'} override falls back to the current reviewer`, options, async t => {
    const { team, job, pipeline } = await fixture(t);
    job.override = { reviewer: 'gemini', add: ['gemini'] };
    pipeline({ reviewer: 'codex-4' });
    team.config = { ...team.config, agents: removed ? team.config.agents.filter(a => a.id !== 'gemini')
      : team.config.agents.map(a => a.id === 'gemini' ? { ...a, enabled: false } : a) };
    assert.equal(team.jobRoster(job).reviewer, 'codex-4');
    assert(!team.jobRoster(job).builders.includes('gemini'));
    assert.equal(team.checker(job, 'reviewer', job.roster), 'codex-4');
    warning(team, job, 'gemini', 'codex-4');
    assert.equal(job.round, 0);
  });
}

test('roster F3: a valid job override survives changes to the global role', options, async t => {
  const { team, job, pipeline } = await fixture(t);
  job.override = { reviewer: 'gemini' };
  pipeline({ reviewer: 'codex-4', verifier: 'gemini' });
  assert.equal(team.checker(job, 'reviewer', job.roster), 'gemini');
  assert.equal(job.override.reviewer, 'gemini');
});

test('roster F3: control assign wakes a role-waiting job', options, async t => {
  const { team, job, pipeline } = await fixture(t);
  pipeline({ reviewer: null });
  Object.assign(job, { status: 'waiting', error: 'No agent has role reviewer',
    blockedReason: { kind: 'role', role: 'reviewer' } });
  team.save(job);
  const next = await team.control(job.id, 'assign', { role: 'reviewer', agent: 'codex-1' });
  assert.equal(next.status, 'queued');
  assert.equal(next.error, null);
  assert.equal(next.blockedReason, undefined);
  assert.equal(team.checker(next, 'reviewer', next.roster), 'codex-1');
  assert.equal(next.round, 0);
});

test('roster selection probes leave stale flow, roster history and events unchanged', options, async t => {
  const { team, job, pipeline } = await fixture(t);
  pipeline({ reviewer: 'codex-2', verifier: 'gemini' });
  const before = structuredClone(job), events = team.events(job.id).length;
  assert.notEqual(team.pickMember(job, 'reviewer', { record: false }), 'gemini');
  assert(!job.implementers.includes(team.checker(job, 'reviewer', job.roster, job.implementers, undefined, false)));
  assert.deepEqual(job, before);
  assert.equal(team.events(job.id).length, events);
});
