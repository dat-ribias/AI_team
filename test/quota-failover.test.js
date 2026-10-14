import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { run } from '../src/process.js';
import { runAgent } from '../src/providers.js';

async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-check-'));
  await run(['git'], ['init', '-b', 'main', path]);
  // Fixture expectations use LF regardless of the machine's global Git setting.
  await run(['git'], ['-C', path, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, planApproval: false, maxRamPercent: 100, maxCpuPercent: 100,
    agents: ['codex-1', 'codex-2', 'codex-3', 'codex-4', 'gemini'].map(id => ({ id, label: id, role: id, provider: 'mock' })),
    pipeline: { manager: 'codex-1', builders: ['codex-2', 'codex-4'], reviewer: 'gemini', verifier: 'codex-3' },
    projects: [{ id: 'test', path, tests: [[process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('hello.txt','utf8'),'Hello from AI Team demo!\\n')"]] }],
  };
  return { config, path, data: mkdtempSync(join(tmpdir(), 'ai-team-state-')) };
}
async function settle(team, id, expected, timeoutMs = 20000) {
  const timeout = Date.now() + timeoutMs;
  while (Date.now() < timeout) {
    const job = team.get(id);
    if (job.status === expected && !team.active) return job;
    if (job.status === 'blocked' && expected !== 'blocked') assert.fail(job.error);
    await new Promise(r => setTimeout(r, 30));
  }
  assert.fail(`Timeout: ${JSON.stringify(team.get(id))}`);
}

async function approvalAgent(agent, task, prompt, opts) {
  if (task.stage === 'plan') return { summary: `Plan round ${task.round}: ${task.messages.map(m => m.text).join('; ')}`,
    kind: /research/i.test(task.goal) ? 'research' : 'code', rigor: 'standard', risk: 'low',
    tasks: [{ kind: 'implement', agent: 'codex-2', difficulty: 2, instruction: 'Update hello.txt', files: ['hello.txt'], dependsOn: [] }] };
  if (task.stage === 'implement') return runAgent(agent, task, prompt, opts);
  return { summary: 'Checked', status: 'completed', verdict: 'approved', findings: [], objections: [] };
}

async function quotaFixture(t, beforeCall = async () => {}) {
  const f = await fixture(); f.config.demo = false;
  f.config.agents = f.config.agents.map(a => ({ ...a, provider: 'codex', tier: 'normal', home: mkdtempSync(join(tmpdir(), 'quota-home-')) }));
  const seen = [], resetsAt = new Date(Date.now() + 3600_000).toISOString();
  const quotas = new Map(f.config.agents.map(a => [a.id, 100]));
  const buckets = remaining => [{ id: 'b', name: 'b', windows: [{ name: 'w', remaining, minutes: 300, resetsAt }] }];
  const team = new Team(f.config, f.data, {
    readQuota: async a => ({ observed: true, buckets: buckets(quotas.get(a.id)) }),
    runAgent: async (agent, task, prompt, opts) => {
      seen.push({ agent: agent.id, stage: task.stage });
      await beforeCall(agent, task);
      return approvalAgent({ ...agent, provider: 'mock' }, task, prompt, opts);
    },
  });
  t.after(async () => {
    await team.close();
    for (const path of [f.path, f.data, ...f.config.agents.map(a => a.home)]) rmSync(path, { recursive: true, force: true });
  });
  const quota = (id, remaining) => {
    quotas.set(id, remaining);
    team.db.prepare('INSERT OR REPLACE INTO quotas VALUES (?,?)').run(id, JSON.stringify({
      checkedAt: new Date().toISOString(), observed: true, status: 'available', buckets: buckets(remaining),
    }));
  };
  const allQuota = remaining => f.config.agents.forEach(a => quota(a.id, remaining));
  allQuota(100);
  return { ...f, team, seen, quota, allQuota, resetsAt };
}

const options = { timeout: 20000 };
const autoEvents = (team, id, role) => team.events(id).filter(e => e.type === 'REASSIGN' && e.details.auto === true && e.details.role === role);

async function blockedJob(f) {
  f.allQuota(0);
  const job = await f.team.create({ project: 'test', goal: 'Update hello' });
  const blocked = await settle(f.team, job.id, 'blocked', 5000);
  f.team.closed = true;
  return blocked;
}

test('quota failover: manager plan uses strongest available replacement', options, async t => {
  const f = await quotaFixture(t);
  f.team.agent('codex-3').tier = 'strong'; f.team.agent('codex-4').tier = 'weak';
  f.quota('codex-1', 0); f.quota('codex-3', 50); f.quota('codex-4', 100);
  const job = await f.team.create({ project: 'test', goal: 'Update hello' });
  await settle(f.team, job.id, 'ready', 15000);
  const plan = f.seen.find(s => s.stage === 'plan');
  assert.notEqual(plan.agent, 'codex-1'); assert.equal(plan.agent, 'codex-3');
  assert(autoEvents(f.team, job.id, 'manager').some(e => e.details.from === 'codex-1' && e.details.to === plan.agent));
});

test('quota failover: reviewer replacement is independent of actual implementers', options, async t => {
  const f = await quotaFixture(t); f.quota('gemini', 0);
  // Force the first reviewer candidate to be the builder so independence must reroute it.
  f.team.agent('codex-2').tier = 'strong';
  const job = await f.team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(f.team, job.id, 'ready', 15000);
  const review = f.seen.find(s => s.stage === 'review');
  assert.notEqual(review.agent, 'gemini'); assert.notEqual(review.agent, ready.tasks[0].ranBy);
  assert(!ready.implementers.includes(review.agent));
  assert(autoEvents(f.team, job.id, 'reviewer').length > 0);
});

test('quota failover: all exhausted members block with quota role and earliest reset', options, async t => {
  const f = await quotaFixture(t), blocked = await blockedJob(f);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.blockedReason.kind, 'quota');
  assert.equal(blocked.blockedReason.role, 'manager'); assert.equal(blocked.blockedReason.agent, 'codex-1');
  assert.equal(blocked.blockedReason.resetsAt, f.resetsAt); assert.equal(f.seen.length, 0);
});

test('quota failover: recovered quota tick requeues and clears blocked reason', options, async t => {
  let recovering = false, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await quotaFixture(t, async (agent, task) => {
    if (recovering && task.stage === 'plan') { entered(); await gate; }
  });
  const blocked = await blockedJob(f);
  f.quota('codex-1', 100); recovering = true; f.team.closed = false;
  const ticking = f.team.tick();
  try {
    let timer;
    try {
      await Promise.race([started, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Recovered plan did not start')), 5000); })]);
    } finally { clearTimeout(timer); }
    const running = f.team.get(blocked.id);
    assert.equal(running.status, 'running');
    assert.equal(running.blockedReason, undefined);
    assert(f.team.events(blocked.id).some(e => e.type === 'REQUEUE'));
    // Checkers also recover before execution finishes, preserving independent review.
    f.allQuota(100);
  } finally { release(); await ticking; }
  const ready = await settle(f.team, blocked.id, 'ready', 15000);
  assert.equal(ready.blockedReason, undefined);
});

test('quota failover: assign on quota-blocked job immediately queues without resume', options, async t => {
  const f = await quotaFixture(t), blocked = await blockedJob(f);
  f.quota('codex-4', 100);
  await f.team.control(blocked.id, 'assign', { role: 'manager', agent: 'codex-4' });
  const queued = f.team.get(blocked.id);
  assert.equal(queued.status, 'queued'); assert.equal(queued.blockedReason, undefined);
  assert.equal(queued.override.manager, 'codex-4');
});

test('quota failover: exhausted pinned manager is temporarily replaced for plan and final', options, async t => {
  const f = await quotaFixture(t); f.team.closed = true;
  const job = await f.team.create({ project: 'test', goal: 'Update hello', paused: true });
  await f.team.control(job.id, 'assign', { role: 'manager', agent: 'codex-1' });
  f.quota('codex-1', 0); f.team.closed = false; await f.team.tick();
  const ready = await settle(f.team, job.id, 'ready', 15000);
  for (const stage of ['plan', 'final']) assert.notEqual(f.seen.find(s => s.stage === stage).agent, 'codex-1');
  assert.equal(ready.override.manager, 'codex-1');
  assert(autoEvents(f.team, job.id, 'manager').some(e => e.details.pinned === true && e.details.from === 'codex-1' && e.details.resetsAt === f.resetsAt));
});

test('quota failover: disabling pinned replacement blocks instead of replacing manager', options, async t => {
  const f = await quotaFixture(t); f.team.config.allowAutoReplacePinned = false; f.team.closed = true;
  const job = await f.team.create({ project: 'test', goal: 'Update hello', paused: true });
  await f.team.control(job.id, 'assign', { role: 'manager', agent: 'codex-1' });
  f.quota('codex-1', 0); f.team.closed = false; await f.team.tick();
  const blocked = await settle(f.team, job.id, 'blocked', 5000); f.team.closed = true;
  assert.equal(blocked.blockedReason.kind, 'quota'); assert.equal(blocked.blockedReason.role, 'manager');
  assert.equal(blocked.blockedReason.resetsAt, f.resetsAt); assert.equal(blocked.override.manager, 'codex-1');
  assert.equal(autoEvents(f.team, job.id, 'manager').length, 0); assert.equal(f.seen.length, 0);
});

test('quota failover F3: exhausted pipeline builders fall back to another non-antigravity member', options, async t => {
  const f = await quotaFixture(t);
  for (const id of f.config.pipeline.builders) f.quota(id, 0);
  const job = await f.team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(f.team, job.id, 'ready', 15000);
  const implement = f.seen.find(s => s.stage === 'implement');
  assert(!f.config.pipeline.builders.includes(implement.agent));
  assert.notEqual(f.team.agent(implement.agent).provider, 'antigravity');
  assert.equal(ready.tasks[0].ranBy, implement.agent);
  assert.equal(f.team.lowQuota(implement.agent), false);
});
