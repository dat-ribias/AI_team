import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { UsageStore } from '../src/usage.js';

test('invoke records one accumulated usage row for every outcome', async t => {
  let outcome = 'ok';
  const config = { demo: true, maxRamPercent: 100, maxCpuPercent: 100,
    agents: [{ id: 'agent', label: 'Agent', provider: 'mock', model: 'mock-model' }],
    pipeline: { manager: 'agent', builders: ['agent'], reviewer: 'agent', verifier: 'agent' },
    projects: [{ id: 'project', path: process.cwd(), tests: [] }] };
  const team = new Team(config, mkdtempSync(join(tmpdir(), 'ai-team-usage-invoke-')), { runAgent: async (agent, task, prompt, opts) => {
    if (outcome === 'ok') {
      opts.onEvent('USAGE', { summary: 'first', details: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 } });
      opts.onEvent('USAGE', { summary: 'second', details: { input_tokens: 20, output_tokens: 7 } });
      return { summary: 'done', status: 'completed' };
    }
    if (outcome !== 'error') opts.onEvent('USAGE', { summary: 'partial', details: { total_tokens: 3 } });
    if (outcome === 'blocked') return { summary: 'blocked by dependency', status: 'blocked' };
    if (outcome === 'timeout') throw new Error('Process timed out');
    if (outcome === 'aborted') throw new DOMException('Cancelled', 'AbortError');
    throw new Error('provider failed');
  } });
  t.after(() => team.close());
  const job = { id: 'usage-job', project: 'project', sessionId: 'session-1', goal: 'Measure calls', kind: 'research', status: 'running', stage: 'plan',
    worktree: process.cwd(), revision: 'revision', roster: { manager: 'agent', builders: ['agent'], reviewer: 'agent', verifier: 'agent' }, dialogueMode: 'off',
    tasks: [], taskIndex: 0, reports: [], messages: [], round: 0, usage: { calls: 0, tokens: 0 } };
  team.save(job);

  const invoke = async expected => {
    outcome = expected;
    const run = { job: job.id, agents: new Set(), abort: new AbortController() };
    team.runs.set(job.id, run);
    try {
      if (expected === 'ok') await team.callOnce(job, 'agent', 'plan', 'test', undefined, [], { taskIndex: 0 });
      else await assert.rejects(team.callOnce(job, 'agent', 'plan', 'test', undefined, [], { taskIndex: 0 }));
    } finally { team.runs.delete(job.id); }
  };
  for (const result of ['ok', 'error', 'timeout', 'aborted', 'blocked']) await invoke(result);

  const rows = team.db.prepare('SELECT * FROM usage_log ORDER BY id').all();
  assert.equal(rows.length, 5, 'startup backfill must not duplicate the live call');
  assert.deepEqual(rows.map(row => row.result), ['ok', 'error', 'timeout', 'aborted', 'blocked']);
  assert.deepEqual(rows.map(row => row.taskIndex), [0, 0, 0, 0, 0]);
  assert(rows.every(row => row.job === job.id && row.project === job.project && row.session === job.sessionId));
  assert(rows.every(row => row.agent === 'agent' && row.provider === 'mock' && row.model === 'mock-model' && row.stage === 'plan'));
  assert(rows.every(row => row.durationMs >= 0 && /^\d{4}-\d{2}-\d{2}T/.test(row.at)));
  assert.deepEqual({ input: rows[0].inputTokens, output: rows[0].outputTokens, cached: rows[0].cachedTokens, total: rows[0].totalTokens, tokens: rows[0].tokens },
    { input: 30, output: 12, cached: 2, total: null, tokens: 42 });
  assert.deepEqual({ input: rows[1].inputTokens, output: rows[1].outputTokens, cached: rows[1].cachedTokens, total: rows[1].totalTokens, tokens: rows[1].tokens },
    { input: null, output: null, cached: null, total: null, tokens: null });
  assert.equal(job.usage.calls, 5);
  assert.equal(job.usage.tokens, 49, 'the existing job usage calculation remains unchanged');
});

async function reworkFixture(t) {
  let fail = false;
  const config = { demo: true, maxRamPercent: 100, maxCpuPercent: 100,
    agents: [{ id: 'agent', label: 'Agent', provider: 'mock', model: 'mock-model' }],
    pipeline: { manager: 'agent', builders: ['agent'], reviewer: 'agent', verifier: 'agent' },
    projects: [{ id: 'project', path: process.cwd(), tests: [] }] };
  const team = new Team(config, mkdtempSync(join(tmpdir(), 'ai-team-usage-rework-')), { runAgent: async (agent, task, prompt, opts) => {
    opts.onEvent('USAGE', { details: { total_tokens: 10 } });
    if (fail) throw new Error('provider failed');
    return { summary: 'done', status: 'completed', verdict: 'changes_requested', findings: [] };
  } });
  t.after(async () => { team.runs.clear(); await team.close(); });
  const job = { id: 'rework-job', project: 'project', sessionId: 'session-1', goal: 'Measure rework', kind: 'research', status: 'running', stage: 'plan',
    worktree: process.cwd(), revision: 'revision', roster: { manager: 'agent', builders: ['agent'], reviewer: 'agent', verifier: 'agent' }, dialogueMode: 'off',
    tasks: [], taskIndex: 0, reports: [], messages: [], round: 0, usage: { calls: 0, tokens: 0 } };
  team.save(job);
  team.runs.set(job.id, { job: job.id, agents: new Set(), abort: new AbortController() });
  team.captureEvidence = async () => {};
  team.call = team.callOnce.bind(team);
  for (const stage of ['implement', 'plan', 'research']) await team.callOnce(job, 'agent', stage, 'test');
  fail = true;
  await assert.rejects(team.callOnce(job, 'agent', 'implement', 'test'), /provider failed/);
  fail = false;
  return { team, job, store: new UsageStore(team.db) };
}

for (const trigger of ['test', 'review', 'verify']) {
  test(`${trigger} failure marks successful builds when runtime enters rework`, async t => {
    const { team, job, store } = await reworkFixture(t);
    team.testJob = async () => false;
    job.stage = trigger;
    await team.step(job);
    assert.equal(job.stage, 'rework');
    assert.equal(store.report().totals.wastedCalls, 1, 'builds remain current until the rework decision');
    await team.step(job);
    assert.equal(job.stage, 'plan');
    const rows = team.db.prepare('SELECT stage, result, reworked FROM usage_log ORDER BY id').all();
    assert.deepEqual(rows.slice(0, 4).map(row => row.reworked), [1, 0, 1, 0]);
    assert(rows.filter(row => ['plan', 'review', 'verify'].includes(row.stage)).every(row => row.reworked === 0));
    assert.equal(store.report().totals.wastedCalls, 3);
    assert.equal(store.report().totals.wastedTokens, 30);
    const totals = store.report().totals;
    job.stage = 'rework'; await team.step(job);
    assert.deepEqual(store.report().totals, totals, 'second rework does not count the same calls again');
  });
}

test('task review rejection marks successful builds before creating its fix task', async t => {
  const { team, job, store } = await reworkFixture(t);
  job.tasks = [{ kind: 'implement', done: true, ranBy: 'agent', base: 'before', commit: 'after', dependsOn: [], files: [] },
    { kind: 'review', instruction: 'review task', dependsOn: [0] }];
  assert.equal(await team.reviewNodes(job, job.roster, [[job.tasks[1], 1]]), true);
  assert.equal(job.tasks.length, 3); assert.equal(job.tasks[2].fixOf, 1);
  const rows = team.db.prepare('SELECT stage, result, reworked FROM usage_log ORDER BY id').all();
  assert.deepEqual(rows.map(row => row.reworked), [1, 0, 1, 0, 0]);
  assert.equal(rows[4].stage, 'review');
  assert.equal(store.report().totals.wastedCalls, 3); assert.equal(store.report().totals.wastedTokens, 30);
  const totals = store.report().totals;
  assert.equal(store.markReworked(job.id), 0);
  assert.deepEqual(store.report().totals, totals);
});
