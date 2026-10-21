import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { agentAsk, analyze } from '../src/intake.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeTeam(answer) {
  const jobs = [
    { id: 'aaaa1111bbbb', title: 'Board', project: 'web', status: 'paused', tasks: [] },
    { id: 'aaaa2222cccc', title: 'Board v2', project: 'web', status: 'running', tasks: [] },
    { id: 'dddd3333eeee', title: 'API', project: 'api', status: 'waiting', questions: ['Dùng REST hay GraphQL?'], tasks: [] },
  ];
  const calls = [], prompts = [];
  return { calls, prompts, raw: jobs, jobs: () => jobs,
    config: { projects: [{ id: 'web', path: 'D:/web' }, { id: 'api', path: 'D:/api' }], agents: [{ id: 'claude-1', provider: 'claude', model: 'opus', effort: 'high' }, { id: 'gemini', provider: 'antigravity', model: 'gemini-3.8-flash-high' }] },
    dataDir: mkdtempSync(join(tmpdir(), 'intake-')), remaining: () => 50, used: [],
    jobSummary: j => ({ status: j.status, next: j.questions?.length ? 'answer_questions' : 'none' }),
    control: async (id, action, payload) => { calls.push([id, action, payload]); },
    create: async input => { calls.push(['create', input]); return { id: 'new0000id', ...input }; },
    agentRun: async function (agent, task, prompt) { this.used.push([agent.id, agent.model]); prompts.push(prompt); if (answer instanceof Error) throw answer; return JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)); } };
}

test('LLM plan is validated: unknown project and ambiguous job become numbered questions, then y/n confirm', async () => {
  const team = fakeTeam('Sure:\n```json\n{"actions":[{"type":"continue","job":"aaaa","note":"thêm test"},{"type":"new","project":null,"title":"Xuất CSV","goal":"Thêm nút xuất CSV"}]}\n```');
  const bot = new Bot(team, {}, { env: {} });
  let r = await bot.answer('làm tiếp board và thêm xuất CSV', 'c1');
  assert.match(team.prompts[0], /"id":"aaaa1111"/); assert.match(team.prompts[0], /REST hay GraphQL/);
  assert.match(r, /Làm tiếp job nào \("aaaa"\)\?\n1\. #aaaa1111 Board\n2\. #aaaa2222 Board v2/);
  assert.match(await bot.answer('9', 'c1'), /Chọn số 1-2/);
  r = await bot.answer('1', 'c1'); assert.match(r, /"Xuất CSV" làm trong dự án nào\?\n1\. web\n2\. api/);
  assert.equal(await bot.answer('/status', 'c2').then(x => /Đang chạy/.test(x)), true, 'other chats are independent');
  r = await bot.answer('2', 'c1'); assert.match(r, /1\. Làm tiếp #aaaa1111 · thêm test\n2\. Giao việc mới \[api\]: Xuất CSV\nĐồng ý\? \(y\/n\)/);
  assert.equal(team.calls.length, 0, 'nothing happens before confirmation');
  r = await bot.answer('y', 'c1');
  assert.deepEqual(team.calls, [['aaaa1111bbbb', 'resume', undefined], ['aaaa1111bbbb', 'message', { message: 'thêm test' }], ['create', { project: 'api', goal: 'Thêm nút xuất CSV', title: 'Xuất CSV' }]]);
  assert.match(r, /✓ #aaaa1111: đã gửi chỉ dẫn\n✓ Đã giao #new0000i \(api\)/);
  assert.match(await bot.answer('y', 'c1'), /Không có yêu cầu nào đang chờ/, 'confirmation is consumed once');
});

test('n cancels; broken LLM output falls back to heuristics (Lead question gets the answer)', async () => {
  const team = fakeTeam('not json'), bot = new Bot(team, {}, { env: {} });
  let r = await bot.answer('Dùng REST nhé', 'c');
  assert.match(r, /Trả lời Lead #dddd3333: Dùng REST nhé/);
  assert.match(await bot.answer('n', 'c'), /Đã hủy/); assert.equal(team.calls.length, 0);
  await bot.answer('Dùng REST nhé', 'c'); await bot.answer('ok', 'c');
  assert.deepEqual(team.calls, [['dddd3333eeee', 'message', { message: 'Dùng REST nhé' }]]);
});

test('heuristics without ChatGPT: job ids continue, project names are detected, otherwise ask', async () => {
  const team = fakeTeam(new Error('rate limit')); team.raw[2].questions = [];
  let p = await analyze(team, 'tiếp tục aaaa1111', async () => { throw new Error('x'); });
  assert.deepEqual(p.actions.map(a => [a.type, a.job]), [['continue', 'aaaa1111bbbb']]);
  p = await analyze(team, 'thêm login cho api'); assert.equal(p.actions[0].project, 'api'); assert.equal(p.asks.length, 0);
  p = await analyze(team, 'thêm chức năng đăng nhập bằng Google'); assert.equal(p.asks[0].field, 'project');
  const bot = new Bot(team, { intake: false }, { env: {} }); assert.equal(bot.ask, null);
});

test('Lead questions are forwarded with their text', () => {
  const team = fakeTeam(''), bot = new Bot(team, {}, { env: {} });
  team.raw[2].questions = []; bot.changes();
  team.raw[2].questions = ['Dùng REST hay GraphQL?'];
  assert.match(bot.changes()[0], /❓ #dddd3333 API[\s\S]*1\) Dùng REST hay GraphQL\?\n→ Trả lời thẳng vào chat/);
});

test('intake model: Claude Haiku first, Gemini when Claude fails or has no quota', async () => {
  const team = fakeTeam('{"summary":"x","actions":[{"type":"status"}]}');
  const ask = agentAsk(team);
  await ask('p'); assert.deepEqual(team.used, [['claude-1', 'haiku']]);
  team.remaining = id => id === 'claude-1' ? 0 : 40; team.used = [];
  await ask('p'); assert.deepEqual(team.used, [['gemini', 'gemini-3.8-flash-high']]);
  team.remaining = () => 40; team.used = []; const run = team.agentRun;
  team.agentRun = async function (agent, ...rest) { if (agent.provider === 'claude') { this.used.push([agent.id, 'fail']); throw new Error('usage limit'); } return run.call(this, agent, ...rest); };
  assert.deepEqual(await ask('p'), { summary: 'x', actions: [{ type: 'status' }] }); assert.deepEqual(team.used, [['claude-1', 'fail'], ['gemini', 'gemini-3.8-flash-high']]);
});

test('small talk gets a normal chat reply, never a job or the status board', async () => {
  const team = fakeTeam('{"summary":"greeting","actions":[{"type":"chat","reply":"こんにちは！何かお手伝いしましょうか？"}]}'), bot = new Bot(team, {}, { env: {} });
  team.raw[2].questions = [];
  assert.equal(await bot.answer('こんにちは', 'c'), 'こんにちは！何かお手伝いしましょうか？');
  assert.equal(team.calls.length, 0); assert.equal(bot.pending.size, 0);
  const offline = fakeTeam(new Error('quota')); offline.raw[2].questions = [];
  assert.match(await new Bot(offline, {}, { env: {} }).answer('hello', 'c'), /Mình nghe đây/, 'heuristic fallback does not turn a greeting into a job');
});

test('prompt carries finished jobs, the current time and the recent conversation for follow-ups', async () => {
  const team = fakeTeam('{"summary":"x","actions":[{"type":"chat","reply":"Dự án nào?"}]}'), bot = new Bot(team, {}, { env: {} });
  team.raw[2].questions = []; team.raw.push({ id: 'ffff4444aaaa', title: 'Xuất PDF', project: 'web', status: 'merged', updatedAt: '2026-10-20T03:00:00Z', tasks: [] });
  await bot.answer('những job nào đã hoàn thành?', 'c'); await bot.answer('fe_new', 'c');
  const prompt = team.prompts[1];
  assert.match(prompt, /"id":"ffff4444","project":"web","title":"Xuất PDF","status":"merged"/);
  assert.match(prompt, /Now: \d{4}-\d\d-\d\d \d\d:\d\d/);
  assert.match(prompt, /Recent conversation \(oldest first\): \[\{"owner":"những job nào đã hoàn thành\?","bot":"Dự án nào\?"\}\]/);
});

test('"send me the evidence of job X" sends the real report with files right away, also for merged jobs', async () => {
  const team = fakeTeam('{"summary":"x","actions":[{"type":"result","job":"ffff4444"}]}'), bot = new Bot(team, {}, { env: {} });
  team.raw[2].questions = []; team.raw.push({ id: 'ffff4444aaaa', title: 'Làm lại UI', project: 'web', status: 'merged', tasks: [] });
  bot.report = async j => ({ text: 'REPORT ' + j.id, files: ['/x/after.png'] });
  assert.deepEqual(await bot.answer('gửi bằng chứng hoàn thành của job ffff4444', 'c'), { text: 'REPORT ffff4444aaaa', files: ['/x/after.png'] });
  assert.equal(team.calls.length, 0); assert.equal(bot.pending.size, 0);
  const ambiguous = fakeTeam('{"summary":"x","actions":[{"type":"result","job":"aaaa"}]}'), b2 = new Bot(ambiguous, {}, { env: {} });
  b2.report = async j => ({ text: 'REPORT ' + j.id, files: [] });
  assert.match(await b2.answer('kết quả job aaaa', 'c'), /Xem kết quả job nào\?\n1\. #aaaa1111/);
  assert.equal(await b2.answer('2', 'c'), 'REPORT aaaa2222cccc', 'picking the job sends the report without a y/n step');
  assert.match(team.prompts[0], /plain text only, no Markdown/);
});

test('Chatwork attachments are downloaded and given to the job; an image alone waits for the next message', async () => {
  const team = fakeTeam('{"summary":"x","actions":[{"type":"new","project":"web","title":"Sửa lỗi danh sách","goal":"Sửa lỗi như ảnh"}]}');
  team.raw[2].questions = [];
  let batch = [{ message_id: '1', account: { account_id: 5 }, body: '[download:77]err.png (10 KB)[/download]' }];
  const sent = [];
  const fetch = async (url, init = {}) => {
    if (url.endsWith('/me')) return { ok: true, status: 200, json: async () => ({ account_id: 9 }) };
    if (url.includes('/messages?force=0')) { const b = batch; batch = []; return { ok: true, status: 200, json: async () => b }; }
    if (url.includes('/files/77?create_download_url=1')) return { ok: true, status: 200, json: async () => ({ filename: 'err.png', filesize: 3, download_url: 'https://dl/err.png' }) };
    if (url === 'https://dl/err.png') return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('PNG').buffer };
    sent.push(Object.fromEntries(init.body)); return { ok: true, status: 200, json: async () => ({}) };
  };
  const bot = new Bot(team, { chatwork: { roomId: 42, allow: [5] }, notify: false }, { fetch, env: { CHATWORK_TOKEN: 't' }, log: () => {} });
  await bot.tick();
  assert.match(sent[0].body, /Đã nhận 1 file/); assert.equal(team.prompts.length, 0);
  batch = [{ message_id: '2', account: { account_id: 5 }, body: 'lỗi như ảnh ở trang danh sách của web' }]; await bot.tick();
  assert.match(team.prompts[0], /\[Owner attached files: err\.png\]/); assert.match(sent[1].body, /kèm 1 file: err\.png[\s\S]*Đồng ý\? \(y\/n\)/);
  batch = [{ message_id: '3', account: { account_id: 5 }, body: 'y' }]; await bot.tick();
  assert.deepEqual(team.calls[0], ['create', { project: 'web', goal: 'Sửa lỗi như ảnh', title: 'Sửa lỗi danh sách', files: [{ name: 'err.png', data: Buffer.from('PNG').toString('base64') }] }]);
});

test('questions about a job carry its round-by-round details so the model can explain reruns', async () => {
  const team = fakeTeam('{"summary":"x","actions":[{"type":"chat","reply":"Vòng 2 sai vì F1"}]}'), bot = new Bot(team, {}, { env: {} });
  team.raw[2].questions = [];
  Object.assign(team.raw[1], { goal: 'Sửa flow', plans: [{ version: 1, reason: 'initial', summary: 'p1', tasks: [{ agent: 'b1', instruction: 'làm A' }] }, { version: 2, reason: 'rework', trigger: 'F1, F2', summary: 'p2', tasks: [] }],
    reports: [{ stage: 'review', agent: 'rev', verdict: 'changes_requested', summary: 'thiếu null check', findings: [{ id: 'F1', impact: 'high', claim: 'Team.call nuốt lỗi' }] }, { stage: 'test', summary: 'Test failed: npm test', output: 'AssertionError: expected 2' }] });
  await bot.answer('job aaaa2222 vòng 2 sao lại sai?', 'c');
  const p = team.prompts[0];
  assert.match(p, /"round":2,"plan":2,"why":"rework","trigger":"F1, F2"/);
  assert.match(p, /F1 \[high\] Team.call nuốt lỗi/); assert.match(p, /AssertionError: expected 2/);
  await bot.answer('còn vì sao chạy lại?', 'c');
  assert.match(team.prompts[1], /"id":"aaaa2222","title":"Board v2"/, 'follow-ups keep the job from the recent conversation');
});
