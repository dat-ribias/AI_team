import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function harness(translate = (key, vars) => key + JSON.stringify(vars || {})) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', parentElement: {}, disabled: false, open: false });
    return nodes.get(id);
  };
  get('notice').textContent = 'Existing notice';
  const state = {
    agents: [], jobs: [], projects: [{ id: 'fixture' }],
    resources: { active: 8, maxAgents: 9, slots: 12, ramPercent: 40, totalGB: 32, controllerMB: 128, cpuPercent: 30 },
  };
  const context = vm.createContext({
    state, t: translate, document: { getElementById: get, querySelectorAll: () => [] },
    ...Object.fromEntries(['drawStorage', 'drawSessions', 'syncTab', 'drawJobsList', 'drawJobsDialog', 'drawFlow', 'drawInspector', 'drawQuota', 'drawLogin'].map(name => [name, () => {}])),
  });
  const start = source.indexOf('function drawState(');
  vm.runInContext(`
    const $ = id => document.getElementById(id);
    ${source.match(/^const esc = .*;$/m)[0]}
    let names, selected = null, resultsSelection = null, tab = 'timeline', slot = null;
    ${source.slice(start, source.indexOf('\n}', start) + 2)}
  `, context);
  return { state, get, render: () => { vm.runInContext('drawState()', context); return get('metrics').innerHTML; } };
}

test('agents below or equal to the recommendation show no warning', () => {
  const { state, render } = harness();
  for (const active of [0, 8, 9]) {
    state.resources.active = active;
    const html = render();
    assert.doesNotMatch(html, /metric-agents-warning|ui.metric.agentsAboveRecommended/);
    assert.ok(html.includes(`${active} <small>/ 12</small>`));
    assert.match(html, /ui.metric.onDemand/);
  }
});

test('agents above the recommendation show a separate warning with n and m', () => {
  const { state, get, render } = harness();
  state.resources.active = 10;
  const before = JSON.stringify(state.resources);
  const html = render();
  assert.ok(html.includes('<small class="metric-agents-warning">ui.metric.agentsAboveRecommended{&quot;n&quot;:10,&quot;m&quot;:9}</small>'));
  assert.match(html, /ui.metric.onDemand/);
  assert.equal(JSON.stringify(state.resources), before);
  assert.equal(get('notice').textContent, 'Existing notice');
  assert.equal(get('submit-task').disabled, false);
});

test('warning is removed on the next render when active returns to or below the recommendation', () => {
  const { state, render } = harness();
  for (const active of [9, 8]) {
    state.resources.active = 10;
    assert.match(render(), /metric-agents-warning/);
    state.resources.active = active;
    assert.doesNotMatch(render(), /metric-agents-warning|ui.metric.agentsAboveRecommended/);
  }
});

test('waiting reason and recommendation warning coexist and are escaped', () => {
  const { state, render } = harness((key, vars) => key === 'ui.metric.agentsAboveRecommended' ? `Running ${vars.n} > ${vars.m} <img src=x>` : key);
  state.resources.active = 10;
  state.resources.waitingReason = 'CPU <limit> & "busy"';
  const html = render();
  assert.ok(html.includes('CPU &lt;limit&gt; &amp; &quot;busy&quot;'));
  assert.ok(html.includes('Running 10 &gt; 9 &lt;img src=x&gt;'));
  assert.doesNotMatch(html, /<img|style=|ui.metric.onDemand/);
  assert.equal(state.resources.waitingReason, 'CPU <limit> & "busy"');
});

test('CPU metric renders the new 30 second machine average label', () => {
  const { render } = harness();
  const html = render();
  assert.match(html, /<strong>30%<\/strong><small>ui.metric.cpuAverage30s\{\}<\/small>/);
  assert.doesNotMatch(html, /ui.metric.cpuNote/);
});
