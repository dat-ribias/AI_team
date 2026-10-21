import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { run } from '../src/process.js';

// Phản biện plan: mặc định mọi job code; rủi ro thấp/vừa dùng Claude + model rẻ, rủi ro cao dùng người phản biện thường.
async function fixture(t, { challenge, agents, risk = 'low', objections = [] } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'challenge-repo-')), data = mkdtempSync(join(tmpdir(), 'challenge-state-')), calls = [];
  let team;
  t.after(async () => { if (team) { team.runs.clear(); await team.close(); } for (const dir of [path, data]) rmSync(dir, { recursive: true, force: true }); });
  await run(['git'], ['init', '-b', 'main', path]);
  await run(['git'], ['-C', path, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=T', '-c', 'user.email=t@localhost', 'commit', '-m', 'init']);
  agents ||= [{ id: 'lead', provider: 'codex', model: 'gpt-x' }, { id: 'builder', provider: 'codex' }, { id: 'rev', provider: 'codex' }, { id: 'claude-1', provider: 'claude', model: 'opus', effort: 'high' }];
  team = new Team({ demo: true, peerDialogue: false, planApproval: false, maxRamPercent: 100, maxCpuPercent: 100, ...(challenge ? { challenge } : {}),
    agents: agents.map(a => ({ label: a.id, role: a.id, home: join(data, 'home-' + a.id), ...a })), pipeline: { manager: 'lead', builders: ['builder'], reviewer: 'rev', verifier: 'rev' },
    projects: [{ id: 'p', path, tests: [] }] }, data, { runAgent: async (agent, task) => {
      calls.push({ id: agent.id, model: agent.model, effort: agent.effort, stage: task.stage });
      if (task.stage === 'challenge') return { summary: 'checked', status: 'completed', objections };
      return { status: 'planned', summary: 'Plan', kind: 'code', risk, rigor: risk === 'high' ? 'strict' : 'standard', tasks: [{ agent: 'builder', difficulty: 2, instruction: 'Edit hello', files: ['hello.txt'], dependsOn: [] }] };
    } });
  team.kick = () => {};
  const job = await team.create({ project: 'p', goal: 'Update hello', paused: true });
  job.status = 'running'; team.save(job); team.runs.set(job.id, { agents: new Set(), abort: new AbortController() });
  return { team, job, calls };
}

test('default: a low-risk code plan is critiqued quickly by a Claude member running the cheap model', async t => {
  const { team, job, calls } = await fixture(t);
  await team.step(job); assert.equal(job.stage, 'challenge');
  await team.step(job);
  const c = calls.find(x => x.stage === 'challenge');
  assert.deepEqual(c, { id: 'claude-1', model: 'haiku', effort: undefined, stage: 'challenge' });
  assert.equal(job.stage, 'implement');
  assert.equal(job.challengeResult.quick, true); assert.equal(job.challengeResult.model, 'haiku'); assert.equal(job.challengeResult.serious, 0);
});

test('high risk keeps the full critic; serious objections send the plan back to the Lead', async t => {
  const { team, job, calls } = await fixture(t, { risk: 'high', objections: [{ id: 'F1', impact: 'high', claim: 'UI breaks', evidence: 'public/app.js:10' }] });
  await team.step(job); await team.step(job);
  const c = calls.find(x => x.stage === 'challenge');
  assert.notEqual(c.model, 'haiku', 'high-risk plans are not critiqued by the cheap model'); assert.notEqual(c.id, 'lead');
  assert.equal(job.stage, 'plan'); assert.equal(job.planReason, 'challenge');
  assert.equal(job.challengeResult.quick, undefined); assert.equal(job.challengeResult.serious, 1); assert.equal(job.challengeResult.objections[0].claim, 'UI breaks');
});

test('challenge "high" skips low-risk plans; no Claude member falls back to the lowest effort of another member', async t => {
  const high = await fixture(t, { challenge: 'high' });
  await high.team.step(high.job); assert.equal(high.job.stage, 'implement'); assert(!high.calls.some(x => x.stage === 'challenge'));
  const codexOnly = await fixture(t, { agents: [{ id: 'lead', provider: 'codex' }, { id: 'builder', provider: 'codex' }, { id: 'rev', provider: 'codex', effort: 'high' }] });
  await codexOnly.team.step(codexOnly.job); await codexOnly.team.step(codexOnly.job);
  const c = codexOnly.calls.find(x => x.stage === 'challenge');
  assert.notEqual(c.id, 'lead'); assert.equal(c.effort, 'low');
});
