import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team, validateConfig, redact, routeGoal, compressOutput, computeSlots } from '../src/team.js';
import { testList } from '../src/accounts.js';
import { run, childEnv } from '../src/process.js';
import { parseReport, normalizeCodexQuota, normalizeGoogleQuota, runAgent } from '../src/providers.js';
import { exportTransfer, importTransfer } from '../src/transfer.js';
import { fileHash, MemoryStore } from '../src/memory.js';
import { ledger, question, answer, decide, refreshLedger } from '../src/discussions.js';

async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-check-'));
  await run(['git'], ['init', '-b', 'main', path]);
  // Fixture expectations use LF regardless of the machine's global Git setting.
  await run(['git'], ['-C', path, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, maxRamPercent: 100, maxCpuPercent: 100,
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

test('discussion ledger rejects mismatched replies/stale evidence and keeps outstanding claims', () => {
  const d = ledger({ id: 'D-test', from: 'a', topic: 'Contract', messages: [], status: 'pending' }), s = { fingerprint: 'v1' };
  question(d, { question: 'Check both', claims: [{ statement: 'Second claim' }], claimIds: ['C1','C2'], evidence: ['hello.txt:1'] }, s, 'a');
  assert.throws(() => answer(d, { replyTo: 'M99', answer: 'yes' }, s, 'b'), /pending message/);
  assert.throws(() => answer(d, { claimIds: ['C1'], answer: 'yes' }, s, 'b'), /every requested/);
  answer(d, { replyTo: 'M1', claimIds: ['C1','C2'], answer: 'Both checked', evidence: ['contract:1'] }, s, 'b');
  assert.equal(d.messages[1].replyTo, 'M1'); assert.equal(d.messages[0].delivery, 'answered');
  assert(!decide(d, { thread: d.id, outcome: 'accepted', reason: 'Partial', claimIds: ['C1'], evidenceIds: ['E1'] }, s, 'a'));
  assert(!decide(d, { thread: d.id, outcome: 'accepted', reason: 'Conditional', claimIds: ['C2'], evidenceIds: ['E2'], remaining: ['Check Unicode'] }, s, 'a'));
  assert.throws(() => decide(d, { thread: d.id, outcome: 'accepted', reason: 'Invalid obligations', remaining: 'Still needs Unicode' }, s, 'a'), /obligations must be arrays/);
  refreshLedger(d, { fingerprint: 'v2' });
  assert.throws(() => decide(d, { thread: d.id, outcome: 'rejected', reason: 'Old proof', evidenceIds: ['E2'] }, { fingerprint: 'v2' }, 'a'), /stale evidence/);
  assert(decide(d, { thread: d.id, outcome: 'rejected', reason: 'Fresh proof', claimIds: ['C1','C2'], evidence: ['Current contract'], conditions: ['ASCII only'] }, { fingerprint: 'v2' }, 'a'));
});

test('independent dialogue, content freshness, ownership handover and separate quality judgments', async t => {
  const f = await fixture(), seen = [], team = new Team(f.config, f.data); team.closed = true; t.after(async () => { team.runs.clear(); await team.close(); });
  const job = await team.create({ project: 'test', goal: 'Update hello', dialogueMode: 'independent', paused: true });
  await team.ensureExclude(job.worktree); mkdirSync(join(job.worktree, '.ai-team'), { recursive: true }); writeFileSync(join(job.worktree, '.ai-team', 'prompt.md'), 'UNIQUE_PEER_CLAIM');
  job.tasks = [{ instruction: 'Check greeting', files: ['hello.txt'], difficulty: 2 }];
  team.runs.set(job.id, { agents: new Set(), abort: new AbortController() });
  let asked = false, quota = false;
  team.agentRun = async (agent, task, prompt) => {
    seen.push([agent.id, task.stage]);
    if (task.stage === 'assess') { assert(!prompt.includes('UNIQUE_PEER_CLAIM')); assert(!prompt.includes('UNIQUE_PEER_QUESTION')); assert(!prompt.includes('"discussion"')); assert(!existsSync(join(task.worktree, '.ai-team', 'prompt.md'))); return { status: 'completed', summary: 'Own view', answer: 'The configured greeting', evidence: ['hello.txt:1'] }; }
    if (task.stage === 'consult') return { status: 'completed', summary: 'Reply', replyTo: 'M1', claimIds: ['C1'], stance: 'answer', answer: 'Use the configured greeting', evidence: ['hello.txt:1'] };
    if (!asked) { asked = true; return { status: 'waiting_for_reply', summary: 'Need contract', peerRequest: { to: 'gemini', topic: 'Greeting', claim: 'UNIQUE_PEER_CLAIM', question: 'UNIQUE_PEER_QUESTION', files: ['hello.txt'], evidence: ['hello.txt:1'] } }; }
    if (agent.id === 'codex-2' && !quota) { quota = true; throw new Error('429 quota exhausted'); }
    assert.equal(agent.id, 'codex-4'); assert(prompt.includes('Use the configured greeting'));
    writeFileSync(join(task.worktree, 'hello.txt'), 'Hello from AI Team demo!\n');
    return { status: 'completed', summary: 'Fixed', dialogueDecision: { thread: job.discussions[0].id, outcome: 'accepted', reason: 'Verified configured contract', choice: 'Use configured greeting', evidence: ['Updated hello.txt:1'], conditions: ['Greeting contract stays unchanged'] } };
  };
  await team.callWithHandover(job, job.tasks[0], 0, 'codex-2', 'implement', []);
  const d = job.discussions[0]; assert.equal(d.owner, 'codex-4'); assert.deepEqual(d.owners, ['codex-2','codex-4']); assert.equal(d.status, 'resolved'); assert.equal(d.messages[1].replyTo, 'M1');
  assert.deepEqual(seen.map(x => x[1]), ['implement','assess','consult','implement','implement']);
  assert.equal(d.evidence[0].status, 'stale'); assert.equal(d.evidence.at(-1).status, 'current');
  await team.commitAll(job); await team.checkDiscussions(job);
  writeFileSync(join(job.worktree, 'unrelated.txt'), 'Other work\n'); await team.commitAll(job); await team.checkDiscussions(job);
  team.runs.clear(); team.save(job);
  await team.control(job.id, 'score-claim', { thread: d.id, claim: 'C1', before: false, after: true, evidence: ['Configured greeting test'] });
  assert.equal(team.get(job.id).discussions[0].claims[0].judgment.transition, 'wrongToRight');
  await team.control(job.id, 'score-claim', { thread: d.id, claim: 'C1', before: true, after: false, evidence: ['Counterexample'] });
  assert.equal(team.get(job.id).discussions[0].claims[0].judgment.transition, 'rightToWrong');
  await assert.rejects(team.control(job.id, 'score-claim', { thread: d.id, claim: 'C1', before: 'true', after: false, evidence: ['Invalid label'] }), /Scoring/);
  writeFileSync(join(job.worktree, 'hello.txt'), 'Changed contract\n');
  await assert.rejects(team.checkDiscussions(job), e => e.peerWait && /obligations/.test(e.message));
  assert.equal(d.status, 'reopened'); assert.equal(d.history.length, 1); assert.equal(d.claims[0].status, 'open');
  await team.control(job.id, 'revisit-discussion', { thread: d.id, task: 0, recipient: 'gemini' });
  assert.equal(team.get(job.id).stage, 'implement'); assert.equal(team.get(job.id).tasks[0].done, false);
});

test('comparison uses identical inputs and fixed budgets without automatically running AI', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); team.closed = true; t.after(() => team.close());
  const result = await team.createComparison({ project: 'test', goal: 'Compare greeting', tokenBudget: 1000, callBudget: 5 });
  assert.deepEqual(result.jobs.map(j => j.dialogueMode), ['off','direct','independent']);
  assert(result.jobs.every(j => j.status === 'paused' && !j.usage && j.tokenBudget === 1000 && j.callBudget === 5 && j.base === result.jobs[0].base && j.comparison.input === result.jobs[0].comparison.input));
  const job = result.jobs[0]; job.usage = { calls: 5, tokens: 0 }; team.save(job);
  await assert.rejects(team.control(job.id, 'resume'), /budget exhausted/);
  await assert.rejects(team.invoke(job, 'codex-1', 'plan', 'Over budget', undefined, [], {}, team.agent('codex-1'), new AbortController().signal), /Call budget/);
  assert.equal(team.get(job.id).callBudget, 5);
  const next = result.jobs[1]; team.config.agents[0].model = 'changed';
  await assert.rejects(team.control(next.id, 'resume'), /models, roles, tools or permissions changed/);
  await assert.rejects(team.createComparison({ project: 'test', goal: 'Missing budgets' }), /positive/);
  await team.remember(next, { add: ['Comparison answer must stay private'], session: 'Do not leak this answer' });
  assert(!team.memory('test').facts.some(r => r.text.includes('Comparison answer')));
  assert.equal(team.sessions().find(s => s.id === next.sessionId).notes, '');
  team.config.maxTokensPerJob = 1000;
  const ordinary = await team.create({ project: 'test', goal: 'Legacy resume budget', paused: true });
  for (const used of [1000, 2000]) {
    ordinary.status = 'paused'; ordinary.usage = { calls: 1, tokens: used }; team.save(ordinary); team.event(ordinary.id, 'codex-2', 'controller', 'USAGE', 'Actual usage', { total_tokens: 1000 });
    const resumed = await team.control(ordinary.id, 'resume'); assert.equal(resumed.tokenBudget, used + 1000); Object.assign(ordinary, resumed);
  }
});

test('quota, structured reports, isolation, and shell-free prompts', async () => {
  const quota = normalizeCodexQuota({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1800000000 } }, rateLimitsByLimitId: { fast: { primary: { usedPercent: 60 }, secondary: { usedPercent: null } } } });
  assert.equal(quota[0].id, 'fast'); assert.equal(quota[0].windows[0].remaining, 40); assert.equal(quota[0].windows[1].remaining, null);
  assert.equal(normalizeCodexQuota({ rateLimits: { primary: { usedPercent: 120 } } })[0].windows[0].remaining, 0);
  assert.equal(normalizeGoogleQuota({ quota: { pro: { remaining_fraction: .4, reset_time: 'later' } } })[0].windows[0].remaining, 40);
  assert.deepEqual(normalizeGoogleQuota({ response: 'You have 80% left' }), []);
  assert.throws(() => parseReport('complete!')); assert.equal(parseReport('```json\n{"summary":"ok"}\n```').summary, 'ok');
  assert(!redact('secret sk-12345678901234567890').includes('12345678901234567890'));
  // redact chạy trên JSON đã stringify (scrub) không được làm hỏng JSON
  for (const v of ['api_key="k1"', "get('Authorization:\"x\"')"]) { const out = JSON.parse(redact(JSON.stringify(v))); assert(!out.includes('k1') && !out.includes(':"x')); }
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-secret';
  assert.equal(childEnv({ home: 'isolated' }).CODEX_HOME, 'isolated'); assert.equal(childEnv().OPENAI_API_KEY, undefined);
  if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  const input = 'x & echo hacked | $(whoami) `hello` "quoted"\nTiếng Việt';
  const output = await run([process.execPath, '-e', "process.stdin.pipe(process.stdout)"], [], { input });
  assert.equal(output.stdout, input);
  await assert.rejects(run([process.execPath, '-e', 'setInterval(()=>{},1000)'], [], { timeoutMs: 100 }), /timed out/);
  await assert.rejects(run(['fake.cmd'], []), /shell shim/);
});

test('real Git pipeline, exact revision approval, no implicit merge, persisted messages', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  assert.equal(readFileSync(join(f.path, 'hello.txt'), 'utf8'), 'Hello!\n');
  assert.equal(ready.tested, ready.revision); assert.equal(ready.reviewed, ready.revision); assert.equal(ready.verified, null); assert(ready.skipped.includes('verify'));
  const events = team.events(job.id);
  for (const type of ['GOAL', 'DECISION', 'TASK_ASSIGNMENT', 'TEST_RESULT', 'REVIEW_RESULT', 'READY_FOR_MERGE']) assert(events.some(e => e.type === type), type);
  writeFileSync(join(ready.worktree, 'hello.txt'), 'tamper');
  await assert.rejects(team.merge(job.id), /Worktree/);
  writeFileSync(join(ready.worktree, 'hello.txt'), 'Hello from AI Team demo!\n');
  await team.merge(job.id);
  assert.equal(team.get(job.id).status, 'merged'); assert.equal(readFileSync(join(f.path, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n'), 'Hello from AI Team demo!\n');
  await assert.rejects(team.merge(job.id), /chưa sẵn sàng/);
  await team.close();
  const reopened = new Team(f.config, f.data); assert.equal(reopened.get(job.id).status, 'merged'); assert(reopened.events(job.id).length > events.length); await reopened.close();
  // close is intentionally idempotent for shutdown after a manual close.
});

test('pause cancels process; resume retains work; new guidance invalidates ready approval', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Demo pause' });
  while (!team.active) await new Promise(r => setTimeout(r, 10));
  await team.control(job.id, 'pause');
  await settle(team, job.id, 'paused');
  await team.control(job.id, 'reassign', { agent: 'codex-4' });
  await team.control(job.id, 'message', { message: 'Keep changes minimal' }); // chat vào task đã dừng = tự chạy tiếp
  await settle(team, job.id, 'ready');
  assert(team.events(job.id).some(e => e.to === 'codex-4' && e.type === 'TASK_ASSIGNMENT'));
  await team.control(job.id, 'message', { message: 'New requirement' });
  assert.equal(team.get(job.id).status, 'queued'); assert.equal(team.get(job.id).reviewed, null);
  await assert.rejects(team.merge(job.id), /chưa sẵn sàng/);
  await settle(team, job.id, 'ready');
});

test('cancel during a mock agent run is terminal and idempotent; stale saves cannot resurrect it', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const config = { demo: true, maxRamPercent: 100, maxCpuPercent: 100,
    agents: [{ id: 'solo', label: 'solo', provider: 'mock' }],
    pipeline: { manager: 'solo', builders: ['solo'], reviewer: 'solo', verifier: 'solo' },
    projects: [{ id: 'test', path: process.cwd(), tests: [] }],
  };
  const team = new Team(config, mkdtempSync(join(tmpdir(), 'ai-team-cancel-')), { runAgent: (agent, task, prompt, opts) => {
    entered(opts.signal); return runAgent(agent, task, prompt, opts);
  } });
  t.after(() => team.close());
  team.save({ id: 'cancel-test', project: 'test', goal: 'Update hello', status: 'queued', stage: 'plan',
    worktree: process.cwd(), tasks: [], taskIndex: 0, reports: [], messages: [], round: 0 });
  const running = team.tick(), signal = await started;
  const stale = team.get('cancel-test');
  assert.equal(stale.status, 'running'); assert.equal(stale.current.agent, 'solo');
  const cancelled = await team.control(stale.id, 'cancel');
  assert.equal(signal.aborted, true); assert.equal(signal.reason.name, 'AbortError');
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.error, null); assert.equal(cancelled.current, null);
  const events = team.events(stale.id);
  assert.deepEqual(await team.control(stale.id, 'cancel'), cancelled);
  assert.deepEqual(team.events(stale.id), events);
  await running;
  for (const status of ['running', 'queued', 'ready', 'blocked', 'cancelled']) {
    team.save({ ...stale, status, error: 'Run interrupted' });
    assert.deepEqual(team.get(stale.id), cancelled);
  }
  assert.equal(team.active, null);
  assert(!team.events(stale.id).some(e => e.type === 'BLOCKER' || /Run interrupted/.test(e.summary)));
  // Xóa việc đã kết thúc: mất cả job lẫn log; xóa lần hai báo lỗi.
  await team.control(stale.id, 'delete');
  assert.throws(() => team.get(stale.id)); assert.equal(team.events(stale.id).length, 0);
  await assert.rejects(team.control(stale.id, 'delete'));
  // Xóa phiên: từ chối khi còn việc đang chạy; không thì xóa cả việc trong phiên.
  const ses = team.createSession({ project: 'test', name: 'tmp' });
  team.save({ ...stale, id: 'ses-job', sessionId: ses.id, status: 'running' });
  await assert.rejects(team.deleteSession(ses.id));
  team.save({ ...team.get('ses-job'), status: 'done' });
  assert.equal((await team.deleteSession(ses.id)).jobs, 1);
  assert.throws(() => team.get('ses-job')); assert(!team.sessions().some(x => x.id === ses.id));
});

test('pre-aborted process and mock provider preserve the cancellation reason', async () => {
  const abort = new AbortController(), reason = new DOMException('Cancelled by test', 'AbortError');
  abort.abort(reason);
  await assert.rejects(run([process.execPath], [], { signal: abort.signal }), error => error === reason);
  await assert.rejects(runAgent({ provider: 'mock' }, { stage: 'plan' }, '', { signal: abort.signal, onEvent() {} }), error => error === reason);
});

test('cancel wins concurrent sync and review saves', async t => {
  for (const action of ['sync', 'review']) {
    const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
    const job = await team.create({ project: 'test', goal: 'Update hello' });
    await settle(team, job.id, 'ready');
    if (action === 'sync') {
      writeFileSync(join(f.path, 'other.txt'), 'x\n');
      await run(['git'], ['-C', f.path, 'add', '.']);
      await run(['git'], ['-C', f.path, '-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-m', 'other']);
    }
    const pending = team.control(job.id, action);
    const cancelled = await team.control(job.id, 'cancel');
    assert.deepEqual(await pending, cancelled);
    assert.deepEqual(team.get(job.id), cancelled);
    assert.deepEqual(await team.control(job.id, 'cancel'), cancelled);
  }
});

test('test failure never reaches merge; bounded repair loop; no-tests cannot pass', async t => {
  const f = await fixture(); f.config.maxReworkRounds = 0;
  f.config.projects[0].tests = [[process.execPath, '-e', 'process.exit(7)']];
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Fail test' });
  const blocked = await settle(team, job.id, 'blocked'); assert.equal(blocked.tested, null); assert.match(blocked.error, /giới hạn/);
  assert(team.events(job.id).some(e => e.type === 'TEST_RESULT' && e.details.code === 7));
  await assert.rejects(team.merge(job.id));
});

test('duplicate homes, dirty source checkout, and unknown projects fail closed', async t => {
  const f = await fixture();
  const invalid = structuredClone(f.config); invalid.agents[0] = { ...invalid.agents[0], provider: 'codex', home: 'same' }; invalid.agents[1] = { ...invalid.agents[1], provider: 'codex', home: 'same' };
  assert.throws(() => validateConfig(invalid), /riêng/);
  const team = new Team(f.config, f.data); t.after(() => team.close());
  await assert.rejects(team.create({ project: 'unknown', goal: 'x' }), /chưa đăng ký/);
  writeFileSync(join(f.path, 'hello.txt'), 'uncommitted');
  await assert.rejects(team.create({ project: 'test', goal: 'x' }), /chưa commit/);
});

test('hard task is rerouted to a capable builder; checker cannot review own code', async t => {
  const f = await fixture();
  f.config.agents.find(a => a.id === 'codex-2').tier = 'weak';
  f.config.agents.find(a => a.id === 'codex-4').tier = 'strong';
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'hard change' });
  const ready = await settle(team, job.id, 'ready');
  assert.equal(ready.tasks[0].difficulty, 4); assert.equal(ready.tasks[0].ranBy, 'codex-4');
  assert(team.events(job.id).some(e => e.type === 'REROUTE' && e.details.chosen === 'codex-4'));
  const plan = team.events(job.id).find(e => e.type === 'TASK_ASSIGNMENT' && e.details?.stage === 'plan');
  assert.match(plan.details.prompt, /maxDifficulty/);
});

test('member system prompt reaches the agent; risky merge needs typed confirmation', async t => {
  const f = await fixture(); f.config.sensitivePaths = 'hello';
  f.config.agents.find(a => a.id === 'codex-2').systemPrompt = 'Luôn viết test trước.';
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  await settle(team, job.id, 'ready');
  assert(team.events(job.id).some(e => e.to === 'codex-2' && e.details?.prompt?.includes('Luôn viết test trước.')));
  const check = await team.mergeCheck(job.id);
  assert(check.needsConfirm); assert.equal(check.risk, 'high');
  await assert.rejects(team.merge(job.id), /Rủi ro cao/);
  await team.merge(job.id, { confirm: check.code });
  assert.equal(team.get(job.id).status, 'merged');
});

test('base moved: merge refused, sync re-runs the gates', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  await settle(team, job.id, 'ready');
  writeFileSync(join(f.path, 'other.txt'), 'x\n');
  await run(['git'], ['-C', f.path, 'add', '.']);
  await run(['git'], ['-C', f.path, '-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-m', 'other']);
  await assert.rejects(team.merge(job.id), /Cập nhật theo base/);
  await team.control(job.id, 'sync');
  const again = await settle(team, job.id, 'ready');
  assert.equal(again.tested, again.revision);
  await team.merge(job.id);
  assert.equal(readFileSync(join(f.path, 'other.txt'), 'utf8'), 'x\n');
});

test('one member can hold every role; self-review forces typed merge confirmation', async t => {
  const f = await fixture();
  f.config.agents = [{ id: 'solo', label: 'solo', provider: 'mock' }];
  f.config.pipeline = { manager: 'solo', builders: ['solo'], reviewer: 'solo', verifier: 'solo' };
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  assert.equal(ready.risk, 'high');
  assert(team.events(job.id).some(e => e.type === 'WARNING'));
  const check = await team.mergeCheck(job.id);
  await assert.rejects(team.merge(job.id), /commit/);
  await team.merge(job.id, { confirm: check.code });
});

test('lead plan sees the team sheet; controller boosts effort when strong members are out', async t => {
  const f = await fixture();
  Object.assign(f.config.agents.find(a => a.id === 'codex-2'), { provider: 'mock', tier: 'normal' });
  Object.assign(f.config.agents.find(a => a.id === 'codex-4'), { provider: 'mock', tier: 'weak' });
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const sheet = team.members(['codex-2', 'codex-4']);
  assert.deepEqual(Object.keys(sheet[0]).filter(k => ['roles', 'allowedEfforts', 'maxDifficultyWithHighEffort', 'quotaWindows'].includes(k)).length, 4);
  // mock has no efforts → hard task falls back to the strongest member with forced merge confirmation
  const job = { roster: team.state().roster, tasks: [] };
  assert.equal(team.pickBuilder(job, { agent: 'codex-4', difficulty: 4, instruction: 'x' }), 'codex-2');
  assert.equal(job.risk, 'high');
  // a codex member (supports effort) at normal tier is boosted to high effort for difficulty 4
  team.config.agents.find(a => a.id === 'codex-2').provider = 'codex';
  const task = { agent: 'codex-4', difficulty: 4, instruction: 'x' }, job2 = { roster: job.roster };
  assert.equal(team.pickBuilder(job2, task), 'codex-2'); assert.equal(task.effort, 'high'); assert(task.boosted);
});

test('lead can pick research (no merge, ends with a conclusion) or a light code process (no verify)', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const research = await team.create({ project: 'test', goal: 'nghiên cứu: so sánh hai cách làm' });
  const done = await settle(team, research.id, 'done');
  assert.equal(done.kind, 'research'); assert(done.conclusion?.conclusion);
  assert.equal(done.revision, done.base); // không sửa code
  assert(team.events(research.id).some(e => e.type === 'CONCLUSION'));
  await assert.rejects(team.merge(research.id));
  const light = await team.create({ project: 'test', goal: 'light: Update hello' });
  const ready = await settle(team, light.id, 'ready');
  assert.equal(ready.rigor, 'light'); assert.equal(ready.verified, null);
  assert(!team.events(light.id).some(e => e.details?.stage === 'verify'));
  await team.merge(light.id);
});

test('lead asks clarifying questions and waits; the answer resumes planning', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'hỏi lại: sửa trang' });
  const waiting = await settle(team, job.id, 'waiting');
  assert.equal(waiting.questions.length, 1); assert.equal(waiting.tasks.length, 0);
  assert(team.events(job.id).some(e => e.type === 'QUESTION' && e.to === 'user'));
  await team.control(job.id, 'message', { message: 'Trang hello.txt' });
  await settle(team, job.id, 'ready');
});

test('projects can be registered from the UI, including git init and "npm test"-style commands', async t => {
  const f = await fixture(), team = new Team({ ...f.config, demo: false, agents: [{ id: 'c', label: 'c', provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) }], pipeline: {} }, f.data); t.after(() => team.close());
  const { Accounts } = await import('../src/accounts.js');
  const file = join(f.data, 'cfg.json'); writeFileSync(file, '{}');
  const accounts = new Accounts(team, file, process.cwd(), { commandAvailable: () => true }); t.after(() => accounts.close());
  const folder = mkdtempSync(join(tmpdir(), 'proj-'));
  await assert.rejects(accounts.addProject({ path: folder }), /git/);
  const { id } = await accounts.addProject({ path: folder, init: true, tests: 'node -e "process.exit(0)"' });
  const p = team.project(id); assert.deepEqual(p.tests, [['node', '-e', 'process.exit(0)']]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects.length, 2);
  const upd = accounts.updateProject(id, { tests: 'node --test x.js\nno-such-cmd-xyz run', network: true });
  assert.deepEqual(team.project(id).tests, [['node', '--test', 'x.js'], ['no-such-cmd-xyz', 'run']]); assert.deepEqual(team.project(id).access.network, ['*']); assert.equal(team.accessFor(id, 'c').network, true);
  assert.equal(upd.warnings.length, 1); assert.match(upd.warnings[0], /no-such-cmd-xyz/);
  assert.throws(() => accounts.updateProject(id, { tests: [['node', 1]] })); assert.throws(() => accounts.updateProject(id, { network: 'yes' }));
  // Còn công việc chưa xong: 409 kèm danh sách; cancelJobs=true thì hủy rồi gỡ.
  team.save({ id: 'open-job', project: id, goal: 'x', status: 'paused', stage: 'plan', tasks: [], reports: [], messages: [] });
  await assert.rejects(accounts.removeProject(id), e => e.code === 409 && e.jobs[0] === 'open-job');
  await accounts.removeProject(id, { cancelJobs: true }); assert.throws(() => team.project(id));
  assert.equal(team.get('open-job').status, 'cancelled');
});

test('attachments land in the worktree for agents but never in commits', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const shot = join(f.data, 'shot.png'); writeFileSync(shot, 'PNG');
  const job = await team.create({ project: 'test', goal: 'Update hello', files: [{ name: 'log.txt', data: Buffer.from('err').toString('base64') }, { path: shot }] });
  const ready = await settle(team, job.id, 'ready');
  assert.deepEqual(ready.attachments, ['.ai-team/attachments/log.txt', '.ai-team/attachments/shot.png']);
  assert.equal(readFileSync(join(ready.worktree, '.ai-team/attachments/log.txt'), 'utf8'), 'err');
  const files = (await run(['git'], ['-C', ready.worktree, 'ls-tree', '-r', '--name-only', 'HEAD'])).stdout;
  assert(!files.includes('.ai-team'));
  assert(team.events(job.id).some(e => e.details?.prompt?.includes('.ai-team/attachments/shot.png')));
  await assert.rejects(team.create({ project: 'test', goal: 'x', files: Array(11).fill({ name: 'a', data: 'YQ==' }) }), /10/);
});

test('Gemini/Antigravity get the prompt via a file (Windows command-line limit) and progress timing is recorded', async t => {
  const f = await fixture(); f.config.demo = false;
  f.config.agents = f.config.agents.map(a => a.id === 'gemini' ? { ...a, provider: 'antigravity' } : { ...a, provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) });
  const seen = [];
  const { runAgent } = await import('../src/providers.js');
  const team = new Team(f.config, f.data, { runAgent: (agent, task, prompt, opts) => {
    if (agent.provider === 'antigravity') { seen.push(task.promptFile); assert.equal(readFileSync(join(task.worktree, task.promptFile), 'utf8'), prompt); }
    return runAgent({ ...agent, provider: 'mock' }, task, prompt, opts);
  }, readQuota: async () => ({ buckets: [] }) });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  assert.deepEqual(seen, ['.ai-team/prompt.md']);
  assert(ready.durations.length >= 4); assert.equal(ready.current, null);
});

test('review/verify run the project checks themselves in a detached worktree', async t => {
  const f = await fixture(); f.config.demo = false;
  f.config.agents = f.config.agents.map(a => ({ ...a, provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) }));
  const seen = [];
  const team = new Team(f.config, f.data, { runAgent: (agent, task, prompt, opts) => {
    seen.push({ stage: task.stage, checks: task.checks, worktree: task.worktree, prompt });
    if (task.stage === 'review') writeFileSync(join(task.worktree, 'coverage.tmp'), 'x'); // check sinh file tạm: không được chặn
    return runAgent({ ...agent, provider: 'mock' }, task, prompt, opts);
  }, readQuota: async () => ({ buckets: [] }) });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  const review = seen.find(s => s.stage === 'review'), impl = seen.find(s => s.stage === 'implement');
  assert.deepEqual(review.checks, f.config.projects[0].tests);
  assert.notEqual(review.worktree, ready.worktree);
  assert.match(review.prompt, /Run the commands in "checks" yourself/);
  assert.deepEqual(impl.checks, []);
});

test('agy quota counts only the bucket group of the member model', async t => {
  const f = await fixture(); f.config.demo = false;
  f.config.agents = f.config.agents.map(a => a.id === 'gemini' ? { ...a, provider: 'antigravity', model: 'gemini-3.8-flash-high' } : { ...a, provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) });
  const w = remaining => [{ name: 'quota', remaining, minutes: null, resetsAt: null }];
  const team = new Team(f.config, f.data, { readQuota: async a => ({ buckets: a.provider === 'antigravity' ? [{ id: 'gemini-5h', windows: w(98) }, { id: '3p-5h', windows: w(0) }] : [] }) });
  t.after(() => team.close());
  await team.refreshQuota();
  assert.equal(team.remaining('gemini'), 98); assert.equal(team.lowQuota('gemini'), false);
  team.config.agents.find(a => a.id === 'gemini').model = 'claude-opus';
  assert.equal(team.remaining('gemini'), 0);
});

test('builder out of quota mid-task: controller hands the task and partial work to another builder', async t => {
  const f = await fixture(); f.config.demo = false;
  f.config.agents = f.config.agents.map(a => ({ ...a, provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) }));
  const seen = [];
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'implement') seen.push({ agent: agent.id, prompt });
    if (task.stage === 'implement' && seen.length === 1) { writeFileSync(join(task.worktree, 'partial.txt'), 'half done\n'); throw new Error("You've hit your usage limit. Try again later."); }
    return runAgent({ ...agent, provider: 'mock' }, task, prompt, opts);
  }, readQuota: async () => ({ buckets: [] }) });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  assert.equal(seen.length, 2); assert.notEqual(seen[0].agent, seen[1].agent);
  assert.match(seen[1].prompt, /handover/); assert.match(seen[1].prompt, /partial\.txt/);
  assert(team.events(job.id).some(e => e.type === 'HANDOVER' && e.details.from === seen[0].agent && e.details.to === seen[1].agent));
  assert.equal(team.lowQuota(seen[0].agent), true); assert.equal(ready.tasks[0].ranBy, seen[1].agent); assert.equal(ready.tasks[0].handover, undefined);
});

test('maxJobsPerAccount lets one account run several jobs at once, each in its own slot', async t => {
  const f = await fixture(); f.config.demo = false; f.config.maxJobsPerAccount = 2; f.config.resources = { reserveGB: 0, ramPerAgentGB: 0.01, maxAgents: 4, hardStopRamPercent: 100 };
  f.config.agents = f.config.agents.map(a => ({ ...a, provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) }));
  f.config.pipeline.builders = ['codex-2'];
  let now = 0, peak = 0, release; const slots = new Set(), held = new Set(), plans = [], together = new Promise(r => { release = r; });
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'plan') plans.push(prompt);
    if (task.stage === 'implement') {
      assert(!held.has(task.slot), 'hai việc cùng giữ một slot'); held.add(task.slot); slots.add(task.slot);
      peak = Math.max(peak, ++now); if (now === 2) release();
      const timeout = setTimeout(release, 10000); await together; clearTimeout(timeout); now--; held.delete(task.slot);
    }
    return runAgent({ ...agent, provider: 'mock' }, task, prompt, opts);
  }, readQuota: async () => ({ buckets: [] }) });
  t.after(() => team.close());
  const jobs = [await team.create({ project: 'test', goal: 'Update hello' }), await team.create({ project: 'test', goal: 'Update hello' }), await team.create({ project: 'test', goal: 'Update hello' })];
  for (const j of jobs) await settle(team, j.id, 'ready');
  assert.equal(peak, 2); assert.deepEqual([...slots].sort(), [1, 2]); // việc thứ 3 chờ, không nhận trùng slot
  assert(plans.some(p => p.includes('"otherJobs"')), 'Lead của việc sau phải thấy các việc đang chạy cùng project');
  // slot 1 không kế thừa CODEX_SQLITE_HOME của tiến trình cha; slot ≥ 2 nhận thư mục riêng
  process.env.CODEX_SQLITE_HOME = '/parent/state'; t.after(() => delete process.env.CODEX_SQLITE_HOME);
  const home = team.agent('codex-2').home;
  assert.equal(childEnv({ provider: 'codex', home }).CODEX_SQLITE_HOME, undefined);
  assert.equal(childEnv({ provider: 'codex', home, sqliteHome: join(home, 'sqlite-2') }).CODEX_SQLITE_HOME, join(home, 'sqlite-2'));
  // sqlite_home trong config.toml ghi đè biến môi trường → tắt song song cho tài khoản đó
  writeFileSync(join(home, 'config.toml'), 'sqlite_home = "C:/shared"\n'); assert.equal(team.maxJobs('codex-2'), 1);
  writeFileSync(join(home, 'config.toml'), '');
  assert.equal(team.maxJobs('codex-2'), 2); team.config.maxJobsPerAccount = undefined; assert.equal(team.maxJobs('codex-2'), 1);
});

test('slot safety: sqlite_home defers busy quota reads, limits count per account email, orphans keep their slot after restart', async t => {
  const f = await fixture(); f.config.demo = false;
  f.config.agents = f.config.agents.map(a => ({ ...a, provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) }));
  const reads = [];
  let team = new Team(f.config, f.data, { readQuota: async a => { reads.push(a.id); return { buckets: [], account: { email: ['codex-2', 'codex-4'].includes(a.id) ? 'same@x.com' : a.id + '@x.com' } }; } });
  // 1. Tài khoản đang chạy việc: Codex thường vẫn đọc quota (SQLite riêng); có sqlite_home thì hoãn.
  team.runs.set('fake', { agents: new Set(['codex-2', 'codex-3']), abort: new AbortController() });
  writeFileSync(join(team.agent('codex-3').home, 'config.toml'), 'sqlite_home = "C:/shared"\n');
  await team.refreshQuota();
  assert(reads.includes('codex-2')); assert(!reads.includes('codex-3'));
  // 2. Hai hồ sơ cùng email: dùng chung bộ đếm (codex-2 đang chạy → codex-4 cũng hết chỗ khi giới hạn là 1).
  team.runs.set('fake', { agents: new Set(['codex-2']), abort: new AbortController() });
  assert.equal(team.useOf('codex-4'), 1); assert(team.fullAgents().has('codex-4')); assert(!team.fullAgents().has('codex-1'));
  team.runs.delete('fake');
  // 3. Controller tắt đột ngột khi tiến trình con còn sống → sau khởi động lại slot vẫn bị giữ.
  const job = await team.create({ project: 'test', goal: 'x' });
  team.save({ ...team.get(job.id), status: 'running', running: [{ agent: 'codex-1', slot: 1, pid: process.pid, startedAt: new Date().toISOString() }] });
  team.close();
  team = new Team(f.config, f.data); t.after(() => team.close());
  assert(team.slotKeys().includes('codex-1')); assert(team.fullAgents().has('codex-1')); assert.equal(team.get(job.id).status, 'paused');
});

test('plan challenge: risky plans get one evidence-based challenge; serious objections send the plan back once', async t => {
  for (const objections of [[{ claim: 'Task 1 sửa sai file', failsWhen: 'hello.txt không phải nơi cần đổi', check: 'đọc README', impact: 'high' }], []]) {
    const f = await fixture(); const prompts = [];
    const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
      prompts.push({ stage: task.stage, agent: agent.id, prompt });
      const r = await runAgent(agent, task, prompt, opts);
      if (task.stage === 'plan') r.rigor = 'strict';
      if (task.stage === 'challenge') return { summary: 'x', status: 'completed', objections };
      return r;
    } });
    t.after(() => team.close());
    const job = await team.create({ project: 'test', goal: 'Update hello' });
    await settle(team, job.id, 'ready');
    const plans = prompts.filter(p => p.stage === 'plan'), challenges = prompts.filter(p => p.stage === 'challenge');
    assert.equal(challenges.length, 1); assert.notEqual(challenges[0].agent, 'codex-1'); // không để Manager tự phản biện mình
    assert.equal(plans.length, objections.length ? 2 : 1);
    if (objections.length) assert.match(plans[1].prompt, /"objections"/);
    assert(team.events(job.id).some(e => e.type === 'CHALLENGE'));
  }
});

test('structured rebuttal: a rejected finding becomes a dispute that forces verify; unresolved high findings go to the human', async t => {
  const f = await fixture(); const seen = [];
  const finding = { id: 'F1', claim: 'Thiếu xử lý file rỗng', failsWhen: 'hello.txt rỗng', check: 'chạy test với file rỗng', impact: 'high' };
  let reviews = 0;
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    seen.push({ stage: task.stage, prompt });
    const r = await runAgent(agent, task, prompt, opts);
    if (task.stage === 'review' && reviews++ === 0) return { ...r, verdict: 'changes_requested', findings: [finding] };
    if (task.stage === 'implement' && task.round) return { ...r, responses: [{ finding: 'F1', action: 'rejected', evidence: 'test hiện có đã phủ file rỗng (test/x:12)' }] };
    if (task.stage === 'verify') return { ...r, rulings: [{ finding: 'F1', upheld: false, evidence: 'đã chạy test, pass' }] };
    return r;
  } });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  const verify = seen.find(x => x.stage === 'verify');
  assert(verify, 'verify phải bị ép chạy vì có tranh chấp (rigor standard, không có cổng rủi ro)');
  assert.match(verify.prompt, /"disputes"/); assert.match(verify.prompt, /đã phủ file rỗng/);
  const ev = team.events(job.id); assert(ev.some(e => e.type === 'DISPUTE')); assert(ev.some(e => e.type === 'RULING'));
  assert.deepEqual(ready.disputes, []);
  // Hết vòng sửa mà reviewer vẫn giữ finding mức high → chờ người quyết, không BLOCKED mù.
  const g = await fixture(); g.config.maxReworkRounds = 0;
  const team2 = new Team(g.config, g.data, { runAgent: async (agent, task, prompt, opts) => {
    const r = await runAgent(agent, task, prompt, opts);
    return task.stage === 'review' ? { ...r, verdict: 'changes_requested', findings: [finding] } : r;
  } });
  t.after(() => team2.close());
  const j2 = await team2.create({ project: 'test', goal: 'Update hello' });
  const waiting = await settle(team2, j2.id, 'waiting');
  assert.match(waiting.questions[0], /F1: Thiếu xử lý file rỗng/);
});

test('Manager-proposed flow: chosen reviewer, skipped verify forced back by the risk gate, invalid id falls back, absent steps keep the old default', async t => {
  const run = async (flow, cfg = c => c) => {
    const f = await fixture(); cfg(f.config); const calls = [];
    const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
      calls.push({ stage: task.stage, agent: agent.id });
      const r = await runAgent(agent, task, prompt, opts);
      if (task.stage === 'plan' && flow) r.flow = flow;
      return r;
    } });
    t.after(() => team.close());
    const job = await team.create({ project: 'test', goal: 'Update hello' });
    return { job: await settle(team, job.id, 'ready'), calls, ev: team.events(job.id) };
  };
  // (a) Manager chọn reviewer khác roster (roster.reviewer = gemini)
  const a = await run({ reviewer: 'codex-1', steps: ['review'] });
  assert.equal(a.calls.find(c => c.stage === 'review').agent, 'codex-1'); assert.equal(a.job.checkers.reviewer, 'codex-1');
  assert(!a.calls.some(c => c.stage === 'verify')); assert(a.job.skipped.includes('final'));
  // (b) Manager bỏ verify nhưng cổng rủi ro ép lại (file nhạy cảm) → ghi override
  const b = await run({ steps: ['review'] }, c => { c.sensitivePaths = 'hello'; });
  assert(b.calls.some(c => c.stage === 'verify')); assert.equal(b.job.verified, b.job.revision);
  assert(b.job.flow.overrides.some(o => o.step === 'verify')); assert(b.ev.some(e => e.type === 'OVERRIDE'));
  // (c) id không hợp lệ → fallback roster + WARNING
  const c = await run({ reviewer: 'khong-ton-tai' });
  assert.equal(c.job.flow.reviewer, null); assert.equal(c.calls.find(x => x.stage === 'review').agent, 'gemini');
  assert(c.ev.some(e => e.type === 'WARNING' && /khong-ton-tai/.test(e.summary)));
  // (d) không gửi steps → giữ mặc định cũ: standard không có cổng rủi ro thì KHÔNG verify (tránh lỗi wants() mặc định = true)
  const d = await run({ reviewer: 'codex-1' });
  assert(d.calls.some(x => x.stage === 'review')); assert(!d.calls.some(x => x.stage === 'verify'));
  // (e) steps: [] khác với không gửi: Manager bỏ hết, test vẫn chạy, không có review/verify/final
  const e = await run({ steps: [] });
  assert(!e.calls.some(x => ['review', 'verify', 'final'].includes(x.stage))); assert.equal(e.job.tested, e.job.revision);
});

test('independent checker: a reviewer who wrote the code is swapped for another member', async t => {
  const f = await fixture(); f.config.pipeline.reviewer = 'codex-2'; f.config.pipeline.builders = ['codex-2']; const calls = [];
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => { calls.push({ stage: task.stage, agent: agent.id }); return runAgent(agent, task, prompt, opts); } });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  const builder = calls.find(c => c.stage === 'implement').agent, reviewer = calls.find(c => c.stage === 'review').agent;
  assert.equal(builder, 'codex-2'); assert.notEqual(reviewer, 'codex-2'); assert.equal(ready.checkers.reviewer, reviewer);
  assert(team.events(job.id).some(e => e.type === 'REROUTE' && e.details?.role === 'reviewer' && e.details.from === 'codex-2'));
  assert(!team.events(job.id).some(e => e.type === 'WARNING' && /codex-2/.test(e.summary))); // đã có người thay → không còn cảnh báo tự review
});

test('task graph: per-task review nodes review exact commits, auto-fix on failure, escalate to the Leader after 2 fixes', async t => {
  const graph = [
    { instruction: 'write a.txt', files: ['a.txt'], dependsOn: [], difficulty: 2 },
    { instruction: 'write b.txt', files: ['b.txt'], dependsOn: [], difficulty: 2 },
    { kind: 'review', dependsOn: [0] }, { kind: 'review', dependsOn: [1] }];
  const go = async (reviewVerdict) => {
    const f = await fixture(); const calls = []; let plans = 0, nodeReviews = 0;
    const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
      const r = await runAgent(agent, task, prompt, opts);
      calls.push({ stage: task.stage, agent: agent.id, prompt });
      if (task.stage === 'plan' && plans++ === 0) { r.tasks = structuredClone(graph); r.flow = { steps: ['verify'] }; }
      if (task.stage === 'implement') {
        const entry = task.running.find(e => e.agent === agent.id && e.slot === task.slot), file = task.tasks[entry.task].files[0];
        if (file) writeFileSync(join(task.worktree, file), file + Date.now() + '\n');
      }
      if (task.stage === 'review' && /Review ONLY this part/.test(prompt)) { const v = reviewVerdict(nodeReviews++); if (v !== 'approved') return { ...r, verdict: v, findings: [{ claim: 'thiếu kiểm tra', impact: 'high' }] }; }
      return r;
    } });
    t.after(() => team.close());
    const job = await team.create({ project: 'test', goal: 'Update hello' });
    return { team, job, calls };
  };
  // (a) 2 task → 2 review theo task → verify cuối; review cấp job bị Manager bỏ
  { const { team, job, calls } = await go(() => 'approved'); const ready = await settle(team, job.id, 'ready');
    const nodeRev = calls.filter(c => c.stage === 'review' && /Review ONLY this part/.test(c.prompt));
    assert.equal(nodeRev.length, 2);
    for (const [k, idx] of [[0, 2], [1, 3]]) {
      const node = ready.tasks[idx], dep = ready.tasks[idx - 2];
      assert(node && dep, JSON.stringify(ready.tasks));
      assert(node.done && node.verdict === 'approved'); assert.notEqual(node.ranBy, dep.ranBy);
      assert(nodeRev.some(c => c.prompt.includes(`${dep.base}..${dep.commit}`)), 'review đúng commit của task');
    }
    assert(!calls.some(c => c.stage === 'review' && !/Review ONLY this part/.test(c.prompt)), 'review cấp job đã bị bỏ theo flow.steps');
    assert(calls.some(c => c.stage === 'verify')); assert.equal(ready.verified, ready.revision); }
  // (b) review node fail 1 lần → task sửa tự động (tác giả cũ) → review lại → đạt
  { const { team, job } = await go(n => n === 0 ? 'changes_requested' : 'approved'); const ready = await settle(team, job.id, 'ready');
    const fix = ready.tasks.find(x => x.auto); assert(fix && fix.done); assert.equal(fix.agent, ready.tasks[fix.fixOf - 2].ranBy);
    assert.equal(ready.tasks[fix.fixOf].attempts, 1); assert(ready.tasks[fix.fixOf].done);
    assert(team.events(job.id).some(e => e.type === 'FIX_TASK')); }
  // (c) luôn fail → sau 2 lần sửa thì về Leader lập kế hoạch lại (kế hoạch 2 không có node review)
  { const { team, job, calls } = await go(() => 'changes_requested'); await settle(team, job.id, 'ready', 40000);
    assert.equal(calls.filter(c => c.stage === 'plan').length, 2);
    assert(team.events(job.id).some(e => e.type === 'REWORK_REQUEST')); }
});

test('per-member speed and token use are measured and shown to the lead', async t => {
  const f = await fixture();
  const { runAgent } = await import('../src/providers.js');
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => { opts.onEvent('USAGE', { summary: 'u', details: { input_tokens: 1000, output_tokens: 200 } }); return runAgent(agent, task, prompt, opts); } });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  await settle(team, job.id, 'ready');
  const sp = team.members(['codex-2'])[0].speed;
  assert(sp.samples >= 1); assert.equal(sp.avgTokensPerCall, 1200);
  const plan = team.events(job.id).find(e => e.details?.stage === 'plan');
  assert.match(plan.details.prompt, /avgTokensPerCall/);
});

test('skill library: lead attaches skills per task, controller copies them for the agent (never committed)', async t => {
  const f = await fixture();
  const lib = mkdtempSync(join(tmpdir(), 'skills-')); const { mkdirSync } = await import('node:fs');
  mkdirSync(join(lib, 'demo-skill')); writeFileSync(join(lib, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Keep it minimal\n---\nDo less.');
  mkdirSync(join(lib, 'ns')); writeFileSync(join(lib, 'ns', 'SKILL.md'), '---\nname: ckm:demo\ndescription: Namespaced\n---\nColon name.');
  f.config.skillDirs = [lib];
  const { runAgent } = await import('../src/providers.js');
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'plan') { assert.match(prompt, /demo-skill/); return { summary: 'p', kind: 'code', rigor: 'standard', risk: 'low', reviewSkills: ['demo-skill'], tasks: [{ agent: 'codex-2', difficulty: 2, skills: ['demo-skill', 'ckm:demo', 'nope'], instruction: 'Update hello.txt' }] }; }
    if (task.stage === 'implement') { assert.match(prompt, /\.ai-team\/skills\/demo-skill\/SKILL\.md/); assert.equal(readFileSync(join(task.worktree, '.ai-team/skills/demo-skill/SKILL.md'), 'utf8').includes('Do less'), true); assert.match(prompt, /ckm:demo: \.ai-team\/skills\/ckm-demo\/SKILL\.md/); assert(readFileSync(join(task.worktree, '.ai-team/skills/ckm-demo/SKILL.md'), 'utf8').includes('Colon')); }
    return runAgent(agent, task, prompt, opts);
  } });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  assert.deepEqual(ready.tasks[0].skills, ['demo-skill', 'ckm:demo']); assert.deepEqual(ready.reviewSkills, ['demo-skill']);
  assert(!(await run(['git'], ['-C', ready.worktree, 'ls-tree', '-r', '--name-only', 'HEAD'])).stdout.includes('.ai-team'));
  assert(team.events(job.id).some(e => e.details?.stage === 'review' && e.details.skills?.includes('demo-skill')));
});

test('per-member MCP config is validated and limited to Codex/Claude', async t => {
  const f = await fixture();
  const team = new Team({ ...f.config, demo: false, agents: [{ id: 'c', label: 'c', provider: 'claude', home: mkdtempSync(join(tmpdir(), 'h-')) }, { id: 'g', label: 'g', provider: 'antigravity' }], pipeline: {} }, f.data); t.after(() => team.close());
  const { Accounts } = await import('../src/accounts.js');
  const file = join(f.data, 'cfg.json'); writeFileSync(file, '{}');
  const accounts = new Accounts(team, file, process.cwd(), { commandAvailable: () => true }); t.after(() => accounts.close());
  assert.throws(() => accounts.profile('c', { mcp: '{bad' }), /MCP/);
  accounts.profile('c', { mcp: '{"gitnexus": {"command": "npx", "args": ["-y", "gitnexus", "mcp"]}}' });
  assert.deepEqual(team.agent('c').mcp.gitnexus.args, ['-y', 'gitnexus', 'mcp']);
  assert.deepEqual(team.members(['c'])[0].mcpServers, ['gitnexus']);
  assert.throws(() => accounts.profile('g', { mcp: { x: { command: 'y' } } }), /Codex|Claude/);
});

test('rule-based router: short low-risk goals take a 1-agent fast path; risky ones go to the Manager', async t => {
  assert.equal(routeGoal('Đổi màu nút Lưu sang xanh', 'auto').fast, true);
  assert.equal(routeGoal('Sửa lỗi đăng nhập login token', 'auto').fast, false);
  assert.equal(routeGoal('x'.repeat(500), 'auto').fast, false);
  assert.equal(routeGoal('Giải thích hàm A làm gì', 'auto').kind, 'research');
  assert.equal(routeGoal('anything', 'full').fast, false);
  const out = compressOutput(['ok 1', 'ok 2', ...Array(500).fill('noise'), 'not ok 3 - expected 2 received 3', ...Array(100).fill('tail')].join('\n'));
  assert(out.includes('not ok 3') && out.length <= 4000);
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello text', mode: 'auto' });
  const ready = await settle(team, job.id, 'ready');
  const stages = team.events(job.id).filter(e => e.type === 'TASK_ASSIGNMENT' || e.type === 'REVIEW_REQUEST').map(e => e.details.stage);
  assert.deepEqual(stages, ['implement']); // 1 lượt AI duy nhất: không plan, review, verify, final
  assert.deepEqual(ready.skipped.sort(), ['final', 'plan', 'review', 'verify']);
  await team.merge(job.id);
});

test('fast path escalates to the Manager when tests fail; risk gate forces a review', async t => {
  const f = await fixture(); f.config.projects[0].tests = [[process.execPath, '-e', "process.exit(require('fs').existsSync('ok.flag')?0:1)"]];
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello text', mode: 'fast' });
  await settle(team, job.id, 'blocked');
  const ev = team.events(job.id);
  assert(ev.some(e => e.type === 'ESCALATE')); assert(ev.some(e => e.details?.stage === 'plan'));
  const f2 = await fixture(); f2.config.sensitivePaths = 'hello';
  const team2 = new Team(f2.config, f2.data); t.after(() => team2.close());
  const j2 = await team2.create({ project: 'test', goal: 'Update hello text', mode: 'fast' });
  const r2 = await settle(team2, j2.id, 'ready');
  assert.equal(r2.reviewed, r2.revision); assert(!r2.skipped.includes('review'));
});

test('chat sessions per project; fast path picks the strongest member', async t => {
  const f = await fixture();
  f.config.agents.find(a => a.id === 'codex-2').tier = 'weak'; f.config.agents.find(a => a.id === 'codex-4').tier = 'strong';
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const s = team.createSession({ project: 'test', name: 'UI' });
  const job = await team.create({ project: 'test', goal: 'Update hello text', mode: 'fast', sessionId: s.id });
  const ready = await settle(team, job.id, 'ready');
  assert.equal(ready.sessionId, s.id); assert.equal(ready.tasks[0].ranBy, 'codex-4');
  const other = await team.create({ project: 'test', goal: 'x', mode: 'full' });
  assert.notEqual(other.sessionId, undefined);
  team.renameSession(s.id, 'UI work'); assert(team.state().sessions.some(x => x.name === 'UI work'));
});

test('read-only reference folders map to Claude permission paths', async () => {
  const { claudePath } = await import('../src/providers.js');
  assert.equal(claudePath('D:\\docs\\spec\\'), '//d/docs/spec');
  assert.equal(claudePath('/srv/docs'), '//srv/docs');
});

test('RAM slots use absolute GB; percent is only the hard stop', () => {
  assert.deepEqual(computeSlots({ freeGB: 10, totalGB: 32, reserveGB: 4, ramPerAgentGB: 1.5, maxAgents: 3 }), { start: 3, hardStop: false });
  assert.equal(computeSlots({ freeGB: 4.5, totalGB: 32, reserveGB: 4, ramPerAgentGB: 1.5 }).start, 1); // idle → at least one agent
  assert.equal(computeSlots({ freeGB: 4.5, totalGB: 32, running: 1, reserveGB: 4, ramPerAgentGB: 1.5 }).start, 0);
  assert.equal(computeSlots({ freeGB: 20, totalGB: 32, running: 2, maxAgents: 3 }).start, 1);
  assert.deepEqual(computeSlots({ freeGB: 3, totalGB: 32, hardStopRamPercent: 90 }), { start: 0, hardStop: true });
  assert.deepEqual(testList('node --test "a b.js"\n\n'), [['node', '--test', 'a b.js']]);
  assert.throws(() => testList([['node', 1]])); assert.throws(() => testList([[]]));
});

// Lead trả plan song song; builder giả ghi file riêng và ghi lại thời gian chạy.
async function parallelTeam(t, plan, kind = 'code') {
  const f = await fixture();
  f.config.projects[0].tests = [];
  f.config.resources = { reserveGB: 0, ramPerAgentGB: 0.01, maxAgents: 4, hardStopRamPercent: 100 };
  f.config.pipeline.builders = ['codex-2', 'codex-4'];
  const spans = [], prompts = [];
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'plan') return { summary: 'plan', kind, rigor: 'standard', risk: 'low', status: 'planned', tasks: plan };
    if (['implement', 'research'].includes(task.stage)) {
      const n = Number(/T(\d)/.exec(prompt)?.[1]); prompts.push(prompt);
      const span = { n, agent: agent.id, start: Date.now() }; spans.push(span);
      await new Promise(r => setTimeout(r, 400));
      if (task.stage === 'implement') writeFileSync(join(task.worktree, `t${n}.txt`), `task ${n}\n`);
      span.end = Date.now();
      return { summary: `done T${n}`, status: 'completed', verdict: 'approved', findings: [], contextGaps: n === 1 ? ['read utils.js'] : [] };
    }
    return runAgent(agent, task, prompt, opts);
  } });
  t.after(() => team.close());
  return { team, spans, prompts, f };
}
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

test('independent tasks run in parallel; dependsOn waits; code tasks merge from child worktrees', async t => {
  const { team, spans, prompts, f } = await parallelTeam(t, [
    { agent: 'codex-2', difficulty: 2, instruction: 'T1 edit', files: ['t1.txt'], dependsOn: [], estMinutes: 5, context: 'see utils.js:10' },
    { agent: 'codex-4', difficulty: 2, instruction: 'T2 edit', files: ['t2.txt'], dependsOn: [], estMinutes: 5 },
    { agent: 'codex-2', difficulty: 2, instruction: 'T3 edit', files: ['t3.txt'], dependsOn: [0, 1], estMinutes: 5 },
  ]);
  team.start();
  const job = await team.create({ project: 'test', goal: 'Parallel work' });
  const ready = await settle(team, job.id, 'ready');
  const [s1, s2, s3] = [1, 2, 3].map(n => spans.find(s => s.n === n));
  assert(overlaps(s1, s2), 'T1 and T2 should overlap');
  assert(s3.start >= Math.max(s1.end, s2.end), 'T3 waits for its dependencies');
  assert.notEqual(s1.agent, s2.agent);
  const files = await run(['git'], ['-C', ready.worktree, 'ls-tree', '--name-only', ready.revision]);
  for (const n of [1, 2, 3]) assert.match(files.stdout, new RegExp(`t${n}\\.txt`));
  assert(ready.tasks.every(x => x.done)); assert.deepEqual(ready.tasks[0].contextGaps, ['read utils.js']);
  assert.match(prompts.find(p => /T1 edit/.test(p)), /see utils\.js:10/);
  // T3 phụ thuộc T1, T2: nhận chính báo cáo của hai task đó.
  const t3 = prompts.find(p => /T3 edit/.test(p)); assert.match(t3, /"inputs":\[\{/); assert.equal(t3.match(/"stage":"implement","status"/g)?.length, 2);
  const branches = await run(['git'], ['-C', f.path, 'branch', '--list', 'ai-team/*-t[0-9]*']);
  assert.equal(branches.stdout.trim(), '', 'child branches are cleaned up');
});

test('code tasks touching the same file never run at the same time', async t => {
  const { team, spans } = await parallelTeam(t, [
    { agent: 'codex-2', difficulty: 2, instruction: 'T1 edit', files: ['src/'], dependsOn: [], estMinutes: 5 },
    { agent: 'codex-4', difficulty: 2, instruction: 'T2 edit', files: ['src/a.js'], dependsOn: [], estMinutes: 5 },
  ]);
  team.start();
  const job = await team.create({ project: 'test', goal: 'Same files' });
  await settle(team, job.id, 'ready');
  assert(!overlaps(spans[0], spans[1]));
});

test('plan with a forward/cyclic dependsOn is rejected', async t => {
  const { team } = await parallelTeam(t, [
    { agent: 'codex-2', difficulty: 2, instruction: 'T1', dependsOn: [1] },
    { agent: 'codex-4', difficulty: 2, instruction: 'T2', dependsOn: [0] },
  ]);
  team.start();
  const job = await team.create({ project: 'test', goal: 'Bad plan' });
  const blocked = await settle(team, job.id, 'blocked');
  assert.match(blocked.error, /dependsOn/);
});

test('busy strong builder: weak one takes the task only when it finishes sooner', async t => {
  const f = await fixture();
  f.config.agents.find(a => a.id === 'codex-2').tier = 'strong';
  f.config.agents.find(a => a.id === 'codex-4').tier = 'normal';
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'x' });
  const task = { agent: 'codex-2', difficulty: 3, instruction: 'x', estMinutes: 10 };
  assert.equal(team.pickBuilder(job, { ...task }), 'codex-2'); // strong and free
  team.remainingMinutes = () => 30;
  assert.equal(team.pickBuilder(job, { ...task }, new Set(['codex-2'])), 'codex-4'); // waiting 30+10 > 10
  team.remainingMinutes = () => 1; team.factor = id => id === 'codex-4' ? 3 : 1;
  assert.equal(team.pickBuilder(job, { ...task }, new Set(['codex-2'])), null); // waiting 1+10 < 30 → wait
  assert.equal(team.pickBuilder(job, { ...task, difficulty: 5 }, new Set(['codex-2'])), null); // beyond weaker member
});

test('token budget per job: a job over maxTokensPerJob stops before the next AI call', async t => {
  const config = { demo: true, maxRamPercent: 100, maxCpuPercent: 100, maxTokensPerJob: 1000,
    agents: [{ id: 'solo', label: 'solo', provider: 'mock' }],
    pipeline: { manager: 'solo', builders: ['solo'], reviewer: 'solo', verifier: 'solo' },
    projects: [{ id: 'test', path: process.cwd(), tests: [] }] };
  let calls = 0;
  const team = new Team(config, mkdtempSync(join(tmpdir(), 'ai-team-budget-')), { runAgent: (...a) => { calls++; return runAgent(...a); } });
  t.after(() => team.close());
  team.save({ id: 'budget', project: 'test', goal: 'x', status: 'queued', stage: 'plan', worktree: process.cwd(), tasks: [], taskIndex: 0, reports: [], messages: [], round: 0, usage: { calls: 7, tokens: 5000 } });
  await team.tick();
  const job = team.get('budget');
  assert.equal(job.status, 'blocked'); assert.match(job.error, /5000.*1000/); assert.equal(calls, 0);
  assert.equal(team.state().limits.tokens, 1000);
  // Tiếp tục: tính lại từ sự kiện USAGE (Codex: trừ phần cache); vẫn vượt thì cấp thêm một lượt ngân sách.
  team.event('budget', 'solo', 'controller', 'USAGE', 'u', { input_tokens: 900000, cached_input_tokens: 899500, output_tokens: 100 });
  await team.control('budget', 'resume'); let j = team.get('budget');
  assert.equal(j.usage.tokens, 600); assert.equal(j.tokenBudget, undefined); assert.equal(j.status, 'queued');
  team.save({ ...j, status: 'blocked', usage: { calls: 9, tokens: 5000 } }); team.event('budget', 'solo', 'controller', 'USAGE', 'u', { input_tokens: 2000, output_tokens: 0 });
  await team.control('budget', 'resume'); j = team.get('budget');
  assert.equal(j.usage.tokens, 2600); assert.equal(j.tokenBudget, 3600);
});

test('per-project access: folders and Internet per member; Leader proposes a draft that the owner saves', async t => {
  const f = await fixture();
  const agents = [{ id: 'lead', label: 'L', provider: 'mock' }, { id: 'b1', label: 'B1', provider: 'mock' }, { id: 'b2', label: 'B2', provider: 'mock' }];
  const docs = mkdtempSync(join(tmpdir(), 'docs-')), spec = mkdtempSync(join(tmpdir(), 'spec-'));
  let seen;
  const team = new Team({ ...f.config, agents, pipeline: { manager: 'lead', builders: ['b1', 'b2'], reviewer: 'lead', verifier: 'lead' } }, f.data, { runAgent: async (agent, task, prompt) => {
    seen = { agent: agent.id, readDirs: task.readDirs, prompt };
    return { summary: 'ok', status: 'completed', folders: [{ path: docs, members: ['b1', 'ghost'], why: 'API spec' }, { path: join(docs, 'missing'), members: ['*'] }], network: { members: ['b2'], why: 'npm docs' }, notes: ['check spec'] };
  } });
  t.after(() => team.close());
  const { Accounts } = await import('../src/accounts.js');
  const file = join(f.data, 'cfg.json'); writeFileSync(file, '{}');
  const accounts = new Accounts(team, file, process.cwd(), { commandAvailable: () => true }); t.after(() => accounts.close());
  const pid = f.config.projects[0].id;
  // Cấu hình cũ (readDirs cho mọi người) vẫn hiểu được; sửa bằng ô cũ thì chuyển sang access mà giữ quyền riêng.
  accounts.updateProject(pid, { readDirs: spec, network: false });
  assert.deepEqual(team.accessFor(pid, 'b2'), { readDirs: [spec], network: false, shell: true, delete: true, paths: [] });
  // Leader đề xuất: được đọc các thư mục ứng viên; bản nháp bỏ member/thư mục không có thật; chưa lưu gì.
  const r = await team.proposeAccess(pid, [docs]);
  assert.equal(seen.agent, 'lead'); assert(seen.readDirs.includes(docs)); assert.match(seen.prompt, /least privilege/);
  assert.deepEqual(r.draft, { folders: [{ path: docs, members: ['b1'], why: 'API spec' }], network: ['b2'], repos: [], paths: [], shell: ['*'] });
  assert.deepEqual(team.accessFor(pid, 'b1').readDirs, [spec]);
  // Bạn lưu: mỗi member chỉ thấy đúng thư mục/mạng được cấp.
  accounts.setAccess(pid, { folders: [...r.draft.folders, { path: spec, members: ['*'] }], network: r.draft.network });
  assert.deepEqual(team.accessFor(pid, 'b1').readDirs, [docs, spec]); assert.equal(team.accessFor(pid, 'b1').network, false);
  assert.equal(team.accessFor(pid, 'b2').network, true);
  assert.throws(() => accounts.setAccess(pid, { folders: [{ path: docs, members: ['ghost'] }] }), /ghost/);
  assert.throws(() => accounts.setAccess(pid, { folders: [{ path: join(docs, 'missing'), members: ['*'] }] }));
  assert.deepEqual(team.state().projects.find(p => p.id === pid).access.network, ['b2']);
});

test('linked repos: a job edits another registered project in its own worktree; tests, review and merge cover both; unpermitted edits stop the job', async t => {
  const f = await fixture(), lib = await fixture();
  const libProject = { id: 'lib', path: lib.path, tests: [[process.execPath, '-e', "require('node:fs').readFileSync('lib.txt')"]] };
  const make = (members) => {
    const config = { ...f.config, projects: [{ ...f.config.projects[0], access: { folders: [], network: [], repos: [{ project: 'lib', members }] } }, libProject] };
    const seen = [];
    const team = new Team(config, mkdtempSync(join(tmpdir(), 'ai-team-linked-')), { runAgent: async (agent, task, prompt, opts) => {
      seen.push({ agent: agent.id, stage: task.stage, addDirs: task.addDirs, readDirs: task.readDirs, prompt });
      if (task.stage === 'implement') writeFileSync(join(task.linked[0].worktree, 'lib.txt'), members.join() + '\n');
      return runAgent(agent, task, prompt, opts);
    } });
    t.after(() => team.close()); return { team, seen };
  };
  // Builder được cấp: sửa repo liên kết; test chạy ở cả hai; reviewer thấy diff liên kết; merge cả hai.
  const { team, seen } = make(['codex-2']);
  team.start();
  const job = await team.create({ project: 'test', goal: 'Update hello and the shared lib' });
  assert.equal(job.linked[0].project, 'lib');
  const ready = await settle(team, job.id, 'ready');
  const impl = seen.find(s => s.stage === 'implement');
  assert.deepEqual(impl.addDirs, [ready.linked[0].worktree]);
  const review = seen.find(s => s.stage === 'review');
  assert(review.readDirs.includes(ready.linked[0].worktree)); assert.match(review.prompt, /"linkedRepos"/); assert.match(review.prompt, /"writable":false/);
  assert.notEqual(ready.linked[0].revision, ready.linked[0].base);
  assert(team.events(job.id).some(e => e.type === 'TEST_START' && /^\[lib\]/.test(e.summary)));
  const log = await run(['git'], ['-C', ready.worktree, 'log', '--format=%s', '-3']); assert.match(log.stdout, /linked lib@/);
  assert.match((await team.diff(job.id)).diff, /### lib[\s\S]*lib\.txt/);
  const check = await team.mergeCheck(job.id);
  await team.merge(job.id, { confirm: check.code });
  assert.equal(readFileSync(join(lib.path, 'lib.txt'), 'utf8'), 'codex-2\n');
  assert.equal(readFileSync(join(f.path, 'hello.txt'), 'utf8'), 'Hello from AI Team demo!\n');
  // Builder không được cấp mà vẫn sửa repo liên kết → việc dừng.
  const other = make(['codex-4']);
  other.team.start();
  const bad = await other.team.create({ project: 'test', goal: 'Update hello again' });
  const blocked = await settle(other.team, bad.id, 'blocked');
  assert.match(blocked.error, /lib/);
});

test('memory: Leader keeps durable project notes and a session summary; next job sees them; backups and export work', async t => {
  const f = await fixture(), prompts = [];
  let round = 0;
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    prompts.push({ stage: task.stage, prompt });
    const r = await runAgent(agent, task, prompt, opts);
    if (task.stage === 'final') return { ...r, memory: round++ === 0 ? { add: ['hello.txt Tests: node --test', 'token sk-abcdefghijklmnopqrstuvwxyz123456 leaked'], session: 'Đang sửa hello.txt' } : { remove: [`M${team.memory('test').facts[0].id}`], session: 'Xong hello.txt' } };
    return r;
  } });
  t.after(() => team.close());
  team.start();
  const ses = team.createSession({ project: 'test', name: 'S' });
  const a = await team.create({ project: 'test', goal: 'Update hello', mode: 'full', sessionId: ses.id });
  await settle(team, a.id, 'ready');
  let m = team.memory('test', ses.id);
  assert.deepEqual(m.facts.map(x => x.text)[0], 'hello.txt Tests: node --test'); assert.doesNotMatch(m.facts[1].text, /sk-abcdef/);
  assert.equal(m.facts[0].scope, 'job');
  const firstMemoryId = `M${m.facts[0].id}`;
  assert.equal((await team.searchMemory({ project: 'test', query: 'hello' })).results.length, 0);
  assert.equal(m.summary, 'Đang sửa hello.txt'); assert.equal(m.log.length, 1); assert.match(m.log[0].text, /Update hello → ready/);
  await team.merge(a.id, { confirm: (await team.mergeCheck(a.id)).code });
  // Việc sau nhận ghi chú liên quan trực tiếp; chỉ phần tóm tắt phiên dành cho Leader.
  prompts.length = 0;
  const b = await team.create({ project: 'test', goal: 'Check hello again', mode: 'full', sessionId: ses.id });
  await settle(team, b.id, 'ready');
  const plan = prompts.find(p => p.stage === 'plan').prompt, fin = prompts.find(p => p.stage === 'final').prompt, impl = prompts.find(p => p.stage === 'implement').prompt;
  assert.match(plan, /Tests: node --test/); assert.match(plan, /Đang sửa hello.txt/); assert.match(plan, new RegExp(a.id));
  assert.match(fin, /M\d+: hello.txt Tests: node --test/); assert.match(fin, /"memory":\{"add"/);
  assert.match(impl, /Tests: node --test/);
  assert.equal((await team.searchMemory({ project: 'test', job: b.id, memoryId: firstMemoryId })).results.length, 0);
  assert(team.memory('test').facts.some(x => x.text === 'hello.txt Tests: node --test'));
  await team.merge(b.id, { confirm: (await team.mergeCheck(b.id)).code });
  m = team.memory('test', ses.id);
  assert(!m.facts.some(x => x.text === 'hello.txt Tests: node --test')); assert.equal(m.summary, 'Xong hello.txt'); assert.equal(m.log.length, 2);
  assert(team.memory('test', ses.id, true).facts.some(x => x.text === 'hello.txt Tests: node --test' && x.status === 'superseded'));
  // Bạn sửa tay; sao lưu; xuất Markdown.
  team.editMemory({ project: 'test', session: ses.id, add: 'Dùng tiếng Việt trong UI' });
  assert(team.memory('test').facts.some(x => x.text === 'Dùng tiếng Việt trong UI'));
  const file = team.backup('manual'); assert(readFileSync(file).length > 0); assert.equal(team.backups().length >= 1, true);
  const md = await team.exportJob(b.id); assert.match(md, /^# Check hello again/); assert.match(md, /## Báo cáo/);
  await team.control(b.id, 'delete');
  assert(team.backups().some(x => /before-delete/.test(x.file)));
});

test('memory retrieval retains old facts, respects branch and file snapshots, and imports without overwriting conflicts', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); team.closed = true; t.after(() => team.close());
  team.editMemory({ project: 'test', add: 'quota UNKNOWN không được coi là 100%' });
  for (let i = 0; i < 70; i++) team.editMemory({ project: 'test', add: `Unrelated note ${i}` });
  const a = await team.create({ project: 'test', goal: 'Memory check', paused: true });
  await team.remember(a, null);
  assert.equal(team.memory('test').facts.length, 71);
  assert.equal((await team.searchMemory({ project: 'test', query: 'quota UNKNOWN' })).results[0].text, 'quota UNKNOWN không được coi là 100%');
  const oldest = team.memory('test').facts[0];
  assert.equal((await team.searchMemory({ project: 'test', memoryId: `M${oldest.id}` })).results[0].id, oldest.id);
  await assert.rejects(team.searchMemory({ project: 'test', memoryId: 'Minvalid' }), /Invalid memory id/);
  team.editMemory({ project: 'test', add: 'Quyết định dùng SQLite' });
  assert.equal((await team.searchMemory({ project: 'test', query: 'quyet dinh' })).results.length, 1);
  team.editMemory({ project: 'test', add: '日本語の設計を維持' });
  assert.equal((await team.searchMemory({ project: 'test', query: '日本語' })).results.length, 1);
  const dependent = team.memoryStore.add({ project: 'test', text: 'hello file observation', commitSha: a.base, files: { 'hello.txt': fileHash(a.worktree, 'hello.txt') } });
  assert.equal((await team.searchMemory({ project: 'test', job: a.id, memoryId: `M${dependent}` })).results.length, 1);
  writeFileSync(join(a.worktree, 'hello.txt'), 'changed without committing');
  assert.equal((await team.searchMemory({ project: 'test', job: a.id, memoryId: `M${dependent}` })).results.length, 0);
  assert.equal((await team.searchMemory({ project: 'test', memoryId: `M${dependent}` })).results.length, 1);
  await team.remember(a, { add: ['branchOnlyMarker'], remove: [`M${oldest.id}`] });
  const b = await team.create({ project: 'test', goal: 'Other branch', paused: true });
  assert.equal((await team.searchMemory({ project: 'test', job: b.id, query: 'branchOnlyMarker' })).results.length, 0);
  assert.equal((await team.searchMemory({ project: 'test', job: a.id, query: 'branchOnlyMarker' })).results.length, 1);
  assert.equal((await team.searchMemory({ project: 'test', job: a.id, memoryId: `M${oldest.id}` })).results.length, 0);
  assert.equal((await team.searchMemory({ project: 'test', job: b.id, memoryId: `M${oldest.id}` })).results.length, 1);
  const pack = team.memoryStore.export('test'), before = team.memory('test', null, true).facts.length;
  assert.equal(team.memoryStore.import('test', pack).added, 0);
  const conflict = structuredClone(pack); conflict.records[0].text = 'An incompatible update';
  assert(team.memoryStore.import('test', conflict).conflicts >= 1);
  assert.equal(team.memory('test', null, true).facts.length, before);
  assert.equal(team.memory('test').facts[0].text, oldest.text);
  const invalid = structuredClone(pack); invalid.records[1].files = { '../escape': null };
  assert.throws(() => team.memoryStore.import('test', invalid), /fingerprint/);
  assert.equal(team.memory('test', null, true).facts.length, before);
  team.editMemory({ project: 'test', remove: oldest.id, revision: oldest.revision });
  assert.throws(() => team.editMemory({ project: 'test', remove: oldest.id, revision: oldest.revision }), /reload/);
});

test('legacy memory migration preserves ids and isolates notes from unmerged jobs', async () => {
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE memory(id INTEGER PRIMARY KEY,project TEXT,session TEXT,kind TEXT,text TEXT,job TEXT,at TEXT);`);
    db.prepare('INSERT INTO jobs VALUES(?,?)').run('old-job', JSON.stringify({ kind: 'code', status: 'ready' }));
    db.prepare('INSERT INTO memory(id,project,kind,text,job,at) VALUES(1,?,?,?,?,?)').run('old-project', 'fact', 'legacy shared convention', 'user', new Date().toISOString());
    db.prepare('INSERT INTO memory(id,project,kind,text,job,at) VALUES(2,?,?,?,?,?)').run('old-project', 'fact', 'unmerged branch observation', 'old-job', new Date().toISOString());
    const store = new MemoryStore(db, redact), before = store.rows('old-project');
    assert.equal(before.length, 2); assert.equal(before[0].id, 1); assert.equal(before[1].scope, 'job');
    assert.equal(store.candidates('old-project', null, '').length, 1);
    assert.equal(store.candidates('old-project', 'old-job', '').length, 2);
    assert.deepEqual(new MemoryStore(db, redact).rows('old-project').map(r => r.uid), before.map(r => r.uid));
  } finally { db.close(); }
});

test('peer dialogue releases the only slot, carries unfinished code, and keeps independent review gates', async t => {
  const f = await fixture(), seen = [];
  f.config.projects[0].access = { folders: [{ path: f.path, members: ['codex-2', 'codex-4'] }, { path: f.data, members: ['codex-4'] }], network: ['codex-4'], shell: ['*'] };
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    seen.push([agent.id, task.stage]); assert.equal(team.slotKeys().length, 1);
    const discussion = task.discussions?.at(-1);
    if (task.stage === 'implement') {
      if (!discussion) {
        writeFileSync(join(task.worktree, 'hello.txt'), 'incorrect assumption\n');
        writeFileSync(join(task.worktree, 'partial.txt'), 'unfinished evidence\n');
        return { summary: 'Need the expected greeting', status: 'waiting_for_reply', peerRequest: { to: 'codex-4', topic: 'Greeting contract', claim: 'Use an arbitrary greeting', question: 'What exact greeting does the test require?', evidence: ['hello.txt:1'] }, checkpoint: { done: 'Drafted greeting', remaining: 'Confirm contract', next: 'Ask codex-4' } };
      }
      assert(prompt.includes('The assertion requires Hello from AI Team demo!'));
      assert(prompt.includes('Drafted greeting')); assert(!task.tasks[0].done);
      writeFileSync(join(task.worktree, 'hello.txt'), 'Hello from AI Team demo!\n');
      return { summary: 'Corrected the assumption', status: 'completed', dialogueDecision: { thread: discussion.id, outcome: 'accepted', reason: 'Used the assertion as the contract', evidence: ['configured test assertion'] } };
    }
    if (task.stage === 'consult') {
      assert.equal(task.network, false); assert.equal(task.researchWeb, false); assert.deepEqual(task.checks, []);
      assert(!task.readDirs.includes(f.data)); assert.notEqual(task.worktree, task.tasks[0]?.worktree || team.get(task.id).worktree);
      if (discussion.stage === 'implement') {
        assert.equal(agent.id, 'codex-4'); assert(prompt.includes('What exact greeting does the test require?'));
        assert.equal(readFileSync(join(task.worktree, 'partial.txt'), 'utf8'), 'unfinished evidence\n');
        assert.equal(readFileSync(join(task.worktree, 'hello.txt'), 'utf8'), 'incorrect assumption\n');
        return { summary: 'Contract evidence', status: 'completed', stance: 'disagree', answer: 'The assertion requires Hello from AI Team demo!', evidence: ['configured test assertion'] };
      }
      assert.equal(agent.id, 'codex-2'); assert(prompt.includes('Explain why the greeting changed'));
      return { summary: 'Author explanation', status: 'completed', stance: 'answer', answer: 'Changed it to satisfy the configured assertion', evidence: ['hello.txt:1'] };
    }
    if (task.stage === 'review') {
      if (discussion?.stage !== 'review') return { summary: 'Ask the author', status: 'waiting_for_reply', peerRequest: { to: 'codex-2', topic: 'Author explanation', claim: 'Greeting change is necessary', question: 'Explain why the greeting changed', evidence: ['hello.txt:1'] } };
      assert(prompt.includes('Changed it to satisfy the configured assertion'));
      assert.equal(task.tested, task.revision);
      const report = await runAgent(agent, task, prompt, opts);
      return { ...report, dialogueDecision: { thread: discussion.id, outcome: 'accepted', reason: 'Reviewed the diff and test evidence independently', evidence: ['hello.txt:1'] } };
    }
    return runAgent(agent, task, prompt, opts);
  } });
  team.capacity = () => ({ start: team.runs.size ? 0 : 1, hardStop: false }); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello with a peer question' });
  const ready = await settle(team, job.id, 'ready', 40000);
  assert.equal(ready.discussions.length, 2); assert(ready.discussions.every(d => d.status === 'resolved' && d.messages.length === 2));
  assert.equal(ready.tasks[0].done, true); assert.equal(ready.reviewed, ready.revision); assert.equal(ready.tested, ready.revision);
  assert.equal(ready.metrics.peerQuestions, 2); assert.equal(ready.metrics.peerReplies, 2); assert.equal(ready.metrics.peerResolved, 2);
  assert.equal(seen.filter(([, s]) => s === 'plan').length, 1); assert.equal(seen.filter(([, s]) => s === 'consult').length, 2);
  assert.equal(team.useOf('codex-2'), 0); assert.equal(team.memoryReaders.size, 0);
  assert.equal(readFileSync(join(f.path, 'hello.txt'), 'utf8'), 'Hello!\n');
  const md = await team.exportJob(job.id); assert(md.includes('## Đối thoại theo vấn đề')); assert(md.includes('What exact greeting does the test require?'));
  assert(!team.memory('test').facts.some(m => m.text.includes('What exact greeting')));
  await team.merge(job.id); assert.equal(team.get(job.id).status, 'merged');
});

test('peer dialogue limit preserves parallel partial work and resumes the same stage with human guidance', async t => {
  const f = await fixture(); let consults = 0, plans = 0;
  const agentRun = async (agent, task, prompt, opts) => {
    const d = task.discussions?.findLast(d => d.stage === 'implement' && d.task === 0);
    if (task.stage === 'plan') { plans++; return { summary: 'Two independent tasks', kind: 'code', rigor: 'standard', risk: 'low', tasks: [{ agent: 'codex-2', difficulty: 2, instruction: 'Uncertain greeting', files: ['hello.txt', 'partial.txt'], dependsOn: [] }, { agent: 'codex-4', difficulty: 2, instruction: 'Independent file', files: ['other.txt'], dependsOn: [] }] }; }
    if (task.stage === 'consult') { consults++; return { summary: 'Still uncertain', status: 'completed', stance: 'disagree', answer: 'The assumption remains unsupported', evidence: ['hello.txt:1'] }; }
    if (task.stage === 'implement' && task.tasks[task.running.find(r => r.agent === agent.id && r.stage === 'implement').task].instruction === 'Independent file') { writeFileSync(join(task.worktree, 'other.txt'), 'completed parallel work\n'); return { summary: 'Independent task complete', status: 'completed' }; }
    if (task.stage === 'implement') {
      if (task.messages.some(m => m.text === 'Use the configured greeting')) {
        assert.equal(readFileSync(join(task.worktree, 'partial.txt'), 'utf8'), 'keep partial work\n'); assert(prompt.includes('The assumption remains unsupported'));
        writeFileSync(join(task.worktree, 'hello.txt'), 'Hello from AI Team demo!\n');
        return { summary: 'Followed human guidance', status: 'completed', dialogueDecision: { thread: d.id, outcome: 'accepted', reason: 'Human chose the configured contract', evidence: ['human message'] } };
      }
      writeFileSync(join(task.worktree, 'partial.txt'), 'keep partial work\n'); writeFileSync(join(task.worktree, 'hello.txt'), 'partial greeting\n');
      return { summary: 'Need a decision', status: 'waiting_for_reply', peerRequest: { to: 'codex-3', ...(d ? { thread: d.id } : {}), topic: 'Uncertain greeting', claim: 'Current draft is sufficient', question: 'Can you confirm the contract?', evidence: ['hello.txt:1'] }, checkpoint: { done: 'Partial greeting saved', remaining: 'Contract decision', next: 'Resolve uncertainty' } };
    }
    return runAgent(agent, task, prompt, opts);
  };
  const team = new Team(f.config, f.data, { runAgent: agentRun }); t.after(() => team.close());
  team.capacity = () => ({ start: Math.max(0, 2 - team.runs.size - team.extra), hardStop: false });
  const job = await team.create({ project: 'test', goal: 'Update greeting and another file' });
  const waiting = await settle(team, job.id, 'waiting', 40000);
  assert.equal(consults, 2); assert.equal(waiting.stage, 'implement'); assert.equal(waiting.tasks[0].done, false); assert.equal(waiting.tasks[1].done, true);
  assert.equal(waiting.discussions[0].rounds, 2); assert.equal(waiting.discussions[0].status, 'unresolved'); assert.equal(waiting.tested, null);
  assert.equal(readFileSync(join(waiting.worktree, 'hello.txt'), 'utf8'), 'partial greeting\n');
  assert.equal(readFileSync(join(waiting.worktree, 'other.txt'), 'utf8'), 'completed parallel work\n');
  assert.equal((await run(['git'], ['-C', waiting.worktree, 'status', '--porcelain'])).stdout.trim(), '');
  await assert.rejects(team.merge(job.id)); await team.close();
  const reopened = new Team(f.config, f.data, { runAgent: agentRun }); t.after(() => reopened.close());
  reopened.capacity = () => ({ start: reopened.runs.size ? 0 : 1, hardStop: false });
  await reopened.control(job.id, 'message', { message: 'Use the configured greeting' });
  assert.equal(reopened.get(job.id).stage, 'implement');
  const ready = await settle(reopened, job.id, 'ready', 40000);
  assert.equal(plans, 1); assert.equal(consults, 2); assert(ready.tasks.every(t => t.done)); assert.equal(ready.discussions[0].status, 'resolved');
  assert.equal(ready.tested, ready.revision); assert.equal(ready.reviewed, ready.revision);
});

test('pausing a consultation preserves its parallel child checkpoint before releasing the worktree', async t => {
  const f = await fixture(); let paused = false, questions = 0;
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'plan') return { summary: 'Parallel tasks', kind: 'code', rigor: 'standard', risk: 'low', tasks: [{ agent: 'codex-2', difficulty: 2, instruction: 'Ask a peer', files: ['hello.txt'], dependsOn: [] }, { agent: 'codex-4', difficulty: 2, instruction: 'Other file', files: ['other.txt'], dependsOn: [] }] };
    if (task.stage === 'consult') {
      assert.equal(readFileSync(join(task.worktree, 'hello.txt'), 'utf8'), 'checkpoint before pause\n');
      return { summary: 'Reply after resume', status: 'completed', stance: 'answer', answer: 'Use the configured greeting', evidence: ['hello.txt:1'] };
    }
    if (task.stage === 'implement') {
      const i = task.running.find(r => r.agent === agent.id && r.stage === 'implement').task;
      if (i === 1) { writeFileSync(join(task.worktree, 'other.txt'), 'parallel sibling\n'); return { summary: 'Other file saved', status: 'completed' }; }
      const d = task.discussions?.at(-1);
      if (!d) { questions++; writeFileSync(join(task.worktree, 'hello.txt'), 'checkpoint before pause\n'); return { summary: 'Need contract', status: 'waiting_for_reply', peerRequest: { to: 'codex-3', topic: 'Contract', question: 'Which greeting?' } }; }
      assert(prompt.includes('Use the configured greeting')); writeFileSync(join(task.worktree, 'hello.txt'), 'Hello from AI Team demo!\n');
      return { summary: 'Resolved after resume', status: 'completed', dialogueDecision: { thread: d.id, outcome: 'accepted', reason: 'Checked the contract' } };
    }
    return runAgent(agent, task, prompt, opts);
  } }); t.after(() => team.close());
  const callOnce = team.callOnce.bind(team);
  team.callOnce = async (...args) => {
    const report = await callOnce(...args);
    if (args[2] === 'consult' && !paused) { paused = true; await team.control(args[0].id, 'pause'); }
    return report;
  };
  team.capacity = () => ({ start: Math.max(0, 2 - team.runs.size - team.extra), hardStop: false });
  const job = await team.create({ project: 'test', goal: 'Update hello and another file' });
  const stopped = await settle(team, job.id, 'paused', 40000);
  assert.equal(stopped.discussions[0].status, 'pending'); assert(!stopped.tasks[0].done);
  assert.equal(readFileSync(join(stopped.worktree, 'hello.txt'), 'utf8'), 'checkpoint before pause\n');
  assert.equal((await run(['git'], ['-C', stopped.worktree, 'rev-parse', 'HEAD'])).stdout.trim(), stopped.revision);
  assert.equal(team.slotKeys().length, 0);
  await team.control(job.id, 'resume'); const ready = await settle(team, job.id, 'ready', 40000);
  assert.equal(questions, 1); assert.equal(ready.discussions[0].rounds, 1); assert.equal(ready.discussions[0].status, 'resolved');
});

test('pending peer questions survive pause without duplication; invalid recipients and edits are rejected', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); team.closed = true; t.after(async () => { team.runs.clear(); await team.close(); });
  const job = await team.create({ project: 'test', goal: 'Peer recovery', paused: true });
  job.tasks = [{ instruction: 'Ask about hello', difficulty: 2, done: false }]; team.save(job);
  const opts = { task: job.tasks[0], taskIndex: 0 }, state = { agents: new Set(), abort: new AbortController() }; team.runs.set(job.id, state);
  t.after(() => team.runs.clear());
  for (const to of ['codex-2', 'outside']) {
    team.agentRun = async () => ({ summary: 'Invalid recipient', status: 'waiting_for_reply', peerRequest: { to, topic: 'Contract', question: 'Confirm it?' } });
    await assert.rejects(team.call(job, 'codex-2', 'implement', 'Ask about hello', undefined, [], opts), /Invalid peerRequest/);
  }
  let sourceCalls = 0;
  team.agentRun = async (agent, task) => {
    if (task.stage === 'consult') { state.abort.abort(new DOMException('Paused', 'AbortError')); throw state.abort.signal.reason; }
    sourceCalls++; writeFileSync(join(task.worktree, 'hello.txt'), 'saved draft\n');
    return { summary: 'Ask contract', status: 'waiting_for_reply', peerRequest: { to: 'codex-4', topic: 'Contract', question: 'Confirm exact greeting?' }, checkpoint: { done: 'Saved draft', next: 'Resolve contract' } };
  };
  await assert.rejects(team.call(job, 'codex-2', 'implement', 'Ask about hello', undefined, [], opts), /Paused/);
  assert.equal(team.slotKeys().length, 0); assert.equal(team.get(job.id).discussions[0].status, 'pending');
  const persisted = team.get(job.id); team.runs.clear(); await team.close();
  const reopened = new Team(f.config, f.data); reopened.closed = true; t.after(async () => { reopened.runs.clear(); await reopened.close(); });
  reopened.runs.set(job.id, { agents: new Set(), abort: new AbortController() }); t.after(() => reopened.runs.clear());
  reopened.agentRun = async (agent, task, prompt) => {
    if (task.stage === 'consult') {
      assert.equal(readFileSync(join(task.worktree, 'hello.txt'), 'utf8'), 'saved draft\n');
      await reopened.control(job.id, 'message', { message: 'Human guidance during consultation' });
      return { summary: 'Recovered reply', status: 'completed', stance: 'answer', answer: 'Use the configured contract', evidence: ['hello.txt:1'] };
    }
    sourceCalls++; assert(prompt.includes('Use the configured contract')); assert(prompt.includes('Human guidance during consultation'));
    return { summary: 'Resolved', status: 'completed', dialogueDecision: { thread: persisted.discussions[0].id, outcome: 'accepted', reason: 'Examined the evidence' } };
  };
  await reopened.call(persisted, 'codex-2', 'implement', 'Ask about hello', undefined, [], { task: persisted.tasks[0], taskIndex: 0 });
  assert.equal(sourceCalls, 2); assert.equal(persisted.discussions[0].messages.length, 2); assert.equal(persisted.discussions[0].rounds, 1);
  assert.equal(reopened.get(job.id).messages.at(-1).text, 'Human guidance during consultation');
  reopened.agentRun = async (agent, task) => task.stage === 'consult'
    ? (writeFileSync(join(task.worktree, 'hello.txt'), 'unauthorized edit\n'), { summary: 'Bad reply', status: 'completed', stance: 'agree', answer: 'Edited the file' })
    : { summary: 'New question', status: 'waiting_for_reply', peerRequest: { to: 'codex-4', topic: 'Another issue', question: 'Examine current draft?' } };
  await assert.rejects(reopened.call(persisted, 'codex-2', 'implement', 'Another issue', undefined, [], { task: persisted.tasks[0], taskIndex: 0 }), e => e.peerWait && /chỉ đọc/.test(e.message));
  assert.equal(readFileSync(join(persisted.worktree, 'hello.txt'), 'utf8'), 'saved draft\n');
  assert.equal(reopened.slotKeys().length, 0);
  assert.throws(() => validateConfig({ ...f.config, peerDialogue: 'yes' }), /boolean/);
});

test('work transfer preserves binary/new/deleted files and checkpoints but imports paused without approvals or credentials', async t => {
  const f = await fixture(), source = new Team(f.config, f.data); source.closed = true; t.after(() => source.close());
  writeFileSync(join(f.path, 'remove.txt'), 'Remove this file');
  await run(['git'], ['-C', f.path, 'add', '.']);
  await run(['git'], ['-C', f.path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'deletion fixture']);
  const job = await source.create({ project: 'test', goal: 'Continue imported hello', paused: true });
  job.tasks = [{ instruction: 'Finish hello', done: false, checkpoint: { done: 'Started hello', remaining: 'Verify the result', next: 'Run tests' } }]; source.save(job);
  job.discussions = [{ id: 'D-history', status: 'pending', from: 'old-member', to: 'old-peer', messages: [{ text: 'Old question is source data' }], rounds: 1 }]; source.save(job);
  source.editMemory({ project: 'test', add: 'Shared project convention' });
  await source.remember(job, { add: ['Pending job observation'] });
  writeFileSync(join(job.worktree, 'hello.txt'), 'unfinished hello');
  writeFileSync(join(job.worktree, 'binary.dat'), Buffer.from([0, 255, 1, 200]));
  rmSync(join(job.worktree, 'remove.txt'));
  const pack = await exportTransfer(source, job.id);
  assert.equal(pack.format, 'ai-team-transfer'); assert.equal(pack.work.tasks[0].checkpoint.remaining, 'Verify the result');
  const copy = mkdtempSync(join(tmpdir(), 'ai-team-import-'));
  await run(['git'], ['clone', f.path, copy]);
  const config = structuredClone(f.config); config.projects[0].path = copy;
  const target = new Team(config, mkdtempSync(join(tmpdir(), 'ai-team-import-state-'))); target.closed = true; t.after(() => target.close());
  const result = await importTransfer(target, 'test', pack), imported = result.job;
  assert.equal(imported.status, 'paused'); assert.equal(imported.stage, 'plan'); assert.equal(imported.tested, null); assert.equal(imported.reviewed, null); assert.equal(imported.verified, null);
  assert.equal(readFileSync(join(imported.worktree, 'hello.txt'), 'utf8'), 'unfinished hello');
  assert.deepEqual(readFileSync(join(imported.worktree, 'binary.dat')), Buffer.from([0, 255, 1, 200]));
  assert.throws(() => readFileSync(join(imported.worktree, 'remove.txt')), /ENOENT/);
  assert.equal(imported.transfer.tasks[0].checkpoint.next, 'Run tests'); assert.deepEqual(imported.tasks, []);
  assert.equal(imported.transfer.discussions[0].id, 'D-history'); assert.equal(imported.discussions, undefined);
  assert.equal(imported.obligations[0].id, 'D-history'); assert.equal(imported.obligations[0].status, 'unmapped');
  assert.equal(JSON.parse(readFileSync(join(imported.worktree, imported.transferFile), 'utf8')).tasks[0].checkpoint.next, 'Run tests');
  let planPrompt;
  target.agentRun = async (agent, task, prompt, opts) => { planPrompt = prompt; return runAgent(agent, task, prompt, opts); };
  await target.invoke(imported, 'codex-1', 'plan', 'Inspect imported work', undefined, [], {}, target.agent('codex-1'), new AbortController().signal);
  assert(planPrompt.includes(imported.transferFile)); assert(!planPrompt.includes('Run tests'));
  target.agentRun = async () => { writeFileSync(join(imported.worktree, 'binary.dat'), Buffer.from([0, 255, 2, 200])); return { summary: 'changed a pending file', status: 'planned' }; };
  await assert.rejects(target.invoke(imported, 'codex-1', 'plan', 'Read only', undefined, [], {}, target.agent('codex-1'), new AbortController().signal), /chỉ đọc/);
  writeFileSync(join(imported.worktree, 'binary.dat'), Buffer.from([0, 255, 1, 200]));
  assert.equal((await exportTransfer(target, imported.id)).work.tasks[0].checkpoint.next, 'Run tests');
  imported.tasks = [{ instruction: 'Recheck transferred issue', files: ['hello.txt'], agent: 'codex-2' }]; target.save(imported);
  await assert.rejects(target.control(imported.id, 'adopt-discussion', { thread: 'D-history', task: 0, recipient: 'old-peer' }), /current member/);
  const adopted = await target.control(imported.id, 'adopt-discussion', { thread: 'D-history', task: 0, recipient: 'gemini' });
  assert.equal(adopted.obligations[0].status, 'adopted'); assert.equal(adopted.discussions[0].to, 'gemini'); assert.equal(adopted.discussions[0].status, 'reopened'); assert.equal(adopted.discussions[0].requestReport, undefined);
  assert.equal(adopted.tested, null); assert.equal(adopted.discussions[0].source.thread, 'D-history');
  const reexported = await exportTransfer(target, imported.id);
  assert(reexported.work.obligations.every(o => o.id !== 'D-history'));
  const reimported = await importTransfer(target, 'test', reexported);
  assert.equal(reimported.job.obligations.length, 1); assert.equal(reimported.job.obligations[0].id, adopted.discussions[0].id);
  assert(target.memory('test').facts.some(r => r.scope === 'job' && r.job === imported.id));
  assert.equal(readFileSync(join(copy, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n'), 'Hello!\n');
  const unsafe = structuredClone(pack); unsafe.code.files[0].path = '../escape';
  const count = target.jobs().length;
  await assert.rejects(importTransfer(target, 'test', unsafe), /Unsafe/); assert.equal(target.jobs().length, count);
  const corrupt = structuredClone(pack); corrupt.code.sha256 = '0'.repeat(64);
  await assert.rejects(importTransfer(target, 'test', corrupt), /checksum/); assert.equal(target.jobs().length, count);
  writeFileSync(join(job.worktree, '.env'), 'PRIVATE_KEY=must not transfer');
  await run(['git'], ['-C', job.worktree, 'add', '-f', '.env']);
  await assert.rejects(exportTransfer(source, job.id), /Unsafe/);
  assert.equal(source.runs.size, 0);
});

test('Codex task resume reuses only the same profile/worktree/permissions, checkpoints survive a blocker, and memory credentials expire', async t => {
  const f = await fixture(); f.config.resumeCodexTasks = true;
  f.config.agents.find(a => a.id === 'codex-2').provider = 'codex';
  f.config.agents.find(a => a.id === 'codex-2').home = mkdtempSync(join(tmpdir(), 'ai-team-resume-home-'));
  const calls = []; let team;
  team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'implement') {
      const token = agent.mcp.team_memory.env.TEAM_MEMORY_TOKEN;
      assert.equal(team.memoryReaders.get(token).job, task.id);
      calls.push({ sessionId: task.sessionId, token });
      opts.onEvent('SESSION', { summary: 'session', details: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } });
      if (calls.length === 1) return { summary: 'Needs another step', status: 'blocked', checkpoint: { done: 'Located hello', remaining: 'Update hello', next: 'Continue implementation' } };
    }
    return runAgent({ ...agent, provider: 'mock' }, task, prompt, opts);
  } });
  t.after(() => team.close()); team.start();
  const job = await team.create({ project: 'test', goal: 'Update hello', mode: 'full' });
  const blocked = await settle(team, job.id, 'blocked');
  assert.equal(blocked.tasks[0].checkpoint.next, 'Continue implementation'); assert.equal(team.memoryReaders.size, 0);
  await team.control(job.id, 'resume');
  const ready = await settle(team, job.id, 'ready');
  assert.equal(calls[0].sessionId, undefined); assert.equal(calls[1].sessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(team.memoryReaders.size, 0); assert.equal(ready.tasks[0].checkpoint.done.includes('DEMO'), true);
  // A permission change invalidates the saved conversation, even for the same member and task.
  ready.tasks[0].done = false; ready.status = 'paused'; ready.stage = 'implement'; team.save(ready); team.config.roleCaps = { builder: { network: false } };
  f.config.projects[0].access = { network: ['codex-2'] }; team.config.projects[0].access = f.config.projects[0].access;
  // The first context had no network grant; make an effective permission change here.
  team.config.roleCaps.builder.network = true;
  await team.control(job.id, 'resume'); await settle(team, job.id, 'ready');
  assert.equal(calls[2].sessionId, undefined);
});

test('Codex CLI resume passes the session explicitly and reads the new prompt through stdin', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-team-cli-check-')), cli = join(home, 'fake.cjs');
  writeFileSync(join(home, 'auth.json'), '{}');
  writeFileSync(cli, `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk=>input+=chunk); process.stdin.on('end',()=>{
    console.log(JSON.stringify({type:'thread.started',thread_id:'test-session'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'ok',status:'completed',args:process.argv.slice(2),input})}}));
  });`);
  const events = [], prompt = 'Continue the task: $(literal) & keep this text';
  const report = await runAgent({ id: 'cli', provider: 'codex', home, command: [process.execPath, cli], model: 'test-model' }, { stage: 'implement', worktree: home, sessionId: 'test-session' }, prompt, { onEvent: (type, data) => events.push({ type, data }) });
  assert.deepEqual(report.args.slice(-3), ['resume', 'test-session', '-']);
  assert.equal(report.args[0], 'exec'); assert.equal(report.input, prompt);
  assert(events.some(e => e.type === 'SESSION' && e.data.details.id === 'test-session' && e.data.details.resumed));
});

test('load balancing: an account with spare slots does not take every parallel task while other builders are idle', async t => {
  const { team, spans } = await parallelTeam(t, [
    { agent: 'codex-2', difficulty: 2, instruction: 'T1 edit', files: ['t1.txt'], dependsOn: [], estMinutes: 5 },
    { agent: 'codex-2', difficulty: 2, instruction: 'T2 edit', files: ['t2.txt'], dependsOn: [], estMinutes: 5 },
  ]);
  team.config.maxJobsPerAccount = 3;
  team.start();
  const job = await team.create({ project: 'test', goal: 'Balance' });
  await settle(team, job.id, 'ready');
  assert.notEqual(spans.find(s => s.n === 1).agent, spans.find(s => s.n === 2).agent);
});

test('per-folder permissions per AI: reviewer view-only, builder edits src but not tests; deletes need delete; session sets override the project; role ceilings and shell stop', async t => {
  const f = await fixture();
  const { mkdirSync, existsSync } = await import('node:fs');
  mkdirSync(join(f.path, 'src')); mkdirSync(join(f.path, 'test'));
  writeFileSync(join(f.path, 'src', 'a.js'), '1\n'); writeFileSync(join(f.path, 'test', 'a.test.js'), 't\n');
  await run(['git'], ['-C', f.path, 'add', '.']); await run(['git'], ['-C', f.path, '-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-m', 'dirs']);
  const { levelFor, capsOf } = await import('../src/team.js');
  const paths = [{ path: 'src', grant: { '*': 'read', 'codex-2': 'edit' } }, { path: 'src/gen', grant: { '*': 'read' } }, { path: 'test', grant: { '*': 'read' } }];
  assert.equal(levelFor(paths, 'src/a.js', 'codex-2'), 'edit'); assert.equal(levelFor(paths, 'src/gen/x.js', 'codex-2'), 'read');
  assert.equal(levelFor(paths, 'src/a.js', 'gemini'), 'read'); assert.equal(levelFor(paths, 'srcx/a.js', 'codex-2'), null);
  assert.equal(capsOf({ roleCaps: { builder: { delete: false, merge: true } } }).builder.delete, false);
  assert.equal(capsOf({ roleCaps: { builder: { merge: true } } }).builder.merge, undefined);
  // Builder sửa hello + src (được phép) nhưng cũng sửa test (không được) → file test bị hoàn tác, việc dừng.
  const make = (access, act, extra = {}) => {
    const team = new Team({ ...f.config, ...extra, projects: [{ ...f.config.projects[0], access }] }, mkdtempSync(join(tmpdir(), 'ai-team-perm-')), { runAgent: async (agent, task, prompt, opts) => {
      if (task.stage === 'implement') act(task, opts);
      return runAgent(agent, task, prompt, opts);
    } });
    t.after(() => team.close()); team.start(); return team;
  };
  const base = { folders: [], network: [], repos: [], paths: [{ path: 'src', grant: { '*': 'edit' } }, { path: 'test', grant: { '*': 'read' } }] };
  let team = make(base, task => { writeFileSync(join(task.worktree, 'src', 'a.js'), '2\n'); writeFileSync(join(task.worktree, 'test', 'a.test.js'), 'hacked\n'); });
  let job = await team.create({ project: 'test', goal: 'Update hello and src' });
  let blocked = await settle(team, job.id, 'blocked');
  assert.match(blocked.error, /test\/a\.test\.js/); assert.doesNotMatch(blocked.error, /src\/a\.js/);
  assert.equal(readFileSync(join(blocked.worktree, 'test', 'a.test.js'), 'utf8'), 't\n');
  assert.equal(readFileSync(join(blocked.worktree, 'src', 'a.js'), 'utf8'), '2\n');
  assert(team.events(job.id).some(e => e.type === 'PERMISSION'));
  // Mức "edit" không cho xóa.
  team = make(base, task => rmSync(join(task.worktree, 'src', 'a.js')));
  job = await team.create({ project: 'test', goal: 'Remove src a' });
  blocked = await settle(team, job.id, 'blocked');
  assert.match(blocked.error, /src\/a\.js/); assert(existsSync(join(blocked.worktree, 'src', 'a.js')));
  // Phiên có bộ quyền riêng: cho phép xóa trong src → qua được; dự án khác phiên vẫn giữ mặc định.
  const { accessList } = await import('../src/accounts.js');
  job = await team.create({ project: 'test', goal: 'Remove src a again' });
  team.setSessionAccess(job.sessionId, accessList({ ...base, paths: [{ path: 'src', grant: { '*': 'delete' } }] }, f.config.agents.map(a => a.id), ['test'], 'test'));
  assert.equal(team.accessFor('test', 'codex-2', job.sessionId, 'implement').paths[0].grant['*'], 'delete');
  assert.equal(team.accessFor('test', 'codex-2', null, 'implement').paths[0].grant['*'], 'edit');
  await settle(team, job.id, 'ready');
  assert.throws(() => accessList({ paths: [{ path: '../x' }] }, ['codex-2'], ['test'], 'test'), /\.\./);
  // Trần vai trò: builder không được xóa ở bất kỳ đâu.
  team = make({ ...base, paths: [] }, task => rmSync(join(task.worktree, 'src', 'a.js')), { roleCaps: { builder: { delete: false } } });
  job = await team.create({ project: 'test', goal: 'Remove src a with ceiling' });
  blocked = await settle(team, job.id, 'blocked'); assert.match(blocked.error, /src\/a\.js/);
  // Không được chạy lệnh: agent (không phải Codex) gọi shell → dừng ngay.
  const agents = f.config.agents.map(a => a.id === 'codex-2' ? { ...a, provider: 'mock', label: 'claude-like' } : a);
  const shellTeam = new Team({ ...f.config, agents, projects: [{ ...f.config.projects[0], access: { ...base, paths: [], shell: ['codex-1', 'gemini', 'codex-3'] } }] }, mkdtempSync(join(tmpdir(), 'ai-team-sh-')), { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'implement') { assert.match(prompt, /did not allow you to run shell/); opts.onEvent('ACTIVITY', { summary: 'npm i', details: { name: 'Bash', input: { command: 'npm i' } } }); await new Promise((r, j) => opts.signal.aborted ? j(opts.signal.reason) : opts.signal.addEventListener('abort', () => j(opts.signal.reason))); }
    return runAgent(agent, task, prompt, opts);
  } });
  t.after(() => shellTeam.close()); shellTeam.start();
  job = await shellTeam.create({ project: 'test', goal: 'Update hello with npm' });
  blocked = await settle(shellTeam, job.id, 'blocked'); assert.match(blocked.error, /npm i/);
});
