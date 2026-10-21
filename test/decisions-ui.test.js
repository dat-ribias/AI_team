import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, screenshot } from '../src/preview.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const locale = JSON.parse(fs.readFileSync(new URL('../locales/vi.json', import.meta.url), 'utf8'));
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  const lineEnd = source.indexOf('\n', start), first = source.slice(start, lineEnd).trimEnd();
  return first.endsWith('}') ? first : source.slice(start, source.indexOf('\n}', start) + 2);
}
const functions = ['gitOf', 'gitLabel', 'jobStatusLabel', 'badge', 'decisionId', 'decisionReason', 'drawDecisions', 'reconcileAndRefresh', 'deleteJob', 'drawOrphans', 'openOrphans', 'deleteOrphans'];
const code = functions.map(name => `${['reconcileAndRefresh', 'deleteJob', 'openOrphans', 'deleteOrphans'].includes(name) ? 'async ' : ''}${functionSource(name)}`).join('\n');
function harness() {
  const nodes = new Map(), storage = new Map(), calls = [], asks = [], notices = [];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '', hidden: false, disabled: false, rows: [], querySelectorAll() { return this.rows; }, querySelector() { return this.rows.find(row => row.checked); }, showModal() { this.open = true; }, click() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({
    $: get, state: { decisions: [], jobs: [] }, Set, JSON,
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    t: (key, vars = {}) => (locale[key] || key).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m),
    statusLabel: value => `legacy:${value}`, clock: value => value || 'unknown',
    store: { get: key => storage.get(key), set: (key, value) => storage.set(key, value) },
    notice: value => notices.push(value), attempt: fn => fn(),
    ask: async (message, options) => { asks.push({ message, options }); return context.answer; },
    api: async (path, data) => { calls.push({ path, data }); return context.respond(path, data); },
    refresh: async () => { calls.push({ path: 'refresh' }); }, syncTab() {},
    respond: () => ({}), answer: true,
  });
  vm.runInContext(`let decisionNewIds = new Set(), reconcilePending, orphanItems = [], orphanDeleting = false;
    let curProject, curSession, selected, events, filter;
    ${code}`, context);
  return { context, get, calls, asks, notices, storage, run: script => vm.runInContext(script, context) };
}

test('git labels replace legacy status; missing git retains fallback', () => {
  const h = harness();
  assert.match(h.run(`badge({ status: 'cancelled', git: { state: 'in_master' } })`), /Đã vào master/);
  assert.match(h.run(`badge({ status: 'ready' })`), /legacy:ready/);
  // "working" từ đối soát git không đè trạng thái thật (đang chờ phụ thuộc/quota, tạm dừng).
  assert.match(h.run(`badge({ status: 'waiting', git: { state: 'working' } })`), /class="status waiting">legacy:waiting/);
  for (const state of ['working', 'awaiting_owner', 'in_master', 'merge_stuck', 'cancelled_unmerged', 'cancelled_clean', 'done']) assert.ok(locale[`ui.gitState.${state}`]);
  assert.match(source, /jobStatusLabel\(j\).*runningOf\(j\)/);
  assert.match(functionSource('sessionSummary'), /jobStatusLabel\(job\)/);
});

test('decisions hide when empty, escape content, notify once and persist seen ids', () => {
  const h = harness(); h.run('drawDecisions()'); assert.equal(h.get('decisions').hidden, true);
  h.context.state.decisions = [{ jobId: 'abc', title: '<script>bad</script>', state: 'merge_stuck', kind: 'conflict', files: ['<file>.js'], reason: 'conflict' }];
  h.run('drawDecisions()');
  assert.equal(h.get('decisions').hidden, false);
  assert.match(h.get('decision-list').innerHTML, /&lt;script&gt;bad/);
  assert.match(h.get('decision-list').innerHTML, /Conflict thật: &lt;file&gt;.js/);
  assert.doesNotMatch(h.get('decision-list').innerHTML, /style=|<script>/);
  assert.equal(h.get('decision-count').textContent, '1');
  h.run('drawDecisions()'); assert.equal(h.notices.length, 1);
  assert.deepEqual(JSON.parse(h.storage.get('decision-seen')), ['abc']);
  h.run('decisionNewIds = new Set(); drawDecisions()'); assert.equal(h.get('decision-count').hidden, true);
  h.context.state.decisions = []; h.run('drawDecisions()'); assert.equal(h.get('decisions').hidden, true);
});

test('all merge failure kinds and orphan counts have concrete reasons', () => {
  const h = harness();
  for (const [kind, text] of [['base_moved', 'tự đồng bộ'], ['tests_failed', 'trả về builder'], ['cancelled_unmerged', 'còn code']]) assert.ok(h.run(`decisionReason({kind: '${kind}'})`).includes(text));
  assert.match(h.run(`decisionReason({kind: 'orphans', count: 4})`), /4 branch/);
  assert.match(functionSource('syncTab'), /decisionNewIds.size/);
  h.storage.set('decision-seen', '{invalid'); h.run('drawDecisions()');
});

test('browser title counts new decisions and clears after they are acknowledged', () => {
  const h = harness();
  h.context.document = { title: '' }; h.context.location = { hash: '' }; h.context.history = { replaceState() {} }; h.context.URLSearchParams = URLSearchParams;
  h.context.state.sessions = [];
  h.context.state.decisions = [{ jobId: 'abc', title: 'Task', state: 'awaiting_owner' }];
  h.run(`${functionSource('syncTab')}\ncurProject = 'project'; drawDecisions(); syncTab();`);
  assert.match(h.context.document.title, /^\(1\) project/);
  h.run('decisionNewIds.clear(); drawDecisions(); syncTab()');
  assert.doesNotMatch(h.context.document.title, /^\(/);
});

test('API preserves structured 409 details for the archive dialog', async () => {
  const h = harness();
  h.context.fetch = async () => ({ status: 409, ok: false, json: async () => ({ error: 'Unmerged', details: { branches: [{ name: 'ai-team/abc' }] } }) });
  h.run(`async ${functionSource('api')}`);
  await assert.rejects(h.run(`api('jobs/abc/control', {action:'delete'})`), error => error.status === 409 && error.details.branches[0].name === 'ai-team/abc');
});

test('decision selection moves to the job project and session; orphans open their dialog', async () => {
  const h = harness(), button = { dataset: { decision: 'abc' } };
  h.context.state.jobs = [{ id: 'abc', project: 'other', sessionId: 'room' }];
  h.context.state.decisions = [{ jobId: 'abc', title: 'Task', state: 'awaiting_owner' }];
  h.get('decision-list').rows = [button]; h.run('drawDecisions()'); await button.onclick();
  assert.equal(h.run('selected'), 'abc'); assert.equal(h.run('curProject'), 'other'); assert.equal(h.run('curSession'), 'room');
  button.dataset.decision = 'orphans'; h.context.respond = () => []; await button.onclick();
  assert.equal(h.get('orphan-dialog').open, true); assert.equal(h.calls.at(-1).path, 'orphans');
});

test('reconcile posts before refreshing, coalesces calls and still refreshes on error', async () => {
  const h = harness(); let release;
  h.context.respond = () => new Promise(done => { release = done; });
  const first = h.run('reconcileAndRefresh()'), second = h.run('reconcileAndRefresh()');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, 'reconcile'); release({}); await Promise.all([first, second]);
  assert.equal(h.calls.at(-1).path, 'refresh');
  h.context.respond = () => { throw new Error('offline'); };
  await assert.rejects(h.run('reconcileAndRefresh()'), /offline/); assert.equal(h.calls.at(-1).path, 'refresh');
  assert.match(source, /await attempt\(reconcileAndRefresh\)/);
  assert.match(source, /addEventListener\('focus'.*attempt\(reconcileAndRefresh\)/);
});

test('409 deletion details offer archive retry; cancellation and dirty worktrees never retry', async () => {
  const h = harness();
  h.context.respond = (path, body) => { if (!body.archive) throw Object.assign(new Error('Unmerged code'), { status: 409, details: { branches: [{ root: '/repo', name: 'ai-team/abc' }], wip: [{ root: '/repo', commit: 'abcdef' }], repos: [{ root: '/linked' }] } }); return {}; };
  assert.equal(await h.run(`deleteJob('abc')`), true);
  assert.match(h.asks[0].message, /ai-team\/abc[\s\S]*abcdef[\s\S]*linked[\s\S]*archive\//);
  assert.equal(h.asks[0].options.danger, true); assert.equal(h.calls.at(-1).data.archive, true);
  h.context.answer = false; h.calls.length = 0; assert.equal(await h.run(`deleteJob('abc')`), false); assert.equal(h.calls.length, 1);
  h.context.respond = () => { throw Object.assign(new Error('Dirty tree'), { status: 409, details: { worktrees: [{ worktree: '/dirty' }] } }); };
  const count = h.asks.length; await assert.rejects(h.run(`deleteJob('abc')`), /Dirty tree/); assert.equal(h.asks.length, count);
});

test('orphan table escapes paths, shows flags, disables dirty items and empty deletion', async () => {
  const h = harness();
  h.context.respond = () => [{ kind: 'worktree', root: '<repo>', target: '<tree>', branch: 'ai-team/test', lastCommitAt: '2026-10-19', inMain: false, dirty: true, prunable: true }];
  await h.run('openOrphans()'); const table = h.get('orphan-list').innerHTML;
  assert.match(table, /&lt;repo&gt;/); assert.match(table, /&lt;tree&gt;/); assert.match(table, /disabled/); assert.match(table, /Chưa vào master/); assert.match(table, /2026-10-19/); assert.match(table, /Có thể prune/);
  assert.doesNotMatch(table, /style=/); h.calls.length = 0; await h.run('deleteOrphans()'); assert.equal(h.calls.length, 0);
});

test('orphan deletion confirms archive, sends exact tips and renders individual results', async () => {
  const h = harness(); h.context.respond = () => [];
  h.run(`orphanItems = [{kind:'branch', root:'/repo', target:'ai-team/abc', tip:'abc123', inMain:false}]`);
  h.get('orphan-list').rows = [{ dataset: { orphan: '0' }, checked: true }];
  h.context.respond = path => path === 'orphans/delete' ? { results: [{ target: 'ai-team/abc', status: 'deleted', archived: 'archive/abc' }, { target: 'other', status: 'failed', detail: 'changed' }] } : [];
  await h.run('deleteOrphans()');
  assert.match(h.asks[0].message, /archive\//); assert.equal(h.asks[0].options.danger, true);
  const payload = h.calls.find(call => call.path === 'orphans/delete').data;
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), { items: [{ kind: 'branch', root: '/repo', target: 'ai-team/abc', tip: 'abc123' }] });
  assert.match(h.get('orphan-result').textContent, /archive\/abc[\s\S]*other: failed — changed/);
});

test('orphan deletion cancellation and API failure unlock the button', async () => {
  const h = harness(); h.run(`orphanItems = [{kind:'branch',root:'/repo',target:'ai-team/abc',tip:'a',inMain:true}]`);
  h.get('orphan-list').rows = [{ dataset: { orphan: '0' }, checked: true }];
  h.context.answer = false; await h.run('deleteOrphans()'); assert.equal(h.calls.length, 0); assert.equal(h.get('orphan-delete').disabled, false);
  h.context.answer = true; h.context.respond = () => { throw new Error('Tip changed'); };
  await assert.rejects(h.run('deleteOrphans()'), /Tip changed/); assert.equal(h.get('orphan-delete').disabled, false);
});

test('orphan delete rejects duplicate clicks while confirmation is pending', async () => {
  const h = harness(); let release;
  h.run(`orphanItems = [{kind:'branch',root:'/repo',target:'ai-team/abc',tip:'a',inMain:true}]`);
  h.get('orphan-list').rows = [{ dataset: { orphan: '0' }, checked: true }];
  h.context.ask = () => new Promise(done => { release = done; });
  const pending = h.run('deleteOrphans()');
  assert.equal(h.get('orphan-delete').disabled, true);
  await h.run('deleteOrphans()'); assert.equal(h.calls.length, 0);
  release(false); await pending; assert.equal(h.get('orphan-delete').disabled, false);
});

test('locales parse, contain all new keys and have no mojibake; new markup respects CSP', () => {
  for (const language of ['vi', 'en', 'ja']) {
    const text = fs.readFileSync(new URL(`../locales/${language}.json`, import.meta.url), 'utf8');
    const dictionary = JSON.parse(text); assert.doesNotMatch(text, /Ã|á»|\uFFFD/);
    for (const key of Object.keys(locale).filter(key => /^ui\.(gitState|decisions|orphans|delete)\./.test(key))) assert.ok(dictionary[key], `${language}: ${key}`);
  }
  assert.match(html, /id="orphan-dialog"/); assert.match(html, /id="decisions"[^>]*hidden/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.match(fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8'), /@media\(max-width:420px\)/);
});

test('desktop and mobile screenshots of real renderers without an application server', { skip: !process.env.UI_SCREENSHOTS && 'Set UI_SCREENSHOTS=1 to capture evidence', timeout: 120000 }, async () => {
  const chrome = findChrome(); assert.ok(chrome, 'Chrome or Edge required');
  const directory = resolve('.ai-team/evidence'); fs.mkdirSync(directory, { recursive: true });
  const decisionSection = html.match(/  <section id="decisions".*<\/section>/)[0];
  const orphanDialog = html.match(/<dialog id="orphan-dialog".*<\/dialog>/)[0];
  const fixture = `<!doctype html><html lang="vi" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${pathToFileURL(resolve('public/style.css'))}"><title>Decision inbox evidence</title></head><body><main><header><h1>AI Team · Control Room</h1></header><div id="notice" class="notice" role="status" hidden></div>${decisionSection}${orphanDialog}</main><script>
    const $ = id => document.getElementById(id), dict = ${JSON.stringify(locale)}, esc = ${source.match(/^const esc = (.*);$/m)[1]};
    const t = (key, vars = {}) => (dict[key] || key).replace(/\\{(\\w+)\\}/g, (m,k) => vars[k] ?? m);
    document.querySelectorAll('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
    const store = {get:()=>null,set(){}}, notice = text => { $('notice').hidden = false; $('notice').textContent = text; }, clock = value => value || '—', attempt = fn => fn();
    const state = {decisions:[{jobId:'6b7905f2',title:'Đồng bộ trạng thái Git với dashboard',state:'merge_stuck',kind:'conflict',files:['public/app.js','src/team.js']},{jobId:'08b2e9d3',title:'Duyệt bản phát hành RC',state:'awaiting_owner',reason:'Đã vào dev, chờ chủ duyệt RC lên master'},{jobId:'95d9c0cd',title:'Dọn worktree cũ',state:'cancelled_unmerged',reason:'branch ai-team/95d9c0cd'},{kind:'orphans',count:3}]};
    let decisionNewIds = new Set(), orphanDeleting = false, orphanItems = [{kind:'branch',root:'D:/work_team',target:'ai-team/6b7905f2-dashboard',inMain:true,lastCommitAt:'2026-10-19 14:30'},{kind:'worktree',root:'D:/work_team',target:'D:/ai_team/worktrees/95d9c0cd-review-a8b6aa4b',branch:'ai-team/95d9c0cd',inMain:false,lastCommitAt:'2026-10-18 10:15',dirty:true},{kind:'branch',root:'D:/work_team',target:'ai-team/fd485361',inMain:false,lastCommitAt:'2026-10-17 09:00',prunable:true}];
    ${['decisionId','decisionReason','drawDecisions','drawOrphans'].map(functionSource).join('\n')}
    drawDecisions(); drawOrphans(); if(location.hash === '#orphans') $('orphan-dialog').showModal();
    document.body.dataset.fixtureReady = 'true';
  </script></body></html>`;
  const file = resolve(directory, 'decisions-fixture.html'); fs.writeFileSync(file, fixture, 'utf8');
  // Keep the existing screenshot helper's temporary browser profile inside permitted evidence paths.
  const previous = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
  process.env.TMP = process.env.TEMP = process.env.TMPDIR = directory;
  try {
    for (const [name, width, height] of [['desktop',1440,1000], ['mobile',390,844]]) for (const view of ['decisions','orphans']) await screenshot({ chrome, url: pathToFileURL(file).href + (view === 'orphans' ? '#orphans' : ''), width, height, file: resolve(directory, `${view}-${name}.png`) });
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
