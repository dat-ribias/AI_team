import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Team, validateConfig } from '../src/team.js';
import { run } from '../src/process.js';

const git = async (path, ...args) => (await run(['git'], ['-C', path, ...args])).stdout.trim();
const completed = { summary: 'Checked', status: 'completed', verdict: 'approved', findings: [] };
const plan = [
  { agent: 'codex-2', difficulty: 2, instruction: 'T1 edit', files: ['t1.txt'], dependsOn: [] },
  { agent: 'codex-4', difficulty: 2, instruction: 'T2 edit', files: ['t2.txt'], dependsOn: [] },
];

async function fixture(t, agentRun, tasks = plan, configure = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-team-wip-')), path = join(root, 'repo'), data = join(root, 'data');
  const teams = [];
  t.after(async () => {
    for (const team of teams) await team.close();
    assert(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('ai-team-wip-'));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path); mkdirSync(data);
  await run(['git'], ['init', '-b', 'main', path]);
  await git(path, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  await git(path, 'add', '.');
  await git(path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial');
  const config = { demo: true, planApproval: false, peerDialogue: false, maxRamPercent: 100, maxCpuPercent: 100,
    resources: { reserveGB: 0, ramPerAgentGB: 0.01, maxAgents: 4, hardStopRamPercent: 100 },
    agents: ['codex-1', 'codex-2', 'codex-3', 'codex-4', 'gemini'].map(id => ({ id, label: id, provider: 'mock' })),
    pipeline: { manager: 'codex-1', builders: ['codex-2', 'codex-4'], reviewer: 'gemini', verifier: 'codex-3' },
    projects: [{ id: 'test', path, tests: [] }],
  };
  configure(config);
  const team = new Team(config, data, { runAgent: async (...args) => args[1].stage === 'implement' ? agentRun(...args) : completed }); teams.push(team);
  team.kick = () => {};
  const job = await team.create({ project: 'test', goal: 'Preserve builder work', paused: true });
  Object.assign(job, { stage: 'implement', status: 'queued', kind: 'code', rigor: 'standard', risk: 'low', tasks: structuredClone(tasks) }); team.save(job);
  return { team, job, path, data, config, teams };
}

async function resume(team, id) {
  await team.control(id, 'resume');
  await team.runJob(team.get(id));
  return team.get(id);
}

test('parallel failure keeps WIP on its child branch and resumes the sole remaining task', async t => {
  let calls = 0, resumed = false;
  const { team, job, path } = await fixture(t, async (agent, task) => {
    if (agent.id === 'codex-2') {
      if (++calls === 1) { writeFileSync(join(task.worktree, 't1.txt'), '<<<<<<< unfinished\n'); throw new Error('builder failed'); }
      resumed = readFileSync(join(task.worktree, 't1.txt'), 'utf8') === '<<<<<<< unfinished\n';
      writeFileSync(join(task.worktree, 't1.txt'), 'recovered\n');
    } else writeFileSync(join(task.worktree, 't2.txt'), 'done\n');
    return completed;
  });
  await team.runJob(job);
  const blocked = team.get(job.id), wip = blocked.tasks[0].checkpoint.wip;
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.tasks[1].done, true);
  assert.equal(wip.branch, `${job.branch}-t1`); assert.equal(wip.reason, 'builder failed'); assert(Number.isFinite(Date.parse(wip.at)));
  assert.equal(await git(path, 'rev-parse', wip.branch), wip.commit);
  assert.equal(await git(path, 'log', '-1', '--format=%s', wip.branch), `AI Team ${job.id} T1 codex-2: WIP`);
  assert.equal(await git(path, 'log', '-1', '--format=%ae', wip.branch), 'codex-2@ai-team.local');
  assert(existsSync(`${job.worktree}-t1`)); assert(!existsSync(`${job.worktree}-t2`));
  assert(!existsSync(join(job.worktree, 't1.txt')), 'WIP must not merge into the job branch');
  const recovered = await resume(team, job.id);
  assert(resumed); assert.equal(recovered.tasks[0].done, true); assert.equal(recovered.stage, 'test');
  assert.equal(readFileSync(join(job.worktree, 't1.txt'), 'utf8'), 'recovered\n');
  assert(!existsSync(`${job.worktree}-t1`)); assert.equal(await git(path, 'branch', '--list', wip.branch), '');
  assert.equal(team.events(job.id).filter(e => e.type === 'RESUME_WIP').length, 1);
});

test('resume adds an existing WIP branch after its worktree directory was lost', async t => {
  let recover = false, sawFile = false;
  const { team, job } = await fixture(t, async (agent, task) => {
    if (agent.id === 'codex-2') {
      if (!recover) { writeFileSync(join(task.worktree, 't1.txt'), 'snapshot\n'); throw new Error('stop'); }
      sawFile = readFileSync(join(task.worktree, 't1.txt'), 'utf8') === 'snapshot\n';
    } else writeFileSync(join(task.worktree, 't2.txt'), 'done\n');
    return completed;
  });
  await team.runJob(job);
  const wt = resolve(`${job.worktree}-t1`); assert(wt.startsWith(resolve(team.dataDir) + sep)); rmSync(wt, { recursive: true, force: true });
  recover = true; await resume(team, job.id); assert(sawFile);
});

test('a failed WIP commit preserves its worktree and does not prevent another task checkpoint', async t => {
  const { team, job, path } = await fixture(t, async (agent, task) => {
    writeFileSync(join(task.worktree, agent.id === 'codex-2' ? 't1.txt' : 't2.txt'), 'partial\n');
    if (agent.id === 'codex-2') writeFileSync(await git(task.worktree, 'rev-parse', '--git-path', 'index.lock'), '');
    throw new Error('builder failed');
  });
  await team.runJob(job);
  const blocked = team.get(job.id); assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.tasks[0].checkpoint?.wip, undefined);
  assert.equal(readFileSync(join(`${job.worktree}-t1`, 't1.txt'), 'utf8'), 'partial\n');
  const wip = blocked.tasks[1].checkpoint.wip;
  assert.equal(await git(path, 'show', `${wip.commit}:t2.txt`), 'partial');
  assert(team.events(job.id).some(e => e.type === 'WIP_WARNING' && e.details.task === 0));
});

test('Team.close preserves parallel WIP and pauses the job for recovery', async t => {
  let release; const started = new Promise(r => { release = r; }); let count = 0;
  const f = await fixture(t, async (agent, task, prompt, opts) => {
    writeFileSync(join(task.worktree, agent.id === 'codex-2' ? 't1.txt' : 't2.txt'), 'before shutdown\n');
    if (++count === 2) release();
    await new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }); });
  });
  const running = f.team.runJob(f.job); await started; await f.team.close(); await running;
  const reopened = new Team(f.config, f.data); f.teams.push(reopened); reopened.kick = () => {};
  const paused = reopened.get(f.job.id);
  assert.equal(paused.status, 'paused'); assert.equal(paused.error, null); assert.deepEqual(paused.running, []); assert.equal(paused.current, null);
  for (const [i, task] of paused.tasks.entries()) {
    assert(task.checkpoint.wip); assert.equal(await git(f.path, 'show', `${task.checkpoint.wip.commit}:t${i + 1}.txt`), 'before shutdown');
    assert(existsSync(`${f.job.worktree}-t${i + 1}`));
  }
  assert(reopened.events(f.job.id).some(e => e.type === 'RECOVERY' && /Server closed/.test(e.summary)));
});

for (const action of ['pause', 'cancel']) test(`${action} preserves every parallel task checkpoint without overwriting control state`, async t => {
  let release; const started = new Promise(r => { release = r; }); let count = 0;
  const { team, job } = await fixture(t, async (agent, task, prompt, opts) => {
    writeFileSync(join(task.worktree, agent.id === 'codex-2' ? 't1.txt' : 't2.txt'), 'partial\n');
    if (++count === 2) release();
    await new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }); });
  });
  const running = team.runJob(job); await started; await team.control(job.id, action); await running;
  const stopped = team.get(job.id); assert.equal(stopped.status, action === 'pause' ? 'paused' : 'cancelled');
  assert(stopped.tasks.every(task => task.checkpoint?.wip));
});

for (const timeout of ['idle', 'max']) for (const parallel of [false, true]) test(`${timeout} timeout retries once (${parallel ? 'parallel WIP' : 'job worktree'}) then blocks`, async t => {
  let calls = 0, sawSnapshot = false;
  const { team, job } = await fixture(t, async (agent, task) => {
    if (agent.id === 'codex-2') {
      if (++calls === 2) sawSnapshot = readFileSync(join(task.worktree, 't1.txt'), 'utf8') === 'partial\n';
      writeFileSync(join(task.worktree, 't1.txt'), 'partial\n');
      throw Object.assign(new Error(`${timeout} timed out`), { timeout });
    }
    writeFileSync(join(task.worktree, 't2.txt'), 'done\n'); return completed;
  }, parallel ? plan : plan.slice(0, 1), config => { config.idleTimeoutMin = 2; config.maxCallMin = 7; });
  if (!parallel) { job.fast = true; team.save(job); }
  // Use the real scheduler to verify that wave(false) automatically schedules its retry.
  team.kick = Team.prototype.kick; team.kick();
  const until = Date.now() + 20_000;
  while (team.get(job.id).status !== 'blocked' || team.runs.size) {
    assert(Date.now() < until, 'scheduler must finish the timeout retry'); await new Promise(r => setTimeout(r, 20));
  }
  const blocked = team.get(job.id);
  assert.equal(calls, 2); assert(sawSnapshot); assert.equal(blocked.tasks[0].timeoutRetried, true); assert.match(blocked.error, /timed out/);
  const retries = team.events(job.id).filter(e => e.type === 'RETRY'); assert.equal(retries.length, 1);
  assert.equal(retries[0].details.timeout, timeout); assert.equal(retries[0].details.minutes, timeout === 'idle' ? 2 : 7);
  if (!parallel) assert.equal(await git(job.worktree, 'rev-parse', 'HEAD'), job.base, 'failed single task must not commit WIP into the job branch');
  else assert(blocked.tasks[0].checkpoint.wip);
});

test('timeout retry succeeds from WIP and integrates the recovered task', async t => {
  let calls = 0;
  const { team, job } = await fixture(t, async (agent, task) => {
    if (agent.id === 'codex-2') {
      if (++calls === 1) { writeFileSync(join(task.worktree, 't1.txt'), 'partial\n'); throw Object.assign(new Error('idle timeout'), { timeout: 'idle' }); }
      assert.equal(readFileSync(join(task.worktree, 't1.txt'), 'utf8'), 'partial\n'); writeFileSync(join(task.worktree, 't1.txt'), 'finished\n');
    } else writeFileSync(join(task.worktree, 't2.txt'), 'done\n');
    return completed;
  });
  await team.runJob(job); assert.equal(team.get(job.id).status, 'queued');
  await team.runJob(team.get(job.id));
  assert.equal(calls, 2); assert(team.get(job.id).tasks.every(t => t.done)); assert.equal(readFileSync(join(job.worktree, 't1.txt'), 'utf8'), 'finished\n');
});

test('timeout config validates numbers and passes defaults, team settings and member overrides to agents', async t => {
  for (const settings of [{}, { idleTimeoutMin: 3, maxCallMin: 9 }]) {
    const received = [];
    const { team, job, config } = await fixture(t, async (agent, task) => { received.push([agent.id, task.idleTimeoutMin, task.maxCallMin]); return completed; }, plan, config => {
      Object.assign(config, settings); Object.assign(config.agents.find(a => a.id === 'codex-4'), { idleTimeoutMin: 1, maxCallMin: 4 });
    });
    for (const key of ['idleTimeoutMin', 'maxCallMin', 'silenceWarnMin']) for (const value of [0, -1, Infinity, NaN, '5', null]) assert.throws(() => validateConfig({ ...config, [key]: value }), /positive number/);
    for (const key of ['idleTimeoutMin', 'maxCallMin']) assert.throws(() => validateConfig({ ...config, agents: config.agents.map(a => ({ ...a, [key]: 0 })) }), /positive number/);
    await team.runJob(job);
    assert.deepEqual(received.sort(), [['codex-2', settings.idleTimeoutMin ?? 15, settings.maxCallMin ?? 120], ['codex-4', 1, 4]]);
    assert.equal(team.state().silenceWarnMin, 5); assert.equal(team.state().jobs.find(j => j.id === job.id).overMinutes, null);
  }
});

test('agent events update job/run lastActivityAt, throttle saves and expose overrun state', async t => {
  const { team, job } = await fixture(t, async (agent, task, prompt, opts) => {
    const initial = team.get(job.id).running[0]; assert.equal(initial.lastActivityAt, initial.startedAt);
    await new Promise(r => setTimeout(r, 20));
    let saves = 0; const save = team.save.bind(team); team.save = job => { saves++; return save(job); };
    try {
      for (const type of ['ACTIVITY', 'OUTPUT', 'USAGE']) opts.onEvent(type, { summary: 'progress', details: {} });
      assert.equal(saves, 1);
      const active = team.get(job.id); assert(Date.parse(active.lastActivityAt) > Date.parse(initial.startedAt));
      assert.equal(active.running[0].lastActivityAt, active.lastActivityAt);
      const state = team.state(); assert.equal(state.silenceWarnMin, 6); assert.equal(state.jobs.find(j => j.id === job.id).overMinutes, 0);
      const savedAt = active.lastActivityAt;
      await new Promise(r => setTimeout(r, 20));
      const clock = t.mock.method(Date, 'now', () => new Date().getTime() + 10_001);
      try { opts.onEvent('OUTPUT', { summary: 'later progress', details: {} }); }
      finally { clock.mock.restore(); }
      assert.equal(saves, 2); assert(Date.parse(team.get(job.id).lastActivityAt) > Date.parse(savedAt));
    } finally { team.save = save; }
    return completed;
  }, plan.slice(0, 1), config => { config.silenceWarnMin = 6; });
  await team.runJob(job); assert.notEqual(team.get(job.id).status, 'blocked', team.get(job.id).error);
  assert(team.get(job.id).lastActivityAt);
  assert.equal(team.overrun({ running: [] }), null);
  const running = [{ startedAt: new Date(Date.now() - 8 * 60_000).toISOString(), est: 5 }];
  assert.equal(team.overrun({ running }), 3); assert.equal(typeof team.eta({ status: 'running', running, tasks: [] }), 'number');
});
