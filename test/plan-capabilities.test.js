import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { describeCapabilities, roleRules } from '../src/capabilities.js';
import { run } from '../src/process.js';
import { msg } from '../src/i18n.js';

async function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-plan-check-'));
  await run(['git'], ['init', '-b', 'main', path]);
  await run(['git'], ['-C', path, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  writeFileSync(join(path, '.gitignore'), '.ai-team/\n');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, planApproval: false, maxRamPercent: 100, maxCpuPercent: 100,
    agents: ['codex-1', 'codex-2', 'codex-3', 'gemini'].map(id => ({ id, label: id, role: id, provider: 'mock' })),
    pipeline: { manager: 'codex-1', builders: ['codex-2'], reviewer: 'gemini', verifier: 'codex-3' },
    projects: [{ id: 'test', path, tests: [] }],
  };
  const team = new Team(config, mkdtempSync(join(tmpdir(), 'ai-team-plan-state-')));
  t.after(() => team.close());
  return team;
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

const researchPlan = (kind = 'research', files = ['.ai-team/evidence/x.png']) => ({
  summary: 'Investigate and save evidence', kind: 'research', rigor: 'light', risk: 'low',
  tasks: [{ kind, agent: 'codex-2', difficulty: 2, instruction: 'Investigate the greeting', files, dependsOn: [] }],
});
const completed = { summary: 'Checked', status: 'completed', verdict: 'approved', findings: [] };

test('plan capabilities: contradictory goal asks the owner without dispatching tasks', async t => {
  const team = await fixture(t), calls = [];
  team.agentRun = async (agent, task, prompt) => {
    calls.push(task.stage);
    assert.equal(task.stage, 'plan');
    assert(prompt.includes(describeCapabilities()));
    assert(prompt.includes(`Permissions: ${roleRules('code', 'manager')}`));
    assert.match(prompt, /Permission matrix the controller enforces/);
    assert.match(prompt, /chỉ đọc.*read-only/);
    assert.match(prompt, /1-5 specific questions for the owner and no tasks/);
    assert.match(prompt, /research job uses research tasks, never implement tasks/);
    return { summary: 'The goal contradicts itself', status: 'needs_input', questions: ['Bạn muốn chỉ đọc hay cho phép sửa src/x.js?'] };
  };
  const job = await team.create({ project: 'test', goal: 'chỉ đọc, không sửa code nhưng hãy sửa src/x.js' });
  const waiting = await settle(team, job.id, 'waiting');
  assert.equal(waiting.questions.length, 1); assert.deepEqual(waiting.tasks, []);
  assert.deepEqual(calls, ['plan']);
  assert(team.events(job.id).some(e => e.type === 'QUESTION' && e.to === 'user'));
});

test('plan capabilities: rejected research plan retries once then waits, with no task run', async t => {
  const team = await fixture(t), prompts = [], calls = [];
  team.agentRun = async (agent, task, prompt) => {
    calls.push(task.stage); prompts.push(prompt);
    assert.equal(task.stage, 'plan');
    if (prompts.length === 2) {
      assert.equal(task.planRejects, 1); assert.deepEqual(task.tasks, []);
      assert.equal(task.stage, 'plan');
      const warnings = team.events(task.id).filter(e => e.type === 'WARNING');
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].from, 'controller'); assert.equal(warnings[0].to, 'codex-1');
      assert.deepEqual(warnings[0].details.violations, task.planViolations);
    }
    return researchPlan('implement', ['src/x.js']);
  };
  const job = await team.create({ project: 'test', goal: 'Research the greeting' });
  const waiting = await settle(team, job.id, 'waiting');
  assert.deepEqual(calls, ['plan', 'plan']); assert.deepEqual(waiting.tasks, []);
  assert(!prompts[0].includes('"planRejected"'));
  assert.match(prompts[1], /"planRejected":/);
  assert.match(prompts[1], /The controller rejected your previous plan for violating the permission matrix/);
  assert.match(prompts[1], /src\/x\.js/);
  const warnings = team.events(job.id).filter(e => e.type === 'WARNING');
  assert.equal(warnings.length, 2);
  assert(warnings.every(e => e.details.violations.length === 2));
  assert.equal(waiting.planRejects, 0);
  assert.deepEqual(waiting.questions, [msg('srv.team.plan_rejected_ask', { 0: warnings[1].details.violations.join('\n') })]);
  assert(team.events(job.id).some(e => e.type === 'QUESTION' && e.from === 'controller' && e.to === 'user'));
});

test('plan capabilities: valid research evidence plan runs with builder permissions', async t => {
  const team = await fixture(t), calls = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
  team.agentRun = async (agent, task, prompt) => {
    calls.push(task.stage);
    if (task.stage === 'plan') return researchPlan();
    assert.equal(task.stage, 'research');
    assert(prompt.includes(`Permissions: ${roleRules('research', 'builder')}`));
    assert(!prompt.includes('Do not edit files.'));
    assert(!prompt.includes('Read-only analysis: do not edit files'));
    mkdirSync(join(task.worktree, '.ai-team', 'evidence'), { recursive: true });
    writeFileSync(join(task.worktree, '.ai-team', 'evidence', 'x.png'), png);
    return { ...completed, conclusion: 'Evidence saved', sources: ['.ai-team/evidence/x.png'] };
  };
  const job = await team.create({ project: 'test', goal: 'Research the greeting and save evidence' });
  const done = await settle(team, job.id, 'done');
  assert.deepEqual(calls, ['plan', 'research']); assert.equal(done.kind, 'research');
  assert.equal(done.tasks[0].done, true); assert.equal(done.planRejects, 0);
  assert.equal(done.revision, done.base); assert.equal(done.conclusion.conclusion, 'Evidence saved');
  const archive = done.evidence.find(e => e.stage === 'research');
  assert.deepEqual(readFileSync(join(team.dataDir, 'evidence', job.id, archive.dir, '.ai-team', 'evidence', 'x.png')), png);
  assert.ok(done.cleanedAt); assert.equal(existsSync(done.worktree), false);
  assert(!team.events(job.id).some(e => e.type === 'WARNING'));
});

test('plan capabilities: accepting a corrected retry clears previous violations', async t => {
  const team = await fixture(t); let plans = 0;
  team.agentRun = async (agent, task, prompt) => {
    if (task.stage !== 'plan') return completed;
    if (++plans === 1) return researchPlan('implement', ['src/x.js']);
    assert.equal(task.planRejects, 1); assert.match(prompt, /"planRejected":/);
    return researchPlan();
  };
  const job = await team.create({ project: 'test', goal: 'Research the greeting' });
  const done = await settle(team, job.id, 'done');
  assert.equal(plans, 2); assert.equal(done.planRejects, 0); assert.equal(done.planViolations, undefined);
  assert.equal(team.events(job.id).filter(e => e.type === 'WARNING').length, 1);
});
