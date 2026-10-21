import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const locale = JSON.parse(fs.readFileSync(new URL('../locales/vi.json', import.meta.url), 'utf8'));
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness() {
  const nodes = new Map(), calls = [], notices = [];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', selectedOptions: [], rows: [], innerHTML: '', querySelectorAll() { return this.rows; }, close() { this.closed = true; } });
    return nodes.get(id);
  };
  const context = vm.createContext({
    $: get, state: { jobs: [] },
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    jobTitle: job => job.title || job.goal || job.id,
    t: (key, vars = {}) => (locale[key] || key).replace(/\{(\w+)\}/g, (m, key) => vars[key] ?? m),
    attempt: fn => fn(), ask: async () => context.answer, answer: true,
    api: async (path, data) => { calls.push({ path, data }); return context.result; },
    refresh: async () => {}, notice: value => notices.push(value),
  });
  vm.runInContext(['dependencyOptions', 'loadDependencies', 'dependencyHTML', 'planRelatedHTML', 'selectedRelated', 'wireDependencies', 'decisionReason'].map(functionSource).join('\n'), context);
  return { context, get, calls, notices, run: script => vm.runInContext(script, context) };
}

test('create form has labelled multiple selector, reloads on project change and sends dependsOn', () => {
  assert.match(html, /<label for="depends-on" data-i18n="ui.task.dependsOn"><\/label><select id="depends-on" multiple/);
  assert.match(source, /\$\('project'\).onchange = .*loadDependencies\(\).*loadBaseBranches/);
  assert.match(source, /const openTask = .*loadDependencies\(\)/);
  assert.match(source, /dependsOn: \[\.\.\.\$\('depends-on'\).selectedOptions\]\.map\(option => option.value\)/);
  const h = harness();
  h.context.state.jobs = ['queued', 'running', 'waiting', 'paused', 'blocked', 'ready', 'merging', 'merged', 'cancelled', 'done'].map(status => ({ id: status, status, project: 'p', title: '<unsafe>' }));
  h.context.state.jobs.push({ id: 'other', status: 'ready', project: 'other' });
  h.get('project').value = 'p'; h.run('loadDependencies()');
  const options = h.get('depends-on').innerHTML;
  for (const status of ['queued', 'running', 'waiting', 'paused', 'blocked', 'ready', 'merging']) assert.ok(options.includes(`value="${status}"`));
  assert.doesNotMatch(options, /value="(?:merged|cancelled|done|other)"|<unsafe>/);
  h.get('project').value = 'other'; h.run('loadDependencies()');
  assert.match(h.get('depends-on').innerHTML, /value="other"/);
  assert.doesNotMatch(h.get('depends-on').innerHTML, /value="ready"/);
  assert.match(h.run(`dependencyOptions('p', ['merged'], 'ready')`), /value="merged" selected/);
  assert.doesNotMatch(h.run(`dependencyOptions('p', [], 'ready')`), /value="ready"/);
});

test('plan related radios start unselected, escape content and submit only explicit choices', () => {
  const h = harness();
  h.context.state.jobs = [{ id: 'a', title: '<title>' }];
  const markup = h.run(`planRelatedHTML({ relatedJobs: [{id:'a',reason:'<reason>',mode:'sequential'},{id:'b',reason:'Review',mode:'parallel'}], planOverlap:[{id:'a',files:['<file>','b.js']}] })`);
  assert.equal((markup.match(/type="radio"/g) || []).length, 4);
  assert.doesNotMatch(markup, /checked|style=|<reason>|<title>|<file>/);
  assert.match(markup, /&lt;title&gt;[\s\S]*&lt;reason&gt;/);
  assert.match(markup, /plan-overlap[\s\S]*&lt;file&gt;, b.js/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('selectedRelated()'))), {});
  h.get('inspector').rows = [{ dataset: { related: 'a' }, value: 'sequential' }];
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('selectedRelated()'))), { a: 'sequential' });
  assert.match(source, /action: 'approve-plan', version: gate.version, hash: gate.hash, related: selectedRelated\(\)/);
  assert.match(source, /relatedGate === job.id \+ ':' \+ job.planGate\?\.hash/);
});

test('dependency and merge queue chips include reasons, base branch and acceptance wait', () => {
  const h = harness();
  const markup = h.run(`dependencyHTML({depends:[{id:'a',title:'<title>',met:true},{id:'b',reason:'no_commits'}], blockedReason:{kind:'depends',ids:['b']}, baseBranch:'<master>', mergeQueue:{branch:'<master>',position:2,wait:'acceptance'}})`);
  assert.match(markup, /✓ #a/); assert.match(markup, /⏳ #b/);
  assert.match(markup, /Chưa có commit riêng/); assert.match(markup, /Chờ #b vào &lt;master&gt;/);
  assert.match(markup, /Hàng merge: vị trí 2/); assert.match(markup, /Chờ nghiệm thu bản đã sync/);
  assert.doesNotMatch(markup, /<title>|<master>|style=/);
  assert.equal(h.run('dependencyHTML({})'), '');
  assert.match(h.run(`decisionReason({kind:'depends_broken',deps:['a']})`), /#a/);
  // Thanh bên hẹp dùng chip gọn (chỉ mã job còn chờ); inspector giữ chip đầy đủ.
  assert.match(source, /\$\{badge\(j\)\}\$\{dependencyMini\(j\)\}/); assert.match(source, /\$\{badge\(job\)\}\$\{dependencyHTML\(job\)\}/);
});

test('broken dependency controls confirm in-page and drop only broken ids', async () => {
  const h = harness(), button = { textContent: 'Bỏ phụ thuộc', dataset: { dependsAction: 'set-depends' } };
  h.get('inspector').rows = [button];
  h.run(`wireDependencies({id:'job',depends:[{id:'good',met:true},{id:'cancelled',reason:'cancelled'},{id:'deleted',reason:'deleted'}]})`);
  h.context.answer = false; await button.onclick(); assert.equal(h.calls.length, 0); assert.equal(button.disabled, false);
  h.context.answer = true; await button.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { path: 'jobs/job/control', data: { action: 'set-depends', ids: ['good'] } });
  for (const action of ['cancel', 'depends-wait', 'merge-dequeue']) {
    button.dataset.dependsAction = action; await button.onclick(); assert.equal(h.calls.at(-1).data.action, action);
  }
  h.context.api = async () => { throw new Error('Rejected'); };
  await assert.rejects(button.onclick(), /Rejected/); assert.equal(button.disabled, false);
  assert.match(functionSource('editDependencies'), /action: 'set-depends', ids:/);
  assert.match(functionSource('editDependencies'), /d.showModal\(\)/);
});

test('queued merge closes dialog and reports position even when job remains ready', async () => {
  for (const wrapped of [false, true]) {
    const h = harness();
    const job = { id: 'job', status: 'ready', mergeQueue: { position: 3 } };
    h.context.result = wrapped ? { job } : job;
    h.context.state.jobs = [job];
    const start = source.indexOf("$('merge-go').onclick =");
    const handler = source.slice(start, source.indexOf('\n});', start) + 4);
    vm.runInContext(`let mergeJob='job', mergeCheck={}, mergeSending=false; const mergeTarget=()=>({type:'base'}), updateMergeButton=()=>{}; ${handler}`, h.context);
    await h.get('merge-go').onclick();
    assert.equal(h.get('merge-dialog').closed, true);
    assert.match(h.notices[0], /Đã xếp hàng vị trí 3/);
    assert.equal(h.get('merge-error').textContent, undefined);
  }
});

test('new UI and backend keys exist in all locales, JSON parses, markup respects CSP', () => {
  const keys = Object.keys(locale).filter(key => /^(?:ui\.(?:depends\.|task\.depends|job\.depends|decisions\.depends_broken|plan\.(?:related|overlap)|merge\.(?:queued|queuePosition|dequeue|waitAcceptance))|srv\.team\.(?:depends_|merge_que|merge_deque))/.test(key));
  assert.equal(keys.length, 36);
  for (const language of ['vi', 'en', 'ja']) {
    const text = fs.readFileSync(new URL(`../locales/${language}.json`, import.meta.url), 'utf8');
    const dictionary = JSON.parse(text); assert.doesNotMatch(text, /Ã|á»|\uFFFD/);
    for (const key of keys) assert.ok(dictionary[key], `${language}: ${key}`);
  }
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  for (const name of ['dependencyHTML', 'planRelatedHTML', 'editDependencies', 'wireDependencies']) assert.doesNotMatch(functionSource(name), /\sstyle\s*=|\b(?:alert|confirm)\s*\(/);
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /@media\(max-width:480px\)/);
});
