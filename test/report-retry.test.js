import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Team } from '../src/team.js';
import { parseReport } from '../src/providers.js';
import { run } from '../src/process.js';

const completed = { summary: 'Checked', status: 'completed', verdict: 'approved', findings: [] };
const invalidReport = () => parseReport('Test suite gần xong..., đang chờ phần cuối');
const reminder = 'Lượt trước chưa trả JSON';
const testedRule = 'The controller already ran the full test suite on this revision';

async function fixture(t, agentRun, provider = 'codex', tested = true) {
  const root = mkdtempSync(join(tmpdir(), 'ai-team-report-retry-')), path = join(root, 'repo'), data = join(root, 'data');
  let team;
  t.after(async () => {
    if (team) await team.close();
    assert(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('ai-team-report-retry-'));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path); mkdirSync(data);
  await run(['git'], ['init', '-b', 'main', path]);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n', 'utf8');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, planApproval: false, peerDialogue: false, maxRamPercent: 100, maxCpuPercent: 100,
    resources: { reserveGB: 0, ramPerAgentGB: 0.01, maxAgents: 4, hardStopRamPercent: 100 },
    agents: ['codex-1', 'codex-2', 'codex-3', 'gemini'].map(id => ({ id, label: id, provider: 'mock' })),
    pipeline: { manager: 'codex-1', builders: ['codex-2'], reviewer: 'gemini', verifier: 'codex-3' },
    projects: [{ id: 'test', path, tests: [] }],
  };
  team = new Team(config, data, { runAgent: agentRun });
  team.kick = () => {};
  const job = await team.create({ project: 'test', goal: 'Recover a JSON report', paused: true });
  config.agents.find(a => a.id === 'gemini').provider = provider;
  Object.assign(job, { stage: 'review', status: 'queued', kind: 'code', rigor: 'standard', risk: 'low', tasks: [], tested: tested ? job.revision : null });
  team.save(job);
  return { team, job };
}

test('parseReport marks both invalid JSON and invalid report shapes for retry', () => {
  for (const text of ['abc', '{}', 'null', '[]']) assert.throws(() => parseReport(text), { code: 'REPORT_NOT_JSON' });
});

for (const provider of ['codex', 'claude', 'gemini', 'antigravity']) test(`review retries invalid JSON once with the same task and session (${provider})`, async t => {
  const calls = [];
  const { team, job } = await fixture(t, async (agent, task, prompt, opts) => {
    calls.push({ agent, task, prompt, opts });
    if (calls.length === 1) { opts.onEvent('SESSION', { summary: 'session', details: { id: 'sess-1' } }); return invalidReport(); }
    assert.equal(task.sessionId, 'sess-1');
    assert.match(prompt, new RegExp(reminder));
    assert.match(prompt, /Return ONLY valid JSON matching this structure:/);
    assert.deepEqual(task, { ...calls[0].task, sessionId: 'sess-1' });
    assert.equal(agent, calls[0].agent);
    assert.equal(opts.signal, calls[0].opts.signal); assert.equal(opts.onEvent, calls[0].opts.onEvent);
    if (['codex', 'claude'].includes(provider)) assert(prompt.startsWith(reminder));
    else { assert(prompt.startsWith(calls[0].prompt)); assert.equal(readFileSync(join(task.worktree, task.promptFile), 'utf8'), prompt); }
    return completed;
  }, provider);
  await team.runJob(job);
  const result = team.get(job.id);
  assert.notEqual(result.status, 'blocked'); assert.equal(result.stage, 'verify');
  assert.equal(calls.length, 2); assert.equal(result.usage.calls, 2);
  assert.match(calls[0].prompt, new RegExp(testedRule));
  assert.equal(team.events(job.id).filter(e => e.type === 'WARNING' && /not JSON/.test(e.summary)).length, 1);
});

test('review blocks after two invalid JSON reports without a third call', async t => {
  let calls = 0;
  const { team, job } = await fixture(t, async () => { calls++; return invalidReport(); });
  await team.runJob(job);
  const result = team.get(job.id);
  assert.equal(result.status, 'blocked'); assert.match(result.error, /must be JSON with a summary/);
  assert.equal(calls, 2); assert.equal(result.usage.calls, 2);
});

test('review without a valid session retries with the full prompt and leaves untested rules unchanged', async t => {
  const prompts = [];
  const { team, job } = await fixture(t, async (agent, task, prompt, opts) => {
    prompts.push(prompt);
    if (prompts.length === 1) { opts.onEvent('SESSION', { details: { id: '../invalid' } }); return invalidReport(); }
    assert.equal(task.sessionId, undefined); assert(prompt.startsWith(prompts[0]));
    return completed;
  }, 'codex', false);
  await team.runJob(job);
  assert.equal(prompts.length, 2); assert(!prompts[0].includes(testedRule));
  assert.notEqual(team.get(job.id).status, 'blocked');
});

test('review does not retry unrelated provider errors', async t => {
  let calls = 0;
  const { team, job } = await fixture(t, async () => { calls++; throw new Error('provider failed'); });
  await team.runJob(job);
  assert.equal(calls, 1); assert.equal(team.get(job.id).status, 'blocked');
  assert.match(team.get(job.id).error, /provider failed/);
});
