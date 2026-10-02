import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team, validateConfig, redact, routeGoal, compressOutput } from '../src/team.js';
import { run, childEnv } from '../src/process.js';
import { parseReport, normalizeCodexQuota, normalizeGoogleQuota } from '../src/providers.js';

async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-check-'));
  await run(['git'], ['init', '-b', 'main', path]);
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
async function settle(team, id, expected) {
  const timeout = Date.now() + 20000;
  while (Date.now() < timeout) {
    const job = team.get(id);
    if (job.status === expected && !team.active) return job;
    if (job.status === 'blocked' && expected !== 'blocked') assert.fail(job.error);
    await new Promise(r => setTimeout(r, 30));
  }
  assert.fail(`Timeout: ${JSON.stringify(team.get(id))}`);
}

test('quota, structured reports, isolation, and shell-free prompts', async () => {
  const quota = normalizeCodexQuota({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1800000000 } }, rateLimitsByLimitId: { fast: { primary: { usedPercent: 60 }, secondary: { usedPercent: null } } } });
  assert.equal(quota[0].id, 'fast'); assert.equal(quota[0].windows[0].remaining, 40); assert.equal(quota[0].windows[1].remaining, null);
  assert.equal(normalizeCodexQuota({ rateLimits: { primary: { usedPercent: 120 } } })[0].windows[0].remaining, 0);
  assert.equal(normalizeGoogleQuota({ quota: { pro: { remaining_fraction: .4, reset_time: 'later' } } })[0].windows[0].remaining, 40);
  assert.deepEqual(normalizeGoogleQuota({ response: 'You have 80% left' }), []);
  assert.throws(() => parseReport('complete!')); assert.equal(parseReport('```json\n{"summary":"ok"}\n```').summary, 'ok');
  assert(!redact('secret sk-12345678901234567890').includes('12345678901234567890'));
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
  accounts.removeProject(id); assert.throws(() => team.project(id));
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
  f.config.skillDirs = [lib];
  const { runAgent } = await import('../src/providers.js');
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'plan') { assert.match(prompt, /demo-skill/); return { summary: 'p', kind: 'code', rigor: 'standard', risk: 'low', reviewSkills: ['demo-skill'], tasks: [{ agent: 'codex-2', difficulty: 2, skills: ['demo-skill', 'nope'], instruction: 'Update hello.txt' }] }; }
    if (task.stage === 'implement') { assert.match(prompt, /\.ai-team\/skills\/demo-skill\/SKILL\.md/); assert.equal(readFileSync(join(task.worktree, '.ai-team/skills/demo-skill/SKILL.md'), 'utf8').includes('Do less'), true); }
    return runAgent(agent, task, prompt, opts);
  } });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  assert.deepEqual(ready.tasks[0].skills, ['demo-skill']); assert.deepEqual(ready.reviewSkills, ['demo-skill']);
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
