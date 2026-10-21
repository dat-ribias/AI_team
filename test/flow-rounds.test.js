import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const fn = name => { const i = source.indexOf(`function ${name}(`); return source.slice(i, source.indexOf('\n}', i) + 2); };

function harness(job, agents = ['lead', 'b1', 'b2', 'rev', 'ver']) {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', querySelectorAll: () => [] }); return nodes.get(id); };
  const context = vm.createContext({
    state: { jobs: [job], agents: agents.map(id => ({ id, label: id, enabled: true })), roster: { manager: 'lead', builders: ['b1', 'b2'], reviewer: 'rev', verifier: 'ver' } },
    selected: job.id, planView: { job: job.id, version: null }, filter: null, names: {},
    $: get, document: { querySelectorAll: () => [] },
    t: (key, vars = {}) => key + (Object.keys(vars).length ? JSON.stringify(vars) : ''), runningOf: j => j?.running || [], nodeOfRun: r => r.stage,
    agentHealth: () => null, tierLabel: x => x || '', rolesText: () => '', statusLabel: x => x, jobStatusLabel: j => j.status,
    cut: v => v || '', taskDetailHTML: () => '', svgText: ({ text }) => `<text>${text}</text>`,
  });
  vm.runInContext(source.match(/^const esc = .*;$/m)[0], context);
  vm.runInContext(['oracleFlowState', 'flowRounds', 'flowRoundsHTML', 'drawFlow'].map(fn).join('\n') + '\nlet flowOlderOpen = false;', context);
  return { context, draw() { vm.runInContext('drawFlow()', context); return get('flow').innerHTML; } };
}
const titles = html => [...html.matchAll(/<g class="[^"]*"[^>]*><title>([^<\n]*)/g)].map(m => m[1]);

test('flowRounds splits plans into past rounds with the cause of each return', () => {
  const plans = [
    { version: 1, reason: 'initial', summary: 'p1', tasks: [{ agent: 'b1' }, { agent: 'b1' }, { agent: 'b2' }] },
    { version: 2, reason: 'challenge', summary: 'p1b', tasks: [{ agent: 'b1' }] },
    { version: 3, reason: 'rework', trigger: 'F1, F2', summary: 'p2', tasks: [{ agent: 'b2' }] },
    { version: 4, reason: 'rework', trigger: 'test failed', summary: 'p3', tasks: [{ agent: 'b1' }] },
  ];
  const reports = [
    { stage: 'plan', summary: 'p1' }, { stage: 'implement', agent: 'b1' }, { stage: 'review', agent: 'rev', verdict: 'changes_requested', findings: [{}, {}] },
    { stage: 'plan', summary: 'p2' }, { stage: 'implement', agent: 'b2' }, { stage: 'test', summary: 'Test failed: npm test' },
    { stage: 'plan', summary: 'p3' },
  ];
  const { context } = harness({ id: 'j', plans, reports });
  const rounds = vm.runInContext('flowRounds(state.jobs[0])', context);
  assert.equal(rounds.length, 2, 'challenge plan does not open a round; the current round is drawn separately');
  assert.deepEqual(JSON.parse(JSON.stringify(rounds[0].builders)), [{ id: 'b1', tasks: [1, 2] }, { id: 'b2', tasks: [3] }]);
  assert.equal(rounds[0].cause, 'review'); assert.equal(rounds[0].review.ok, false); assert.equal(rounds[0].review.findings, 2); assert.equal(rounds[0].trigger, 'F1, F2');
  assert.equal(rounds[1].cause, 'test'); assert.equal(rounds[1].tests.ok, false); assert.equal(rounds[1].review, null);
  assert.equal(vm.runInContext('flowRounds({}).length', context), 0);
});

test('drawFlow shows only nodes used in the current round and stacks past rounds above it', () => {
  const job = { id: 'j', kind: 'code', status: 'running', stage: 'implement', tasks: [{ agent: 'b1' }], skipped: ['verify'],
    plans: [{ version: 1, reason: 'initial', summary: 'p1', tasks: [{ agent: 'b2' }] }, { version: 2, reason: 'feedback', trigger: 'please change', summary: 'p2', tasks: [{ agent: 'b1' }] }],
    reports: [{ stage: 'plan', summary: 'p1' }, { stage: 'plan', summary: 'p2' }] };
  const html = harness(job).draw(), names = titles(html);
  assert(names.some(x => x.startsWith('b1 ')), 'builder with a task is drawn');
  assert(!names.some(x => x.startsWith('b2 ')), 'builder without a task in this round is hidden');
  assert(!names.some(x => x.startsWith('ver ')), 'skipped verify is not drawn');
  assert(names.some(x => x.startsWith('Tests')) && names.some(x => x.startsWith('rev ')));
  assert(!html.includes('ui.oracle.title'), 'ChatGPT web node only when it was asked');
  assert.match(html, /class="flow-round past"/); assert.match(html, /ui\.flow\.cause\.feedback/); assert.match(html, /please change/);
  assert.match(html, /ui\.flow\.skippedSteps/);
  assert.doesNotMatch(html, /\sstyle=/);
});

test('research rounds have no Tests node and end with a conclusion', () => {
  const html = harness({ id: 'j', kind: 'research', status: 'running', stage: 'research', tasks: [{ agent: 'b2' }], oracle: { turns: [{ role: 'lead', by: 'lead', a: 'ok' }] } }).draw(), names = titles(html);
  assert(!names.some(x => x.startsWith('Tests')));
  assert(names.includes('ui.flow.conclusion')); assert(html.includes('ui.oracle.title'));
});
