import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function drawFlow() {');
assert.ok(start >= 0);
const flowSource = source.slice(start, source.indexOf('\n}', start) + 2);
const fn = name => { const i = source.indexOf(`function ${name}(`); return source.slice(i, source.indexOf('\n}', i) + 2); };
const helpers = ['oracleFlowState', 'flowRounds', 'flowRoundsHTML'].map(fn).join('\n') + '\nlet flowOlderOpen = false;';

function harness(job, version = null) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', querySelectorAll: () => [] });
    return nodes.get(id);
  };
  const context = vm.createContext({
    state: { jobs: [job], agents: [{ id: 'builder', label: 'Builder', enabled: true }], roster: { builders: ['builder'] } },
    selected: job.id, planView: { job: job.id, version }, filter: null, names: {},
    $: get, document: { querySelectorAll: () => [] },
    t: key => key, runningOf: job => job?.running || [], nodeOfRun: run => run.stage,
    agentHealth: () => null, tierLabel: tier => tier || '', rolesText: () => '',
    statusLabel: status => status, jobStatusLabel: job => job.status, cut: value => value || '', taskDetailHTML: () => '',
    svgText: ({ text, x, y, cls }) => `<text x="${x}" y="${y}" class="${cls}">${text}</text>`,
  });
  vm.runInContext(source.match(/^const esc = .*;$/m)[0], context);
  vm.runInContext(helpers, context);
  vm.runInContext(flowSource, context);
  return { get, context, draw() { vm.runInContext('drawFlow()', context); return get('flow').innerHTML; } };
}

function nodeClass(html, title) {
  const node = [...html.matchAll(/<g class="([^"]*)"[^>]*><title>([^<]*)<\/title>/g)].find(([, , text]) => text === title);
  assert.ok(node, `Flow node exists: ${title}`);
  return node[1];
}

test('controller test stage lights the tests node and its used incoming edge without AI runs', () => {
  const html = harness({ id: 'job', status: 'running', stage: 'test', running: [], tasks: [{ agent: 'builder', done: true }] }).draw();
  assert.match(nodeClass(html, 'Tests'), /\bworking\b/);
  assert.match(html, /class="edge used active" d="M537 /);
  assert.doesNotMatch(nodeClass(html, 'ui.flow.approve'), /\bworking\b/);
});

test('ready job lights the approval node', () => {
  const html = harness({ id: 'job', status: 'ready', stage: 'final' }).draw();
  assert.match(nodeClass(html, 'ui.flow.approve'), /\bworking\b/);
  assert.doesNotMatch(nodeClass(html, 'Tests'), /\bworking\b/);
});

test('inactive jobs and historical plans keep controller nodes idle', () => {
  for (const status of ['queued', 'paused', 'merged']) {
    const html = harness({ id: 'job', status, stage: 'test' }).draw();
    assert.doesNotMatch(nodeClass(html, 'Tests'), /\bworking\b/);
    assert.doesNotMatch(nodeClass(html, 'ui.flow.approve'), /\bworking\b/);
  }
  for (const status of ['running', 'ready']) {
    const plans = [{ version: 1, tasks: [] }, { version: 2, tasks: [] }];
    const html = harness({ id: 'job', status, stage: 'test', plans }, 1).draw();
    assert.doesNotMatch(nodeClass(html, 'Tests'), /\bworking\b/);
    assert.doesNotMatch(nodeClass(html, 'ui.flow.approve'), /\bworking\b/);
  }
});

test('quota refresh calls the quota API without changing the notice', async () => {
  for (const response of [{ running: true, done: 0, total: 5 }, { running: false }]) {
    const { get, context } = harness({ id: 'job' });
    const calls = [];
    get('notice').textContent = 'Existing notice';
    context.attempt = fn => fn();
    context.api = async (path, body) => { calls.push({ path, body }); return response; };
    context.notice = text => { get('notice').textContent = text; };
    const handler = source.match(/^\$\('refresh-quota'\)\.onclick = .*;$/m);
    assert.ok(handler, 'Quota refresh handler exists');
    vm.runInContext(handler[0], context);
    await get('refresh-quota').onclick();
    assert.equal(JSON.stringify(calls), JSON.stringify([{ path: 'quota', body: {} }]));
    assert.equal(get('notice').textContent, 'Existing notice');
  }
});
