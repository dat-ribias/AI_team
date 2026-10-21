import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { run } from '../src/process.js';
import { runAgent } from '../src/providers.js';
import { msg } from '../src/i18n.js';

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
  f.config.agents.find(a => a.id === 'codex-4').provider = 'claude';
  f.config.agents.find(a => a.id === 'gemini').provider = 'antigravity';
  f.config.transientRetryDelaysMs = [0, 0, 0];
  f.config.transientCooldownMs = 60_000;
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
const temporaryError = () => new Error('Reconnecting... 5/5 (unexpected status 503 Service Unavailable)');
const retryEvents = (team, id) => team.events(id).filter(e => e.type === 'RETRY');

test('transient failover: manager retries twice and keeps the same member', options, async t => {
  let failures = 0;
  const f = await quotaFixture(t, async (agent, task) => {
    if (task.stage === 'plan' && failures++ < 2) throw temporaryError();
  });
  const job = await f.team.create({ project: 'test', goal: 'Update hello' });
  await settle(f.team, job.id, 'ready', 15000);
  assert.equal(retryEvents(f.team, job.id).length, 2);
  assert(f.seen.filter(s => s.stage === 'plan').every(s => s.agent === 'codex-1'));
  assert.equal(f.team.providerDown('codex-1'), null);
});

test('transient failover: exhausted retries temporarily replace a pinned manager with another provider', options, async t => {
  const f = await quotaFixture(t, async agent => {
    if (agent.provider === 'codex') throw temporaryError();
  });
  f.team.closed = true;
  const job = await f.team.create({ project: 'test', goal: 'Update hello', paused: true });
  await f.team.control(job.id, 'assign', { role: 'manager', agent: 'codex-1' });
  f.team.closed = false; await f.team.tick();
  await f.team.tick();
  const ready = await settle(f.team, job.id, 'ready', 15000);
  assert(f.seen.some(s => s.stage === 'plan' && f.team.agent(s.agent).provider !== 'codex'));
  assert.equal(f.seen.filter(s => s.stage === 'plan' && s.agent === 'codex-1').length, 4);
  assert(f.team.events(job.id).some(e => e.type === 'REASSIGN' && e.summary === msg('srv.team.transient_switch', { provider: 'codex', status: '503', to: e.details.to }, job.lang)));
  assert(f.team.events(job.id).some(e => e.type === 'REASSIGN' && e.details.pinned === true));
  assert.equal(ready.override.manager, 'codex-1');
  assert.equal(f.team.remaining('codex-1'), 100);
  assert.equal(f.team.members(['codex-2'])[0].available, false);
});

test('transient failover: all providers down block and cooldown tick requeues', options, async t => {
  let failing = true;
  const f = await quotaFixture(t, async () => { if (failing) throw temporaryError(); });
  const job = await f.team.create({ project: 'test', goal: 'Update hello' });
  // Drive each replacement explicitly so the first intermediate blocker is not mistaken for the final one.
  let blocked;
  for (let n = 0; n < 3; n++) {
    blocked = await settle(f.team, job.id, 'blocked', 15000);
    if (f.config.agents.every(a => f.team.unusable(a.id))) break;
    await f.team.tick();
  }
  f.team.closed = true;
  assert(f.config.agents.every(a => f.team.unusable(a.id)));
  assert.equal(blocked.blockedReason.kind, 'transient');
  assert.equal(blocked.blockedReason.role, 'manager');
  assert.equal(blocked.blockedReason.provider, f.team.agent(blocked.blockedReason.agent).provider);
  assert(Date.parse(blocked.blockedReason.resetsAt) > Date.now());
  assert.equal(blocked.running.length, 0);
  failing = false;
  const until = Date.now() + 30;
  for (const provider of f.team.providerDowns.keys()) f.team.markProviderDown(provider, until, '503');
  await new Promise(r => setTimeout(r, 40));
  f.team.closed = false; await f.team.tick();
  const ready = await settle(f.team, job.id, 'ready', 15000);
  assert.equal(ready.blockedReason, undefined);
  assert(f.team.events(job.id).some(e => e.type === 'REQUEUE'));
});

test('transient failover: task assertion failure does not retry or hand over', options, async t => {
  const f = await quotaFixture(t, async (agent, task) => {
    if (task.stage === 'implement') throw new Error('Exit 1: AssertionError tests failed (expected 500)');
  });
  const job = await f.team.create({ project: 'test', goal: 'Update hello' });
  const blocked = await settle(f.team, job.id, 'blocked', 5000);
  assert.equal(blocked.blockedReason, undefined);
  assert.equal(retryEvents(f.team, job.id).length, 0);
  assert.equal(f.team.events(job.id).filter(e => ['HANDOVER', 'REASSIGN'].includes(e.type)).length, 0);
  assert.deepEqual(f.seen.filter(s => s.stage === 'implement'), [{ agent: 'codex-2', stage: 'implement' }]);
});

test('transient failover: builder hands over to another provider after three retries', options, async t => {
  const f = await quotaFixture(t, async (agent, task) => {
    if (agent.id === 'codex-2' && task.stage === 'implement') throw temporaryError();
  });
  const job = await f.team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(f.team, job.id, 'ready', 15000);
  const handover = f.team.events(job.id).find(e => e.type === 'HANDOVER');
  assert.equal(handover.details.from, 'codex-2');
  assert.equal(handover.details.to, 'codex-4');
  assert(handover.summary.endsWith(msg('srv.team.transient_switch', { provider: 'codex', status: '503', to: 'codex-4' }, job.lang)));
  assert.match(handover.details.reason, /503/);
  assert.equal(ready.tasks[0].ranBy, 'codex-4');
  assert.equal(retryEvents(f.team, job.id).length, 3);
  assert.equal(f.team.remaining('codex-2'), 100);
});

test('transient failover: pause cancels backoff immediately after releasing the slot', options, async t => {
  const f = await quotaFixture(t, async () => { throw temporaryError(); });
  f.config.transientRetryDelaysMs = [60_000, 180_000, 600_000];
  const job = await f.team.create({ project: 'test', goal: 'Update hello' });
  const timeout = Date.now() + 5000;
  while (!retryEvents(f.team, job.id).length && Date.now() < timeout) await new Promise(r => setTimeout(r, 10));
  assert.equal(retryEvents(f.team, job.id).length, 1);
  assert.equal(f.team.useOf('codex-1'), 0);
  assert.deepEqual(f.team.get(job.id).running, []);
  await f.team.control(job.id, 'pause');
  await settle(f.team, job.id, 'paused', 1000);
  assert.equal(f.seen.length, 1);
  assert.equal(f.team.providerDown('codex-1'), null);
});

test('transient failover: 429 keeps the quota handover path without transient retries', options, async t => {
  const f = await quotaFixture(t, async (agent, task) => {
    if (agent.id === 'codex-2' && task.stage === 'implement') throw new Error('unexpected status 429 Service Unavailable');
  });
  const job = await f.team.create({ project: 'test', goal: 'Update hello' });
  await settle(f.team, job.id, 'ready', 15000);
  assert.equal(retryEvents(f.team, job.id).length, 0);
  assert(f.team.events(job.id).some(e => e.type === 'HANDOVER'));
  assert.equal(f.team.remaining('codex-2'), 0);
  assert.equal(f.team.providerDown('codex-1'), null);
});
