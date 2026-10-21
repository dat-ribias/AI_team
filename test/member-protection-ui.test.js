import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { memberProtection } from '../src/providers.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const locale = JSON.parse(fs.readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const translate = key => locale[key] || key;
function harness(agents, t = translate) {
  const nodes = new Map(), elements = [], calls = [];
  const root = {
    get innerHTML() { return this.html || ''; },
    set innerHTML(html) {
      this.html = html;
      nodes.clear(); nodes.set('project-access', root); elements.length = 0;
      for (const tag of html.matchAll(/<(?:input|button|select|datalist)\b([^>]*)>/g)) {
        const attrs = Object.fromEntries([...tag[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        const node = { value: '', dataset: {}, checked: /\bchecked\b/.test(tag[1]), disabled: /\bdisabled\b/.test(tag[1]), attrs };
        for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) node.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
        if (attrs.id) nodes.set(attrs.id, node);
        elements.push(node);
      }
    },
  };
  nodes.set('project-access', root);
  const access = { folders: [{ path: 'docs', members: [] }], paths: [{ path: '.', grant: { '*': 'read' } }], repos: [], network: [], shell: ['*'] };
  const state = { agents, projects: [{ id: 'fixture', path: 'fixture', access }], sessions: [{ id: 'session', project: 'fixture', name: 'Fixture' }] };
  const context = vm.createContext({
    state, t, structuredClone, curProject: 'fixture',
    document: { getElementById: id => nodes.get(id) || null, querySelectorAll: selector => elements.filter(el => selector.slice(1, -1) in el.attrs) },
    rolesOf: () => ['builder'], rolesText: () => 'Builder',
    api: async (...args) => { calls.push(args); return {}; },
    attempt: fn => fn(), refresh: async () => {}, notice: () => {}, ask: async () => true,
  });
  const start = source.indexOf('function accessProtection('), end = source.indexOf('\n}', source.indexOf('function drawAccess(')) + 2;
  vm.runInContext(`const $ = id => document.getElementById(id);
    ${source.match(/^const esc = .*;$/m)[0]}
    let acc = null; const repoDirs = { fixture: [] };
    ${source.slice(start, end)}`, context);
  return { state, calls, get: id => nodes.get(id), render: () => { vm.runInContext('drawAccess()', context); return root.innerHTML; }, elements };
}

function member(id, provider, config = {}, overrides = {}, platform = 'win32') {
  const agent = { id, label: id, provider, enabled: true, ...overrides };
  return { ...agent, protection: memberProtection(agent, config, platform) };
}

test('protection renders Codex Windows none, sandbox and member overrides from metadata', () => {
  const { render } = harness([
    member('unrestricted', 'codex', { codexWindowsSandbox: 'none' }),
    member('sandboxed', 'codex', { codexWindowsSandbox: 'none' }, { windowsSandbox: 'unelevated' }),
    member('linux', 'codex', { codexWindowsSandbox: 'none' }, {}, 'linux'),
  ]);
  const html = render();
  assert.ok(html.includes(translate('ui.access.protectionIntro')));
  assert.ok(html.includes(translate('ui.access.protectionScope')));
  assert.ok(html.includes(translate('ui.access.protectionUnrestricted')));
  assert.ok(html.includes(translate('ui.access.protectionSandboxed')));
  for (const text of ['--sandbox danger-full-access', '--sandbox read-only', 'windowsSandbox=none (global, applicable=true)', 'windowsSandbox=unelevated (agent, applicable=true)', 'windowsSandbox=none (global, applicable=false)', 'task-baseline', 'inputs.stage=plan', 'inputs.checks=0', 'inputs.network=false', 'stage, kind, checks, network', 'network=unrestricted', 'controller-stage-dependent']) assert.ok(html.includes(text), text);
  assert.ok(html.includes(translate('ui.access.protectionLimits')));
  assert.doesNotMatch(html, /style=|<dialog/);
});

test('protection renders Antigravity skip, provider settings and proposal preview intake exceptions', () => {
  const { render } = harness([
    member('global', 'antigravity', { agyAutoApprove: true }, { model: 'gemini-test' }),
    member('override', 'antigravity', { agyAutoApprove: true }, { autoApprove: false, model: 'gemini-test' }),
    member('codex', 'codex'),
  ]);
  const html = render(), global = html.split('<article class="access-protection-member">')[1];
  assert.ok(global.includes('--dangerously-skip-permissions'));
  assert.ok(global.includes('autoApprove=true (global, applicable=true)'));
  const exceptions = global.slice(global.indexOf('<details>'));
  assert.doesNotMatch(exceptions, /--dangerously-skip-permissions/);
  assert.equal((exceptions.match(/approval=provider-settings/g) || []).length, 3);
  assert.equal((exceptions.match(/not-applied/g) || []).length, 3);
  assert.ok(html.includes('autoApprove=false (agent, applicable=true)'));
  for (const key of ['Exceptions', 'Proposal', 'Preview', 'Intake', 'NotApplicable', 'Provider']) assert.ok(html.includes(translate('ui.access.protection' + key).replaceAll("'", '&#39;')), key);
});

test('protection missing or partial metadata stays unknown without inferring from provider', () => {
  const { render } = harness([
    { id: 'codex', label: 'Missing', provider: 'codex', enabled: true },
    { id: 'agy', label: 'Partial', provider: 'antigravity', enabled: true, protection: { contexts: { job: {} } } },
  ]);
  const html = render();
  assert.equal((html.match(/<p>Protection status is unknown<\/p>/g) || []).length, 8);
  assert.doesNotMatch(html, /The CLI sandbox is enabled|adapter disables|--sandbox|skip-permissions/);
});

test('protection escapes member metadata and translations and renders again without duplicates', () => {
  const agent = member('escape', 'codex');
  agent.label = '<img src=x>';
  agent.protection.platform = '<svg onload=x>';
  agent.protection.contexts.job.cliFlags.push('<script>x</script>');
  agent.protection.contexts.job.settings.windowsSandbox.source = '<source>';
  agent.protection.contexts.job.dependsOn.push('<input>');
  const { render, state } = harness([agent], key => translate(key) + '<translated>');
  const before = JSON.stringify(state), html = render();
  for (const text of ['&lt;img src=x&gt;', '&lt;svg onload=x&gt;', '&lt;script&gt;x&lt;/script&gt;', '&lt;source&gt;', '&lt;input&gt;', '&lt;translated&gt;']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<img|<svg|<script|<source>|<translated>/);
  assert.equal(render(), html);
  assert.equal((html.match(/<section class="access-protection">/g) || []).length, 1);
  assert.equal(JSON.stringify(state), before);
  delete state.agents[0].protection;
  assert.doesNotMatch(render(), /--sandbox/);
});

test('protection keeps permission controls and existing edit save undo and session handlers', async () => {
  const { render, get, elements, calls } = harness([member('builder', 'codex')]);
  const html = render();
  for (const id of ['acc-project', 'acc-scope', 'acc-propose', 'acc-save', 'acc-undo', 'acc-add-rel', 'acc-pick', 'acc-add']) {
    assert.ok(html.includes(`id="${id}"`), id);
    assert.equal(typeof (get(id).onclick || get(id).onchange), 'function', id);
  }
  const network = elements.find(el => el.dataset.acc === 'net' && el.dataset.m === 'builder');
  network.checked = true; network.onchange();
  assert.equal(get('acc-save').disabled, false);
  await get('acc-save').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['projects/fixture/access', { folders: [{ path: 'docs', members: [] }], network: ['builder'], repos: [], paths: [{ path: '.', grant: { '*': 'read' } }], shell: ['*'] }]);
  assert.equal(get('acc-save').disabled, true);
  get('acc-scope').value = 'session'; await get('acc-scope').onchange();
  assert.ok(render().includes(translate('ui.access.inherit')));
  get('acc-undo').onclick();
  assert.equal(get('acc-save').disabled, true);
});
