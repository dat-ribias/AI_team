import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team, computeSlots } from '../src/team.js';
import { msg } from '../src/i18n.js';

const cpu = (total, idle) => ({ times: { user: total - idle, nice: 0, sys: 0, idle, irq: 0 } });

function fixture(t, initial = [cpu(1000, 500)]) {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-resources-'));
  let at = 0, counters = initial, reads = 0;
  const timers = [];
  t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    const timer = { callback, delay, cleared: false, referenced: true, unrefCalls: 0,
      unref() { this.referenced = false; this.unrefCalls++; return this; },
      hasRef() { return this.referenced; } };
    timers.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearInterval', timer => { if (timer) timer.cleared = true; });
  const config = { demo: true, maxCpuPercent: 100,
    resources: { reserveGB: 0, ramPerAgentGB: 0.001, maxAgents: 1, hardStopRamPercent: 100 },
    agents: [{ id: 'mock-1', provider: 'mock' }],
    projects: [{ id: 'test', path, tests: [] }] };
  const team = new Team(config, join(path, 'state'), {
    cpus: () => { reads++; return counters; }, resourceNow: () => at,
  });
  t.after(async () => { try { await team.close(); } finally { rmSync(path, { recursive: true, force: true }); } });
  const advance = ms => { at += ms; team.resourceTimer.callback(); };
  return { team, timers, reads: () => reads,
    counters: value => { counters = value; },
    elapse: ms => { at += ms; },
    advance,
    sample(total, idle, ms = 5000) { counters = [cpu(total, idle)]; advance(ms); },
  };
}

test('CPU state and capacity reads never collect samples or advance the baseline', t => {
  const f = fixture(t), { team } = f;
  assert.equal(f.reads(), 1);
  assert.equal(team.cpuSamples.length, 0);
  f.sample(2000, 1200);
  const baseline = team.cpu, samples = structuredClone(team.cpuSamples);
  f.counters([cpu(2100, 1200)]);
  for (let i = 0; i < 20; i++) {
    assert.equal(team.state().resources.cpuPercent, 30);
    assert(team.capacity().start > 0);
    assert.equal(team.sampleResources().cpuPercent, 30);
  }
  assert.equal(f.reads(), 2);
  assert.equal(team.cpu, baseline);
  assert.deepEqual(team.cpuSamples, samples);
  f.elapse(5000);
  assert.equal(team.state().resources.cpuPercent, 30);
  team.capacity();
  assert.equal(f.reads(), 2);
  assert.equal(team.cpu, baseline);
  assert.deepEqual(team.cpuSamples, samples);
});

test('CPU callbacks before five seconds do not collect a sample', t => {
  const f = fixture(t), { team } = f, baseline = team.cpu;
  f.sample(3000, 1900, 4999);
  assert.equal(f.reads(), 1);
  assert.equal(team.cpu, baseline);
  assert.deepEqual(team.cpuSamples, []);
  f.sample(3000, 1900, 1);
  assert.equal(f.reads(), 2);
  assert.deepEqual(team.cpuSamples, [{ busy: 600, total: 2000 }]);
});

test('CPU startup is only a baseline, including counters starting at zero', t => {
  const f = fixture(t, [cpu(0, 0)]), { team } = f;
  assert.equal(team.cpuPercent, 0);
  assert.deepEqual(team.cpuSamples, []);
  f.sample(0, 0);
  assert.equal(team.cpuPercent, 0);
  assert.deepEqual(team.cpuSamples, []);
  f.sample(1000, 100);
  assert.equal(team.sampleResources().cpuPercent, 90);
  assert.deepEqual(team.cpuSamples, [{ busy: 900, total: 1000 }]);
});

test('CPU uses the total busy/total delta across all processors', t => {
  const f = fixture(t, [cpu(600, 100), cpu(400, 200)]);
  f.counters([cpu(1100, 450), cpu(900, 550)]);
  f.advance(4999);
  assert.equal(f.reads(), 1);
  f.advance(1);
  assert.equal(f.team.sampleResources().cpuPercent, 30);
});

test('CPU window keeps six valid intervals, weights deltas and evicts the oldest', t => {
  const f = fixture(t, [cpu(0, 0)]), { team } = f;
  f.sample(1000, 1000); // idle first interval
  for (let i = 1; i <= 5; i++) f.sample(1000 + i * 100, 1000);
  assert.equal(team.cpuSamples.length, 6);
  assert(Math.abs(team.cpuPercent - 100 / 3) < 1e-10);
  assert.equal(team.sampleResources().cpuPercent, 33);
  f.sample(1600, 1000);
  assert.equal(team.cpuSamples.length, 6);
  assert.equal(team.sampleResources().cpuPercent, 100);
  assert.deepEqual(team.cpuSamples, Array.from({ length: 6 }, () => ({ busy: 100, total: 100 })));
});

test('CPU skips zero, reset, impossible and non-finite deltas without poisoning the average', t => {
  const f = fixture(t), { team } = f;
  f.sample(2000, 1200);
  const expected = [{ busy: 300, total: 1000 }];
  for (const [total, idle] of [[2000, 1200], [1000, 500], [1100, 700], [1200, 600], [NaN, 600], [Infinity, 600]]) {
    f.sample(total, idle);
    assert.deepEqual(team.cpuSamples, expected);
    assert.equal(team.sampleResources().cpuPercent, 30);
    assert(Number.isFinite(team.cpuPercent));
    assert(team.cpuPercent >= 0 && team.cpuPercent <= 100);
  }
  f.sample(2200, 1300);
  assert.deepEqual(team.cpuSamples, [...expected, { busy: 300, total: 1000 }]);
});

test('CPU gate uses the unrounded window average rather than the last interval', t => {
  const f = fixture(t, [cpu(0, 0)]), { team } = f;
  team.config.maxCpuPercent = 60;
  f.sample(1000, 1000);
  f.sample(2000, 1000); // latest is 100%, average is 50%
  assert.equal(team.cpuPercent, 50);
  assert(team.capacity().start > 0);
  f.sample(3000, 1000);
  assert.equal(team.capacity().start, 0);
  assert.equal(team.capacity().reason, msg('srv.team.cpu_cao_cho_tai_nguyen'));
  team.config.maxCpuPercent = 70;
  f.sample(4000, 2000); // latest is 0%, average is 50%
  assert(team.capacity().start > 0);
  team.config.maxCpuPercent = 49.9;
  assert.equal(team.capacity().start, 0);
});

test('CPU gate does not round an average down to the configured limit', t => {
  const f = fixture(t, [cpu(0, 0)]), { team } = f;
  team.config.maxCpuPercent = 50;
  f.sample(1000, 496);
  assert.equal(team.state().resources.cpuPercent, 50);
  assert.equal(team.capacity().start, 0);
  team.config.maxCpuPercent = 50.4;
  assert(team.capacity().start > 0);
});

test('CPU timer is fixed at five seconds, unrefed, created once and stopped on close', async t => {
  const f = fixture(t), { team } = f, timer = team.resourceTimer;
  assert.equal(timer.delay, 5000);
  assert.equal(timer.unrefCalls, 1);
  assert.equal(timer.hasRef(), false);
  t.mock.method(team, 'tick', async () => {});
  t.mock.method(team, 'autoBackup', () => {});
  t.mock.method(team, 'cleanup', async () => {});
  t.mock.method(team, 'sweepGit', async () => {});
  t.mock.method(team, 'kick', () => {});
  team.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.timers.filter(timer => timer.delay === 5000).length, 1);
  const reads = f.reads(), baseline = team.cpu;
  await team.close();
  assert(f.timers.every(timer => timer.cleared));
  f.sample(2000, 1200);
  team.sampleCpu();
  assert.equal(f.reads(), reads);
  assert.equal(team.cpu, baseline);
  await team.close();
  assert.equal(team.dbClosed, true);
});

test('maxAgents is advisory by default and only literal true restores the hard cap', () => {
  const options = { freeGB: 20, totalGB: 32, running: 9, maxAgents: 3 };
  for (const maxAgentsHard of [undefined, false, 'true', 1]) {
    assert.deepEqual(computeSlots({ ...options, maxAgentsHard }), { start: 10, hardStop: false });
  }
  assert.deepEqual(computeSlots({ ...options, maxAgentsHard: true }), { start: 0, hardStop: false });
  assert.equal(computeSlots({ ...options, running: 2, maxAgentsHard: true }).start, 1);
});

test('RAM fit, reserve, idle minimum and hard stop still apply with an advisory maxAgents', () => {
  assert.deepEqual(computeSlots({ freeGB: 10, totalGB: 32, maxAgents: 3 }), { start: 4, hardStop: false });
  assert.equal(computeSlots({ freeGB: 4.5, totalGB: 32 }).start, 1);
  assert.equal(computeSlots({ freeGB: 4.5, totalGB: 32, running: 1 }).start, 0);
  for (const maxAgentsHard of [false, true]) {
    assert.deepEqual(computeSlots({ freeGB: 3, totalGB: 32, maxAgentsHard }), { start: 0, hardStop: true });
  }
});

test('capacity forwards maxAgentsHard and retains the RAM hard stop', t => {
  const { team } = fixture(t);
  team.extra = 2;
  assert(team.capacity().start > 0);
  team.config.resources.maxAgentsHard = true;
  assert.equal(team.capacity().start, 0);
  team.config.resources.maxAgentsHard = false;
  assert(team.capacity().start > 0);
  team.config.resources.hardStopRamPercent = 0;
  assert.equal(team.capacity().start, 0);
  assert.equal(team.capacity().hardStop, true);
  assert.equal(team.capacity().reason, msg('srv.team.ram_cao_cho_tai_nguyen'));
  team.extra = 0;
});
