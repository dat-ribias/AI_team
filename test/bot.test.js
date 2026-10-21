import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot, parseCommand } from '../src/bot.js';

function fakeTeam() {
  const jobs = [
    { id: 'aaaa1111bbbb', title: 'Board', project: 'p', status: 'waiting', planGate: { version: 2 }, plans: [{ version: 2, hash: 'h', tasks: [{}, {}] }], tasks: [] },
    { id: 'cccc2222dddd', title: 'Flow', project: 'p', status: 'running', stage: 'implement', tasks: [{ agent: 'b1', done: true, title: 'T' }] },
    { id: 'eeee3333ffff', title: 'Old', project: 'p', status: 'merged', tasks: [] },
  ];
  const calls = [];
  const next = j => j.status === 'waiting' && j.planGate ? 'approve_plan' : j.status === 'ready' ? 'review_merge' : 'none';
  return { calls, jobs: () => jobs, raw: jobs, config: { projects: [{ id: 'p' }, { id: 'q' }], agents: [{ id: 'b1', label: 'Lobao' }] },
    jobSummary: j => ({ status: j.status, stage: j.stage, next: next(j), reason: null }), remaining: () => 80,
    control: async (id, action, payload) => { calls.push([id, action, payload]); },
    create: async input => { calls.push(['create', input]); return { id: 'new0000id', ...input }; },
    merge: async (id, opts) => { calls.push([id, 'merge', opts]); if (!opts.confirm) throw new Error('Rủi ro cao: nhập mã 1234'); } };
}

test('parseCommand strips Chatwork mentions, slashes and bot suffixes', () => {
  assert.deepEqual(parseCommand('[To:123]AI Team\n/duyet aaaa').cmd, 'duyet');
  assert.equal(parseCommand('duyet aaaa').slash, false, 'without / it is free text');
  assert.equal(parseCommand('/status@my_bot').cmd, 'status');
  assert.equal(parseCommand('/msg abcd hello there').rest, 'abcd hello there');
});

test('bot commands read and control jobs by id prefix', async () => {
  const team = fakeTeam(), bot = new Bot(team, {}, { env: {} });
  assert.match(await bot.answer('/status'), /cần bạn 1/);
  assert.match(await bot.answer('/can'), /#aaaa1111 Board · chờ duyệt plan/);
  assert.match(await bot.answer('/job cccc'), /T1 ✓ b1/);
  assert.match(await bot.answer('/duyet aaaa'), /plan v2/); assert.deepEqual(team.calls.at(-1), ['aaaa1111bbbb', 'approve-plan', { version: 2, hash: 'h' }]);
  assert.match(await bot.answer('/msg cccc làm tiếp đi'), /Đã gửi/); assert.deepEqual(team.calls.at(-1)[2], { message: 'làm tiếp đi' });
  assert.match(await bot.answer('/new q: Viết tài liệu'), /Đã giao/); assert.deepEqual(team.calls.at(-1)[1], { project: 'q', goal: 'Viết tài liệu' });
  assert.match(await bot.answer('/merge cccc'), /merge cccc <mã>/); assert.match(await bot.answer('/merge cccc 1234'), /Đã merge/);
  assert.match(await bot.answer('/pause zz'), /Lỗi: cần mã job/); assert.match(await bot.answer('/duyet cccc'), /Lỗi: job không chờ duyệt plan/);
  assert.match(await bot.answer('/quota'), /Lobao: 80%/);
});

test('Chatwork polling answers only allowed senders and notifies on new owner work', async () => {
  const team = fakeTeam(), sent = [];
  const fetch = async (url, init = {}) => {
    if (url.endsWith('/me')) return { ok: true, status: 200, json: async () => ({ account_id: 9 }) };
    if (url.includes('/messages?force=0')) return { ok: true, status: 200, json: async () => [
      { message_id: '1', account: { account_id: 5 }, body: '[To:9]Bot\n/can' }, { message_id: '2', account: { account_id: 7 }, body: '/cancel aaaa' }, { message_id: '3', account: { account_id: 9 }, body: '/status' },
      { message_id: '4', account: { account_id: 5 }, body: 'cancel aaaa', send_time: Math.floor(Date.now() / 1000) - 3600 }] };
    if (init.method === 'POST') { sent.push(Object.fromEntries(init.body)); assert.equal(init.headers['X-ChatWorkToken'], 'tok'); return { ok: true, status: 200, json: async () => ({}) }; }
    throw new Error('unexpected ' + url);
  };
  const bot = new Bot(team, { chatwork: { roomId: 42, allow: [5] }, notify: true }, { fetch, env: { CHATWORK_TOKEN: 'tok' }, log: () => {} });
  team.raw[2].status = 'done'; // xong trước khi bật bot: không báo lại
  bot.changes();
  await bot.tick();
  assert.equal(sent.length, 1, 'stranger (7), the bot itself (9) and messages sent while the server was off are ignored'); assert.match(sent[0].body, /^\[rp aid=5 to=42-1\]/); assert.match(sent[0].body, /Board/);
  assert(!team.calls.some(c => c[1] === 'cancel'));
  team.raw[1].status = 'ready'; await bot.tick();
  assert.match(sent.at(-1).body, /📋 #cccc2222 Flow · sẵn sàng merge/, 'ready jobs are announced with their full result');
  assert(!sent.some(m => /eeee3333/.test(m.body)), 'a job finished before the bot started is not reported');
});

test('Telegram long-poll offset advances and only allowed chats get replies', async () => {
  const team = fakeTeam(), calls = [];
  const fetch = async (url, init) => {
    const method = url.split('/').at(-1), body = JSON.parse(init.body); calls.push([method, body]);
    if (method === 'getUpdates') return { json: async () => ({ ok: true, result: body.offset ? [] : [{ update_id: 10, message: { chat: { id: 1 }, text: '/status' } }, { update_id: 11, message: { chat: { id: 2 }, text: '/cancel aaaa' } }] }) };
    return { json: async () => ({ ok: true, result: {} }) };
  };
  const bot = new Bot(team, { telegram: { allow: [1] }, notify: false }, { fetch, env: { TELEGRAM_BOT_TOKEN: 't' }, log: () => {} });
  await bot.tick(); await bot.tick();
  const replies = calls.filter(c => c[0] === 'sendMessage');
  assert.equal(replies.length, 1); assert.equal(replies[0][1].chat_id, 1); assert.equal(calls.filter(c => c[0] === 'getUpdates')[1][1].offset, 12);
});

test('Chatwork setup mode (empty allow) announces the bot account and tells senders their account_id once', async () => {
  const team = fakeTeam(), sent = [];
  const fetch = async (url, init = {}) => {
    if (url.endsWith('/me')) return { ok: true, status: 200, json: async () => ({ account_id: 9, name: 'AI Bot' }) };
    if (url.includes('/messages?force=0')) return { ok: true, status: 200, json: async () => [{ message_id: '1', account: { account_id: 5 }, body: 'cancel aaaa' }, { message_id: '2', account: { account_id: 5 }, body: 'hi' }] };
    sent.push(Object.fromEntries(init.body)); return { ok: true, status: 200, json: async () => ({}) };
  };
  const bot = new Bot(team, { chatwork: { roomId: 42 }, notify: false }, { fetch, env: { CHATWORK_TOKEN: 'tok' }, log: () => {} });
  await bot.tick();
  assert.equal(sent.length, 2); assert.match(sent[0].body, /AI Bot \(9\)/); assert.match(sent[1].body, /account_id của bạn: 5/);
  assert.equal(team.calls.length, 0, 'nobody can run commands in setup mode');
});

test('/ketqua: readable result with task summaries, checks, changed files and evidence images uploaded to Chatwork', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const team = fakeTeam(), dataDir = mkdtempSync(join(tmpdir(), 'bot-report-')), j = team.raw[1];
  team.dataDir = dataDir;
  mkdirSync(join(dataDir, 'evidence', j.id, 'r1/preview-controller'), { recursive: true });
  writeFileSync(join(dataDir, 'evidence', j.id, 'r1/preview-controller/after-home-desktop.png'), 'png');
  Object.assign(j, { status: 'ready', revision: 'r1', goal: 'Thêm nút xuất CSV', risk: 'medium',
    reports: [{ stage: 'implement', task: 0, summary: 'Thêm nút Xuất CSV ở trang danh sách' }, { stage: 'review', agent: 'gemini', revision: 'r1', verdict: 'approved', findings: [] }, { stage: 'review', agent: 'old', revision: 'r0', verdict: 'changes_requested' }],
    checkResults: [{ command: ['npm', 'test'], code: 0, revision: 'r1' }],
    evidence: [{ revision: 'r1', stage: 'preview', dir: 'r1/preview-controller', files: [{ path: 'after-home-desktop.png', bytes: 3, type: 'image' }, { path: 'huge.png', bytes: 6 * 2 ** 20, type: 'image' }] }] });
  team.mergeCheck = async () => ({ files: 1, added: 12, removed: 2, paths: [{ path: 'src/list.js', added: 12, removed: 2 }], reasons: [], needsConfirm: false, code: 'r1' });
  const uploads = [], sent = [];
  const fetch = async (url, init = {}) => {
    if (url.endsWith('/me')) return { ok: true, status: 200, json: async () => ({ account_id: 9 }) };
    if (url.includes('/messages?force=0')) return { ok: true, status: 200, json: async () => [{ message_id: '1', account: { account_id: 5 }, body: '/ketqua cccc' }] };
    if (url.endsWith('/files')) { const f = init.body.get('file'); uploads.push([f.name, await f.text()]); return { ok: true, status: 200 }; }
    sent.push(Object.fromEntries(init.body)); return { ok: true, status: 200, json: async () => ({}) };
  };
  const bot = new Bot(team, { chatwork: { roomId: 42, allow: [5] }, notify: false }, { fetch, env: { CHATWORK_TOKEN: 'tok' }, log: () => {} });
  await bot.tick();
  const body = sent[0].body;
  assert.match(body, /T1 ✓ b1: T\n   → Thêm nút Xuất CSV ở trang danh sách/);
  assert.match(body, /Test: ✓ npm test/); assert.match(body, /Review \(gemini\): approved/); assert(!/changes_requested/.test(body), 'old revision reviews are not shown');
  assert.match(body, /File đổi 1 \(\+12 −2\): src\/list.js \+12−2/); assert.match(body, /Duyệt: \/merge cccc2222 ·/);
  assert.deepEqual(uploads, [['after-home-desktop.png', 'png']], 'files over 5 MB are skipped');
});

test('/ketqua attaches deliverables: research documents from evidence and documents a code job added', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const team = fakeTeam(), dataDir = mkdtempSync(join(tmpdir(), 'bot-docs-')), research = team.raw[2], code = team.raw[1];
  team.dataDir = dataDir;
  mkdirSync(join(dataDir, 'evidence', research.id, 'r9/research-b1'), { recursive: true });
  writeFileSync(join(dataDir, 'evidence', research.id, 'r9/research-b1/BD_v1.0.docx'), 'doc');
  Object.assign(research, { kind: 'research', status: 'done', revision: 'r9', conclusion: { conclusion: 'Đã soạn BD' },
    evidence: [{ revision: 'r9', stage: 'research', dir: 'r9/research-b1', files: [{ path: 'BD_v1.0.docx', bytes: 3, type: 'other' }] }] });
  let r = await new Bot(team, {}, { env: {} }).report(research);
  assert.match(r.text, /Kết luận: Đã soạn BD/); assert.match(r.text, /File kết quả: BD_v1.0.docx/);
  assert.deepEqual(r.files, [join(dataDir, 'evidence', research.id, 'r9/research-b1/BD_v1.0.docx')]);
  const wt = mkdtempSync(join(tmpdir(), 'bot-wt-')); mkdirSync(join(wt, 'docs')); writeFileSync(join(wt, 'docs/spec.xlsx'), 'x');
  Object.assign(code, { worktree: wt, revision: 'r1', status: 'ready' });
  team.mergeCheck = async () => ({ files: 2, added: 5, removed: 0, paths: [{ path: 'docs/spec.xlsx', added: 0, removed: 0 }, { path: 'docs/old.pdf', added: 0, removed: 0 }, { path: 'src/a.js', added: 4, removed: 0 }], reasons: [], needsConfirm: false, code: 'r1' });
  r = await new Bot(team, {}, { env: {} }).report(code);
  assert.deepEqual(r.files, [join(wt, 'docs/spec.xlsx')]);
});
