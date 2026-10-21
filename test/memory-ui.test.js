import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function drawMemory()');
const memorySource = source.slice(start, source.indexOf('\n}', start) + 2);
const locale = JSON.parse(fs.readFileSync(new URL('../locales/vi.json', import.meta.url), 'utf8'));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const snapshot = (summary = 'Summary', summaryRevision = 0) => ({ summary, summaryRevision, facts: [], log: [] });
const conflict = () => Object.assign(new Error('Conflict'), { status: 409, details: { code: 'SESSION_SUMMARY_CONFLICT' } });

function harness(handler = () => snapshot()) {
  const nodes = new Map(), calls = [], errors = [], factButtons = [];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', disabled: false, hidden: false, textContent: '', files: [], click() { return this.onclick(); } });
    return nodes.get(id);
  };
  Object.defineProperty(get('memory-body'), 'innerHTML', {
    get() { return this.markup || ''; },
    set(markup) {
      this.markup = markup;
      for (const match of markup.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/g)) {
        const [, tag, attributes, id, content] = match;
        nodes.delete(id);
        Object.assign(get(id), { value: tag === 'textarea' ? content : '', disabled: /\bdisabled\b/.test(attributes), hidden: /\bhidden\b/.test(attributes), textContent: content });
      }
    },
  });
  const context = vm.createContext({
    $: get, state: { sessions: [{ id: 's', name: 'Session', revision: 999 }] },
    document: { querySelectorAll: () => factButtons }, location: {},
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    t: (key, vars = {}) => (locale[key] || key).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m),
    clock: value => value || '', cleanupButtons: () => '', wireCleanup: () => {}, refresh: async () => {},
    attempt: async fn => { try { await fn(); } catch (e) { errors.push(e); } },
    api: async (path, data) => {
      calls.push({ path, data: data && JSON.parse(JSON.stringify(data)) });
      return path === 'backups' ? { dir: 'fixture', list: [] } : handler(path, data);
    },
  });
  vm.runInContext(`let curProject = 'p', curSession = 's', memoryQuery = '', memoryHistory = false, memoryRender = 0, selected; ${memorySource}`, context);
  return { context, get, calls, errors, factButtons, run: code => vm.runInContext(code, context), draw: () => vm.runInContext('drawMemory()', context) };
}

test('memory UI saves exact summary revision and scope, then reloads the new revision', async () => {
  let saved = snapshot('Original', 4);
  const h = harness((path, data) => {
    if (data) { assert.equal(data.summaryRevision, saved.summaryRevision); saved = snapshot(data.summary, saved.summaryRevision + 1); }
    return saved;
  });
  await h.draw(); h.get('mem-summary').value = 'Owner draft';
  await h.get('mem-summary-save').onclick();
  assert.deepEqual(h.calls.find(x => x.data).data, { project: 'p', session: 's', summary: 'Owner draft', summaryRevision: 4 });
  assert.equal(h.get('mem-summary').value, 'Owner draft');
  h.get('mem-summary').value = 'Next'; await h.get('mem-summary-save').onclick();
  assert.equal(h.calls.filter(x => x.data).at(-1).data.summaryRevision, 5);
  assert.equal(h.errors.length, 0);
});

test('memory UI two editors preserve conflict draft and explicitly reload before saving', async () => {
  let saved = snapshot('Original', 0);
  const backend = (path, data) => {
    if (data) {
      if (data.summaryRevision !== saved.summaryRevision) throw conflict();
      saved = snapshot(data.summary, saved.summaryRevision + 1);
    }
    return { ...saved };
  };
  const first = harness(backend), second = harness(backend);
  await Promise.all([first.draw(), second.draw()]);
  first.get('mem-summary').value = 'First editor'; await first.get('mem-summary-save').onclick();
  second.get('mem-summary').value = 'Second draft'; await second.get('mem-summary-save').onclick();
  assert.equal(saved.summary, 'First editor');
  assert.equal(second.get('mem-summary').value, 'Second draft');
  assert.equal(second.get('mem-summary-error').textContent, locale['ui.mem.summaryConflict']);
  assert.equal(second.get('mem-summary-error').hidden, false);
  assert.equal(second.get('mem-summary-save').disabled, true);
  await second.get('mem-summary-save').onclick();
  assert.equal(second.calls.filter(x => x.data).length, 1);
  await second.get('mem-summary-reload').onclick();
  assert.equal(second.get('mem-summary').value, 'First editor');
  assert.equal(second.get('mem-summary-error').hidden, true);
  second.get('mem-summary').value = 'Reviewed draft'; await second.get('mem-summary-save').onclick();
  assert.equal(saved.summary, 'Reviewed draft');
  assert.equal(second.calls.filter(x => x.data).at(-1).data.summaryRevision, 1);
});

test('memory UI missing session or revision prevents summary save without guessing', async () => {
  for (const revision of [undefined, null, -1, '3', 1.5]) {
    const h = harness(() => ({ ...snapshot(), summaryRevision: revision }));
    await h.draw(); assert.equal(h.get('mem-summary-save').disabled, true);
    assert.equal(h.get('mem-summary-error').textContent, locale['ui.mem.summaryReloadRequired']);
    await h.get('mem-summary-save').onclick(); assert.equal(h.calls.filter(x => x.data).length, 0);
  }
  const h = harness(); h.run("curSession = ''"); await h.draw();
  await h.get('mem-summary-save').onclick(); assert.equal(h.calls.filter(x => x.data).length, 0);
});

test('memory UI stale GET and search responses cannot replace a newer render or scope', async () => {
  for (const change of ["curProject = 'other'", "curSession = 'other'", '']) {
    const pending = deferred(); let count = 0;
    const h = harness(() => ++count === 1 ? pending.promise : snapshot('New', 2));
    const old = h.draw(); h.run(change); await h.draw();
    pending.resolve(snapshot('Old', 1)); await old;
    assert.equal(h.get('mem-summary').value, 'New');
    assert.equal(h.calls.filter(x => x.path.startsWith('memory?')).at(-1).path,
      `memory?project=${change.includes('curProject') ? 'other' : 'p'}&session=${change.includes('curSession') ? 'other' : 's'}`);
  }
  const pending = deferred(), searching = deferred();
  const h = harness(path => { if (path.startsWith('memory/search')) { searching.resolve(); return pending.promise; } return snapshot(); });
  h.run("memoryQuery = 'find'"); const old = h.draw(); await searching.promise;
  h.run("curProject = 'other'; memoryQuery = ''"); await h.draw();
  const markup = h.get('memory-body').innerHTML;
  pending.resolve({ results: [] }); await old;
  assert.equal(h.get('memory-body').innerHTML, markup);
  assert.ok(h.calls.some(x => x.path === 'memory/search?project=p&query=find'));
});

test('memory UI obsolete handlers and pending saves cannot affect another scope or render', async () => {
  for (const change of ["curProject = 'other'", "curSession = 'other'", '']) {
    for (const outcome of ['success', 'conflict']) {
      const pending = deferred();
      const h = harness((path, data) => data ? pending.promise : snapshot('Loaded', 3));
      await h.draw(); const oldSave = h.get('mem-summary-save'), oldAdd = h.get('mem-add-btn');
      h.get('mem-summary').value = 'Draft'; const saving = oldSave.onclick();
      assert.deepEqual(h.calls.find(x => x.data).data, { project: 'p', session: 's', summary: 'Draft', summaryRevision: 3 });
      h.run(change); await h.draw(); h.get('mem-summary').value = 'New draft';
      if (outcome === 'success') pending.resolve({}); else pending.reject(conflict());
      await saving; await oldSave.onclick(); await oldAdd.onclick();
      assert.equal(h.get('mem-summary').value, 'New draft');
      assert.equal(h.get('mem-summary-error').hidden, true);
      assert.equal(h.calls.filter(x => x.data).length, 1);
      assert.equal(h.calls.filter(x => x.path.startsWith('memory?')).length, 2);
    }
  }
  const h = harness(); await h.draw(); const save = h.get('mem-summary-save');
  h.run("curSession = 'other'"); await save.onclick();
  assert.equal(h.calls.filter(x => x.data).length, 0);
});

test('memory UI suppresses double save and allows retry after ordinary API errors', async () => {
  const pending = deferred();
  const h = harness((path, data) => data ? pending.promise : snapshot());
  await h.draw(); h.get('mem-summary').value = 'Draft';
  const first = h.get('mem-summary-save').onclick();
  await h.get('mem-summary-save').onclick();
  assert.equal(h.calls.filter(x => x.data).length, 1);
  pending.reject(new Error('Offline')); await first;
  assert.equal(h.errors[0].message, 'Offline');
  assert.equal(h.get('mem-summary').value, 'Draft');
  assert.equal(h.get('mem-summary-save').disabled, false);
});

test('memory UI import captures project and ignores scope changes during file read', async () => {
  const pending = deferred(); const h = harness(); await h.draw();
  h.get('mem-import').files = [{ size: 10, text: () => pending.promise }];
  const importing = h.get('mem-import').onchange(); h.run("curProject = 'other'");
  pending.resolve('{}'); await importing;
  assert.equal(h.calls.filter(x => x.data).length, 0);
});

test('memory UI keeps fact revision separate and preserves rendered fact/log content', async () => {
  const h = harness(() => ({ ...snapshot('Summary', 7), facts: [{ id: 1, kind: 'fact', text: '<Fact>', status: 'active', revision: 42 }], log: [{ text: '<Log>' }] }));
  const button = { dataset: { memStale: '1', memDel: '1', memRevision: '42' } }; h.factButtons.push(button);
  await h.draw();
  assert.match(h.get('memory-body').innerHTML, /&lt;Fact&gt;/);
  assert.match(h.get('memory-body').innerHTML, /&lt;Log&gt;/);
  assert.match(h.get('memory-body').innerHTML, /data-mem-revision="42"/);
  await button.onclick();
  assert.equal(h.calls.find(x => x.data).data.revision, 42);
  assert.equal(h.calls.find(x => x.data).data.summaryRevision, undefined);
  await h.get('mem-summary-save').onclick();
  assert.equal(h.calls.filter(x => x.data).at(-1).data.summaryRevision, 7);
});

test('memory UI locales parse without mojibake and render respects CSP', () => {
  for (const language of ['vi', 'en', 'ja']) {
    const text = fs.readFileSync(new URL(`../locales/${language}.json`, import.meta.url), 'utf8');
    const dictionary = JSON.parse(text);
    assert.doesNotMatch(text, /Ã|á»|\uFFFD/);
    for (const suffix of ['reloadSummary', 'summaryConflict', 'summaryReloadRequired']) assert.ok(dictionary[`ui.mem.${suffix}`]);
  }
  assert.doesNotMatch(memorySource, /\sstyle\s*=/i);
});
