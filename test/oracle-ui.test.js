import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { findChrome, previewEnv, stopTree, removeTempDir } from '../src/preview.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const locale = JSON.parse(fs.readFileSync(new URL('../locales/vi.json', import.meta.url), 'utf8'));
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start) + 2;
  const first = source.slice(start, source.indexOf('\n', start)).trimEnd();
  return (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + (first.endsWith('}') ? first : source.slice(start, end));
}
const helpers = ['oracleFlowState', 'oracleSeconds', 'oracleError', 'openOracle', 'openOracleTest', 'testOracleAccounts', 'oracleStatsHTML', 'drawOracleStats'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const translate = (key, vars = {}) => (locale[key] || key).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
function harness() {
  const nodes = new Map(), calls = [];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', disabled: false, rows: [], querySelectorAll() { return this.rows; }, showModal() { this.open = true; } });
    return nodes.get(id);
  };
  const context = vm.createContext({ $: get, esc, t: translate, clock: x => x, tokenNumber: x => String(x), URLSearchParams,
    state: { oracle: { mode: 'auto', accountIds: ['one', 'two'] } }, tokenRequest: 1,
    api: async (path, data) => { calls.push({ path, data }); return context.response(path, data); }, response: () => ({}) });
  vm.runInContext(`let oracleTestBusy = false; ${helpers.map(functionSource).join('\n')}`, context);
  return { context, get, calls, run: script => vm.runInContext(script, context) };
}

test('Oracle controls, decision events, CSP markup and locale keys', () => {
  for (const id of ['oracle-mode', 'oracle-research-mode', 'oracle-test', 'oracle-dialog', 'oracle-test-dialog', 'job-oracle-mode']) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /<label for="oracle-research-mode" data-i18n="ui.settings.oracleResearchMode"><\/label>/);
  const researchSelect = html.match(/<select id="oracle-research-mode">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...researchSelect.matchAll(/value="(\w+)"/g)].map(match => match[1]), ['off', 'auto', 'required']);
  assert.match(source, /\$\('oracle-research-mode'\).value = state.oracle\?\.researchMode \|\| 'required'/);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html + source, /oracle-toggle/);
  assert.match(source, /const DECISION_TYPES = .*'ORACLE_ERROR'/);
  assert.match(functionSource('drawFlow'), /data-oracle role="button" tabindex="0"/);
  assert.match(source, /oracleMode: \$\('job-oracle-mode'\).value \|\| undefined/);
  const keys = Object.keys(locale).filter(key => key.startsWith('ui.oracle.') || key.startsWith('ui.settings.oracleMode') || key === 'ui.settings.oracleResearchMode');
  for (const language of ['vi', 'en', 'ja']) {
    const text = fs.readFileSync(new URL(`../locales/${language}.json`, import.meta.url), 'utf8'), data = JSON.parse(text);
    assert.doesNotMatch(text, /Ã|á»|\uFFFD/);
    assert.ok(data['ui.ev.ORACLE_ERROR']);
    for (const key of keys) { assert.equal(typeof data[key], 'string', `${language}: ${key}`); assert.doesNotMatch(data[key], /Ã|á»|\uFFFD/); }
  }
});

test('Oracle flow distinguishes hidden, idle, pending, successful and failed turns', () => {
  const h = harness();
  assert.equal(h.run('oracleFlowState(null).visible'), false);
  assert.equal(h.run("oracleFlowState({oracleMode:'off'}).visible"), false);
  assert.equal(h.run("oracleFlowState({status:'done',oracle:{skipReason:'No need'}}).subtitle"), 'Lead không hỏi · No need');
  assert.equal(h.run("oracleFlowState({status:'running',stage:'plan',oracle:{turns:[{q:'Ask'}]}}).working"), true);
  for (const turn of [{ a: '' }, { error: 'Failure' }, { code: 'timeout' }]) {
    h.context.turn = turn;
    assert.equal(h.run("oracleFlowState({status:'running',stage:'plan',oracle:{turns:[turn]}}).working"), false);
  }
  assert.equal(h.run("oracleFlowState({oracle:{turns:[{a:'OK'},{error:'Failed'}]}}).subtitle"), '2 lượt · ✓1 ✗1');
});

test('Turn dialog escapes all external fields and includes timing, source and error code', () => {
  const h = harness();
  h.run(`openOracle({oracle:{skipReason:'<skip>',turns:[{q:'<script>secret</script>',a:'<answer>',at:'now',ms:1500,waitMs:250,account:'<account>',auto:true,error:'<error>',code:'timeout'}]}})`);
  const result = h.get('oracle-turns').innerHTML;
  for (const text of ['&lt;script&gt;', '&lt;answer&gt;', '&lt;account&gt;', '&lt;error&gt;', '1.5 giây', '0.25 giây', '[timeout]', 'controller']) assert.ok(result.includes(text), text);
  assert.doesNotMatch(result, /<script>| style=/);
  assert.equal(h.get('oracle-dialog').open, true);
});

test('Connection test uses each account, locks buttons, and renders success plus concrete errors safely', async () => {
  const h = harness(), rows = ['one', 'two'].map(account => ({ dataset: { oracleResult: account }, textContent: '' }));
  h.get('oracle-test-results').querySelectorAll = selector => selector === 'button' ? [] : rows;
  let release;
  h.context.response = async (path, { account }) => {
    if (account === 'one') await new Promise(resolve => release = resolve);
    return { results: [{ account, ok: account === 'one', answer: '<answer>', error: 'session expired', code: 'not_logged_in', ms: 1500 }] };
  };
  const pending = h.run("testOracleAccounts(['one','two'])");
  assert.equal(h.get('oracle-test-all').disabled, true);
  assert.equal(rows[0].textContent, 'Đang thử…');
  await h.run("testOracleAccounts(['one'])"); assert.equal(h.calls.length, 1);
  release(); await pending;
  assert.equal(h.get('oracle-test-all').disabled, false);
  assert.equal(rows[0].textContent, '✓ <answer> · 1.5 giây');
  assert.match(rows[1].textContent, /✗ Chưa đăng nhập\/hết phiên · session expired/);
  assert.equal(h.calls[1].data.account, 'two');
  h.context.response = () => { throw new Error('network down'); };
  await h.run("testOracleAccounts(['one'])");
  assert.match(rows[0].textContent, /✗.*network down/);
});

test('Oracle stats preserve filters, escape labels, ignore stale requests and isolate failures', async () => {
  const h = harness();
  h.context.response = () => ({ totals: { asks: 2, ok: 1, failed: 1, avgMs: 1500, auto: 1 }, byDay: [], byJob: [{ key: '<job>', title: '<title>', asks: 2 }], byProject: [] });
  await h.run("drawOracleStats({from:'2026-10-01',to:'2026-10-21',project:'demo',job:'job1'},1)");
  assert.match(h.calls[0].path, /from=2026-10-01&to=2026-10-21&project=demo&job=job1/);
  assert.match(h.get('oracle-stats').innerHTML, /data-token-job="&lt;job&gt;"/);
  assert.doesNotMatch(h.get('oracle-stats').innerHTML, /<title>| style=/);
  h.get('oracle-stats').innerHTML = 'current';
  await h.run('drawOracleStats({},0)'); assert.equal(h.get('oracle-stats').innerHTML, 'current');
  h.context.response = () => { throw new Error('<unavailable>'); };
  await h.run('drawOracleStats({},1)'); assert.match(h.get('oracle-stats').innerHTML, /&lt;unavailable&gt;/);
});

test('Oracle stats include role counts and optional estimated savings with the formula', () => {
  const h = harness();
  h.context.report = { totals: { asks: 8, ok: 7, failed: 1, avgMs: 1000, auto: 1, lead: 3, builder: 5 }, byDay: [], byJob: [], byProject: [] };
  const before = h.run('oracleStatsHTML(report)');
  for (const role of ['lead', 'builder']) {
    assert.ok(before.includes(`<span>${translate('ui.oracle.' + role)}</span><strong>${h.context.report.totals[role]}</strong>`));
    assert.ok(before.includes(`<th scope="col">${translate('ui.oracle.' + role)}</th>`));
  }
  assert.match(before, /colspan="8"/);
  assert.doesNotMatch(before, /class="oracle-savings"/);
  h.context.report.savings = { calls: 4, tokens: 16000, tokensPerCall: 4000, estimate: true };
  const result = h.run('oracleStatsHTML(report)');
  for (const text of [translate('ui.oracle.savings'), '16000', translate('ui.oracle.savings.formula', { n: 4000 })]) assert.ok(result.includes(text), text);
  h.context.report.savings.tokensPerCall = '<script>';
  assert.ok(h.run('oracleStatsHTML(report)').includes('&lt;script&gt;'));
});

test('Oracle edges connect unique builder requesters and show pending research/implement turns', () => {
  const h = harness();
  Object.assign(h.context, { document: { querySelectorAll: () => [] }, selected: 'demo', planView: {}, names: {}, filter: null,
    runningOf: () => [], nodeOfRun: () => null, agentHealth: () => null, tierLabel: () => 'Standard', rolesText: () => 'Builder', cut: x => x, jobStatusLabel: () => 'Ready', duration: x => x });
  h.context.state.agents = [{ id: 'lead', label: 'Lead', enabled: true }, { id: 'builder', label: 'Builder', enabled: true }, { id: 'other', label: 'Other', enabled: true }];
  h.context.state.roster = { manager: 'lead', builders: ['builder', 'other'] };
  const job = { id: 'demo', status: 'running', stage: 'research', tasks: [], oracle: { turns: [{ role: 'builder', by: 'builder', a: 'OK' }, { role: 'builder', by: 'missing', a: 'OK' }, { role: 'builder', by: 'builder', q: 'Ask' }] } };
  h.context.state.jobs = [job];
  h.run(['let flowOlderOpen = false;', functionSource('svgText'), functionSource('flowRounds'), functionSource('flowRoundsHTML'), functionSource('drawFlow')].join('\n'));
  const paths = () => [...h.get('flow').innerHTML.matchAll(/<path class="edge oracle used ([^"]*)" d="([^"]+)"/g)];
  for (const stage of ['research', 'implement']) {
    job.stage = stage; h.run('drawFlow()');
    assert.equal(h.run('oracleFlowState(state.jobs[0]).working'), true);
    assert.equal(paths().length, 2, 'lead edge and one deduplicated builder edge; missing nodes ignored');
    assert.equal(paths()[0][1].trim(), '', 'lead edge is idle for a builder request');
    assert.equal(paths()[1][1].trim(), 'active');
    assert.match(paths()[1][2], /^M312 .* 365 /);
    assert.doesNotMatch(h.get('flow').innerHTML, /\sstyle=/);
  }
  for (const end of [{ a: 'OK' }, { a: '' }, { error: 'Failed' }, { code: 'timeout' }]) {
    job.oracle.turns[job.oracle.turns.length - 1] = { role: 'builder', by: 'builder', ...end };
    h.run('drawFlow()'); assert.equal(paths()[1][1].trim(), '');
  }
  job.oracle.turns.push({ role: 'builder', by: 'builder', q: 'Ask' }); job.status = 'done';
  h.run('drawFlow()'); assert.equal(paths()[1][1].trim(), '');
  job.tasks = [{ agent: 'builder', kind: 'build' }, { agent: 'other', kind: 'review', dependsOn: [0] }];
  h.run('drawFlow()'); assert.equal(paths().length, 2, 'graph task nodes also receive builder edges');
});

test('Research Oracle mode saves the settings contract and restores selection on failure', async () => {
  const h = harness(); h.context.notice = () => {}; h.context.drawFlow = () => {};
  const start = source.indexOf("$('oracle-research-mode').onchange ="), end = source.indexOf('\n};', start) + 4;
  h.run(source.slice(start, end));
  h.get('oracle-research-mode').value = 'auto';
  let release;
  h.context.response = () => new Promise(resolve => release = resolve);
  const pending = h.get('oracle-research-mode').onchange();
  assert.equal(h.get('oracle-research-mode').disabled, true);
  assert.equal(h.calls[0].path, 'settings'); assert.equal(h.calls[0].data.oracleResearch, 'auto');
  release({ oracle: { mode: 'off', researchMode: 'auto', maxPerResearchJob: 8 } }); await pending;
  assert.equal(h.context.state.oracle.maxPerResearchJob, 8);
  assert.equal(h.get('oracle-research-mode').value, 'auto');
  h.get('oracle-research-mode').value = 'off'; h.context.response = () => { throw new Error('failed'); };
  await h.get('oracle-research-mode').onchange();
  assert.equal(h.get('oracle-research-mode').value, 'auto'); assert.equal(h.get('oracle-research-mode').disabled, false);
  delete h.context.state.oracle.researchMode; h.get('oracle-research-mode').value = 'off';
  await h.get('oracle-research-mode').onchange(); assert.equal(h.get('oracle-research-mode').value, 'required');
});

test('Oracle mode saves the complete shape and restores selection on API failure', async () => {
  const h = harness(); h.context.notice = () => {}; h.context.drawFlow = () => {};
  const start = source.indexOf("$('oracle-mode').onchange ="), end = source.indexOf('\n};', start) + 4;
  h.run(source.slice(start, end));
  h.get('oracle-mode').value = 'required';
  h.context.response = () => ({ oracle: { mode: 'required', enabled: true, accounts: 2, accountIds: ['one', 'two'], maxPerJob: 3 } });
  await h.get('oracle-mode').onchange(); assert.equal(h.context.state.oracle.accounts, 2);
  h.get('oracle-mode').value = 'off'; h.context.response = () => { throw new Error('failed'); };
  await h.get('oracle-mode').onchange(); assert.equal(h.get('oracle-mode').value, 'required'); assert.equal(h.get('oracle-mode').disabled, false);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function captureFixture(file, directory, width, views) {
  const profile = fs.mkdtempSync(join(directory, 'oracle-chrome-'));
  let child, socket;
  const pending = new Map(), errors = [];
  try {
    child = spawn(findChrome(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { env: previewEnv(0), windowsHide: true, stdio: 'ignore' });
    child.on('error', error => errors.push(error.message));
    const active = join(profile, 'DevToolsActivePort'), until = Date.now() + 20000;
    while (!fs.existsSync(active)) { assert.ok(Date.now() < until && !errors.length, errors.join('\n') || 'Chrome startup timeout'); await delay(100); }
    const port = Number(fs.readFileSync(active, 'utf8').split('\n')[0]);
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    socket = new WebSocket((await response.json()).webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let seq = 0;
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data), request = pending.get(data.id);
      if (request) { pending.delete(data.id); clearTimeout(request.timer); data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result); }
      if (data.method === 'Runtime.exceptionThrown' || data.method === 'Log.entryAdded' && data.params.entry.level === 'error') errors.push(JSON.stringify(data.params));
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, timer: setTimeout(() => reject(new Error(method + ' timeout')), 15000) }); socket.send(JSON.stringify({ id, method, params })); });
    await send('Runtime.enable'); await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 600 });
    for (const view of views) {
      await send('Page.navigate', { url: pathToFileURL(file).href + '?' + view });
      await delay(600);
      const result = await send('Runtime.evaluate', { expression: 'JSON.stringify({ready:document.body.dataset.ready,overflow:document.documentElement.scrollWidth>innerWidth})', returnByValue: true });
      const check = JSON.parse(result.result.value); assert.equal(check.ready, 'true'); assert.equal(check.overflow, false, `${width}: ${view} overflows`);
      const metrics = await send('Page.getLayoutMetrics');
      const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.max(width < 600 ? 844 : 1000, metrics.cssContentSize.height), scale: 1 } });
      fs.writeFileSync(join(directory, `oracle-${view}-${width}.png`), Buffer.from(image.data, 'base64'));
    }
    fs.writeFileSync(join(directory, `oracle-console-${width}.json`), JSON.stringify(errors, null, 2), 'utf8');
    assert.deepEqual(errors, []);
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    socket?.close();
    try { await stopTree(child?.pid); } finally { await removeTempDir(profile); }
  }
}

test('Oracle desktop/mobile browser evidence with real renderers and mocked API, no demo server', { skip: process.env.ORACLE_UI_EVIDENCE !== '1', timeout: 120000 }, async () => {
  assert.ok(findChrome(), 'Chrome/Edge required for evidence');
  const directory = resolve('.ai-team/evidence'); fs.mkdirSync(directory, { recursive: true });
  const dialogs = ['oracle-dialog', 'oracle-test-dialog'].map(id => html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?</dialog>`))[0]).join('');
  const settings = html.match(/<details class="settings">[\s\S]*?<\/details>/)[0].replace('<details class="settings">', '<details class="settings" open>');
  const fixture = `<!doctype html><html lang="vi" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self' file:; script-src 'unsafe-inline'; style-src 'self' file:"><link rel="stylesheet" href="${pathToFileURL(resolve('public/style.css'))}"></head><body><main><header><h1>AI Team · Control Room</h1></header><section class="panel network"><div class="panel-heading"><h2>ChatGPT web · Oracle</h2></div><div id="flow" class="network-body"></div><div id="bench"></div></section><div id="stats"></div>${dialogs}<dialog id="settings-fixture" class="oracle-dialog">${settings}</dialog></main><script>
    const $ = id => document.getElementById(id), esc = ${esc.toString()}, locale = ${JSON.stringify(locale)}, t = ${translate.toString()}, clock = x => x, tokenNumber = x => String(x ?? '—');
    const state = {oracle:{mode:'auto',researchMode:'required',accountIds:['web-main','web-backup']},jobs:[],agents:[{id:'lead',label:'Lead',enabled:true},{id:'builder',label:'Builder',enabled:true}],roster:{manager:'lead',builders:['builder']}};
    let selected = 'demo', planView = {}, filter, names = {}, oracleTestBusy = false;
    const runningOf = j => j?.running || [], nodeOfRun = () => 'manager', agentHealth = () => null, tierLabel = () => 'Standard', rolesText = () => 'Manager', cut = x => x, jobStatusLabel = () => 'Sẵn sàng', duration = x => x;
    ${helpers.filter(name => name !== 'drawOracleStats').concat(['svgText','drawFlow']).map(functionSource).join('\n')}
    const turns = [{q:'Đánh giá rủi ro trước khi lập plan. Token: [REDACTED]',a:'Nên kiểm thử lỗi phiên đăng nhập và timeout; Oracle lỗi thì tiếp tục lập plan.',at:'2026-10-20 11:15:00 JST',ms:2300,waitMs:200,account:'web-main',auto:true},{q:'Cần bổ sung gì cho kiểm thử?',error:'Session expired',code:'not_logged_in',at:'2026-10-20 11:16:00 JST',ms:800,account:'web-backup'}];
    const job = {id:'demo',status:'ready',stage:'plan',oracle:{turns},roster:state.roster}; state.jobs=[job];
    turns.push({role:'builder',by:'builder',q:'Compare board design patterns for research.',a:'Use clear ownership and explicit task dependencies.',at:'2026-10-21',ms:1500,account:'web-main'});
    document.querySelectorAll('[data-i18n]').forEach(el => el.textContent=t(el.dataset.i18n));
    const mode = location.search.slice(1).replace('-light','');
    if(location.search.endsWith('-light')) document.documentElement.dataset.theme='light';
    if(mode==='idle') job.oracle={turns:[],skipReason:'Không cần tham khảo thêm'};
    if(mode==='working') {job.status='running';job.stage='research';job.oracle={turns:[{role:'builder',by:'builder',q:'Đang hỏi',account:'web-main'}]};}
    drawFlow();
    const api = async (path,{account}) => ({results:[{account,ok:account==='web-main',answer:'Kết nối thành công. Oracle sẵn sàng.',error:account==='web-main'?undefined:'Session expired',code:'not_logged_in',ms:1200}]});
    (async()=>{
      if(mode==='turns') { const node=document.querySelector('[data-oracle]'); node.onkeydown({key:'Enter',preventDefault(){}}); if(!$('oracle-dialog').open)throw Error('Keyboard failed'); }
      if(mode==='test') {openOracleTest();await testOracleAccounts(state.oracle.accountIds);}
      if(mode==='stats') {const totals={asks:12,ok:10,failed:2,avgMs:2300,auto:4,lead:5,builder:7};$('stats').innerHTML=oracleStatsHTML({totals,savings:{calls:6,tokens:24000,tokensPerCall:4000,estimate:true},byDay:[{key:'2026-10-20',...totals}],byJob:[{key:'demo',title:'Kiểm chứng Oracle',...totals}],byProject:[{key:'Control Room',...totals}]});document.querySelector('.network').hidden=true;}
      if(mode==='settings') {$('oracle-mode').value=state.oracle.mode;$('oracle-research-mode').value=state.oracle.researchMode;$('settings-fixture').showModal();}
      if(mode==='flow'||mode==='working') {const paths=document.querySelectorAll('path.edge.oracle.used');if(paths.length!==2)throw Error('Missing builder edge');if(mode==='working'&&!paths[1].classList.contains('active'))throw Error('Builder edge is not active');if(innerWidth<600)$('flow').scrollLeft=160;}
      document.body.dataset.ready='true';
    })();
  </script></body></html>`;
  const file = join(directory, 'oracle-ui-fixture.html'); fs.writeFileSync(file, fixture, 'utf8');
  for (const width of [1440, 390]) await captureFixture(file, directory, width, ['settings', 'flow', 'idle', 'working', 'turns', 'test', 'stats', 'test-light', 'stats-light']);
});
