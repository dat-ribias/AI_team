import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { Accounts } from '../src/accounts.js';
import { msg } from '../src/i18n.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const quota = (remaining = 80) => ({ buckets: [{ id: 'usage', name: 'usage', windows: [{ name: '5h', remaining, minutes: 300 }] }] });
const untilAbort = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));

function fixture(t, { providers = ['codex', 'codex', 'codex'], ...overrides } = {}, adapters = {}) {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-quota-'));
  const agents = providers.map((provider, i) => {
    const id = provider === 'claude' ? 'claude-x' : `${provider}-${i + 1}`, home = join(path, id);
    mkdirSync(home);
    return { id, label: id, role: id, provider, home };
  });
  const config = { demo: providers.includes('mock'), agents,
    pipeline: { manager: agents[0].id, builders: [agents[0].id], reviewer: agents[0].id, verifier: agents[0].id },
    projects: [{ id: 'test', path, tests: [] }], ...overrides };
  const team = new Team(config, join(path, 'state'), adapters);
  t.after(async () => { await team.close(); rmSync(path, { recursive: true, force: true }); });
  return team;
}

test('quota refresh runs three reads in parallel and emits each result immediately', async t => {
  const active = new Set(), changes = []; let peak = 0;
  const team = fixture(t, {}, { readQuota: async agent => {
    active.add(agent.id); peak = Math.max(peak, active.size);
    await wait({ 'codex-1': 50, 'codex-2': 100, 'codex-3': 300 }[agent.id]);
    active.delete(agent.id); return quota();
  } });
  team.on('change', () => changes.push(structuredClone(team.state().quotaCheck)));
  const start = performance.now(), result = await team.refreshQuota(), elapsed = performance.now() - start;
  t.diagnostic(`parallel refresh: ${elapsed.toFixed(1)} ms; peak readers: ${peak}`);
  assert(elapsed < 600); assert.equal(peak, 3);
  assert.equal(result.done, 3); assert.equal(result.total, 3); assert.equal(result.running, false);
  assert(result.startedAt); assert(result.finishedAt);
  assert(Object.values(result.members).every(m => m.status === 'ok' && m.at));
  assert.equal(changes[0].done, 0); assert.equal(changes[0].running, true);
  assert(Object.values(changes[0].members).every(m => m.status === 'checking' && m.at === null));
  assert(changes.some(c => c.running && c.done === 1 && c.members['codex-2'].status === 'checking'));
  assert(changes.some(c => c.running && c.done === 2 && c.members['codex-3'].status === 'checking'));
  assert.equal(changes.at(-1).running, false);
  assert.equal(team.db.prepare('SELECT COUNT(*) AS n FROM quota_history').get().n, 3);
});

test('a hung member times out without blocking other quotas', async t => {
  const team = fixture(t, { quotaReadTimeoutSec: 0.2 }, { readQuota: async (agent, { signal }) => {
    if (agent.id === 'codex-1') return untilAbort(signal);
    await wait(20); return quota();
  } });
  const result = await team.refreshQuota();
  assert.equal(result.members['codex-1'].status, 'timeout'); assert.equal(result.members['codex-1'].reason, 'timeout');
  for (const id of ['codex-2', 'codex-3']) {
    assert.equal(result.members[id].status, 'ok'); assert.equal(team.quota(id).buckets[0].windows[0].remaining, 80);
  }
  assert.equal(result.done, 3); assert.equal(team.refreshing, false);
});

test('a provider error is redacted and bounded without affecting other members', async t => {
  const team = fixture(t, {}, { readQuota: async agent => {
    if (agent.id === 'codex-1') throw new Error('api_key=example-secret-value ' + 'failure '.repeat(50));
    return quota();
  } });
  const result = await team.refreshQuota(), failed = result.members['codex-1'];
  assert.equal(failed.status, 'error'); assert.equal(failed.reason.length, 200);
  assert.match(failed.reason, /api_key=\[REDACTED\]/); assert(!failed.reason.includes('example-secret-value'));
  assert.equal(team.quota('codex-1').status, 'unknown');
  for (const id of ['codex-2', 'codex-3']) assert.equal(result.members[id].status, 'ok');
});

test('idle Claude uses its adapter; busy Claude preserves observed quotas', async t => {
  let calls = 0;
  const team = fixture(t, { providers: ['codex', 'claude'] }, { readQuota: async () => quota(), claudeUsage: async id => {
    calls++; team.saveObserved(id, quota(65).buckets); return { parsed: true };
  } });
  const idle = await team.refreshQuota();
  assert.equal(calls, 1); assert.equal(idle.members['claude-x'].status, 'ok');
  const observed = team.quota('claude-x');
  assert.equal(observed.buckets[0].windows[0].remaining, 65);
  team.isBusy = id => id === 'claude-x';
  const busy = await team.refreshQuota();
  assert.equal(calls, 1); assert.equal(busy.members['claude-x'].status, 'skipped-busy');
  assert.equal(busy.members['claude-x'].observedAt, observed.checkedAt);
  assert.deepEqual(team.quota('claude-x'), observed);
});

test('a second refresh returns current progress without starting duplicate reads', async t => {
  let calls = 0;
  const release = Promise.withResolvers();
  const team = fixture(t, {}, { readQuota: async () => { calls++; await release.promise; return quota(); } });
  const first = team.refreshQuota();
  try {
    const current = await team.refreshQuota();
    assert.equal(current, team.quotaCheck); assert.equal(current.running, true); assert(current.done < current.total);
    assert.equal(calls, 3);
  } finally { release.resolve(); }
  await first; assert.equal(calls, 3);
});

test('the round deadline times out running and queued members and releases refreshing', async t => {
  const calls = [];
  const team = fixture(t, { providers: ['codex', 'codex', 'codex', 'codex', 'codex'], quotaReadTimeoutSec: 60, quotaRefreshMaxSec: 0.3 },
    { readQuota: (agent, { signal }) => { calls.push(agent.id); return untilAbort(signal); } });
  const start = performance.now(), result = await team.refreshQuota(), elapsed = performance.now() - start;
  t.diagnostic(`round deadline: ${elapsed.toFixed(1)} ms; started readers: ${calls.length}`);
  assert(elapsed >= 250 && elapsed < 800);
  assert.equal(calls.length, 3); assert.equal(result.done, 5); assert.equal(result.running, false); assert.equal(team.refreshing, false);
  assert(Object.values(result.members).every(m => m.status === 'timeout' && m.reason && m.at));
  await team.close(); assert.equal(team.dbClosed, true);
});

test('the worker pool never starts more than three readers', async t => {
  let active = 0, peak = 0, calls = 0;
  const team = fixture(t, { providers: Array(7).fill('codex') }, { readQuota: async () => {
    calls++; active++; peak = Math.max(peak, active); await wait(20); active--; return quota();
  } });
  const result = await team.refreshQuota();
  assert.equal(calls, 7); assert.equal(peak, 3); assert.equal(result.done, 7);
  assert(Object.values(result.members).every(m => m.status === 'ok'));
});

test('late results do not overwrite a newer round after the round deadline', async t => {
  const late = Promise.withResolvers(); let calls = 0;
  const team = fixture(t, { providers: ['codex'], quotaReadTimeoutSec: 60, quotaRefreshMaxSec: 0.05 },
    { readQuota: () => ++calls === 1 ? late.promise : Promise.resolve(quota(75)) });
  const first = await team.refreshQuota();
  assert.equal(first.members['codex-1'].status, 'timeout');
  const second = await team.refreshQuota();
  late.resolve(quota(5)); await wait(20);
  assert.equal(second.members['codex-1'].status, 'ok'); assert.equal(first.members['codex-1'].status, 'timeout');
  assert.equal(team.quota('codex-1').buckets[0].windows[0].remaining, 75);
  assert.equal(team.db.prepare('SELECT COUNT(*) AS n FROM quota_history').get().n, 1);
});

test('mock and busy providers report explicit outcomes without reading', async t => {
  const calls = [];
  const team = fixture(t, { providers: ['mock', 'antigravity', 'codex', 'codex'] },
    { readQuota: async agent => { calls.push(agent.id); return quota(); } });
  team.isBusy = () => true; team.sqliteOverride = id => id === 'codex-3' ? 'sqlite_home' : null;
  const result = await team.refreshQuota();
  assert.equal(result.members['mock-1'].status, 'error'); assert.equal(result.members['mock-1'].reason, msg('srv.team.demo_khong_co_quota_that'));
  assert.equal(team.quota('mock-1').error, msg('srv.team.demo_khong_co_quota_that'));
  assert.equal(result.members['antigravity-2'].status, 'skipped-busy'); assert.equal(result.members['antigravity-2'].observedAt, null);
  assert.equal(result.members['codex-3'].status, 'skipped-busy'); assert.equal(result.members['codex-4'].status, 'ok');
  assert.deepEqual(calls, ['codex-4']); assert.equal(result.done, 4);
});

test('Claude without an adapter keeps the existing explanatory note', async t => {
  const team = fixture(t, { providers: ['claude'] });
  const result = await team.refreshQuota();
  assert.equal(result.members['claude-x'].status, 'skipped-busy'); assert.equal(result.members['claude-x'].reason, 'no-reader');
  assert.equal(result.members['claude-x'].observedAt, null);
  assert.equal(team.quota('claude-x').note, msg('srv.team.claude_cli_chua_co_lenh_doc'));
});

test('Claude parse failures, exceptions and timeouts preserve observed quotas', async t => {
  const team = fixture(t, { providers: ['claude'], quotaReadTimeoutSec: 0.03 });
  team.saveObserved('claude-x', quota(65).buckets);
  const observed = team.quota('claude-x');
  for (const [adapter, status] of [
    [async () => ({ parsed: false, text: 'api_key=example-secret-value ' + 'unparsed '.repeat(50) }), 'error'],
    [async () => { throw new Error('adapter failed'); }, 'error'],
    [(_, { signal }) => untilAbort(signal), 'timeout'],
  ]) {
    team.claudeUsage = adapter;
    const result = await team.refreshQuota(), entry = result.members['claude-x'];
    assert.equal(entry.status, status); assert(entry.reason.length <= 200); assert(!entry.reason.includes('example-secret-value'));
    assert.deepEqual(team.quota('claude-x'), observed);
  }
});

test('member timeouts abort reads and wait for cleanup before reusing slots or refreshing', async t => {
  let active = 0, peak = 0;
  const signals = [], events = [];
  const team = fixture(t, { providers: Array(5).fill('codex'), quotaReadTimeoutSec: 0.03 }, {
    readQuota: (agent, { signal }) => new Promise((_, reject) => {
      active++; peak = Math.max(peak, active); signals.push(signal); events.push('start');
      signal.addEventListener('abort', () => setTimeout(() => {
        active--; events.push('settled'); reject(signal.reason);
      }, 40), { once: true });
    }),
  });
  for (let round = 0; round < 2; round++) {
    const result = await team.refreshQuota();
    assert.equal(active, 0); assert.equal(team.refreshing, false);
    assert(Object.values(result.members).every(m => m.status === 'timeout'));
    assert(signals.every(signal => signal.aborted));
    assert.equal(events.at(-1), 'settled');
  }
  assert.equal(signals.length, 10); assert.equal(peak, 3);
  t.diagnostic(`two timeout rounds: ${signals.length} aborted reads; peak readers: ${peak}; active after cleanup: ${active}`);
});

test('the round deadline aborts all active adapters before a new round starts', async t => {
  const signals = []; let active = 0;
  const team = fixture(t, { providers: Array(5).fill('codex'), quotaReadTimeoutSec: 60, quotaRefreshMaxSec: 0.04 }, {
    readQuota: (_, { signal }) => new Promise((_, reject) => {
      active++; signals.push(signal);
      signal.addEventListener('abort', () => setTimeout(() => { active--; reject(signal.reason); }, 30), { once: true });
    }),
  });
  const first = team.refreshQuota(); await wait(55);
  assert.equal(team.refreshing, true);
  assert.equal((await team.refreshQuota()).running, true); assert.equal(signals.length, 3);
  const result = await first;
  assert.equal(active, 0); assert(signals.every(signal => signal.aborted));
  assert.equal(result.done, 5); assert(Object.values(result.members).every(m => m.status === 'timeout'));
  team.quotaRead = async () => quota();
  assert.equal((await team.refreshQuota()).done, 5);
});

test('closing a team aborts quota reads without waiting for the member timeout', async t => {
  const signals = [];
  const team = fixture(t, {}, { readQuota: (_, { signal }) => { signals.push(signal); return untilAbort(signal); } });
  const refresh = team.refreshQuota(); await wait(10);
  const start = performance.now(); await team.close(); await refresh;
  assert(signals.every(signal => signal.aborted)); assert.equal(signals.length, 3);
  assert.equal(team.refreshing, false); assert.equal(team.dbClosed, true);
  assert(performance.now() - start < 1000);
});

test('Accounts.usage reports a fresh parse failure while retaining observed Claude quota', async t => {
  const team = fixture(t, { providers: ['claude'] });
  const agent = team.agent('claude-x'), script = join(agent.home, 'usage-fixture.cjs');
  writeFileSync(script, 'console.log(JSON.stringify({ type: "result", result: "No usage buckets" }));');
  const accounts = new Accounts(team);
  t.after(() => accounts.close()); accounts.command = () => [process.execPath, script];
  team.saveObserved(agent.id, quota(65).buckets);
  const observed = team.quota(agent.id);
  const result = await accounts.usage(agent.id);
  assert.equal(result.parsed, false); assert.deepEqual(result.buckets, []);
  assert.deepEqual(team.quota(agent.id), observed);
  team.claudeUsage = (id, opts) => accounts.usage(id, opts);
  const check = await team.refreshQuota();
  assert.equal(check.members[agent.id].status, 'error'); assert(check.members[agent.id].reason);
  assert.deepEqual(team.quota(agent.id), observed);
  writeFileSync(script, 'console.log(JSON.stringify({ type: "result", result: "Current session 20% used" }));');
  assert.equal((await accounts.usage(agent.id)).parsed, true);
  assert.equal(team.quota(agent.id).buckets[0].windows[0].remaining, 80);
});

test('Accounts.usage forwards abort to the child and rejects before saving observed quota', async t => {
  const team = fixture(t, { providers: ['claude'] });
  const agent = team.agent('claude-x'), script = join(agent.home, 'usage-fixture.cjs');
  writeFileSync(script, 'setInterval(() => {}, 1000);');
  const accounts = new Accounts(team), controller = new AbortController(), reason = new Error('test cancellation');
  t.after(() => accounts.close()); accounts.command = () => [process.execPath, script];
  team.saveObserved(agent.id, quota(65).buckets); const observed = team.quota(agent.id);
  const pending = accounts.usage(agent.id, { signal: controller.signal });
  const rejection = assert.rejects(pending, error => error === reason);
  await wait(100); controller.abort(reason); await rejection;
  assert.deepEqual(team.quota(agent.id), observed);
  await assert.rejects(accounts.usage(agent.id, { signal: controller.signal }), error => error === reason);
});

test('closed teams and account login return null without starting a refresh', async t => {
  const team = fixture(t);
  assert.equal(team.state().quotaCheck, null);
  team.accountLoginBusy = true; assert.equal(await team.refreshQuota(), null); assert.equal(team.refreshing, false);
  team.accountLoginBusy = false; await team.close(); assert.equal(await team.refreshQuota(), null);
});
