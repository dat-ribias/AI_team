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
  vm.runInContext(['oracleFlowState', 'flowRounds', 'flowRoundsHTML', 'frDetailHTML', 'drawFlow'].map(fn).join('\n') + '\nlet frOpen = null;', context);
  return { context, draw() { vm.runInContext('drawFlow()', context); return get('flow').innerHTML; } };
}
const titles = html => [...html.slice(html.indexOf('flow-now')).matchAll(/<g class="[^"]*"[^>]*><title>([^<\n]*)/g)].map(m => m[1]);

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
  const past = html.slice(html.indexOf('flow-past'), html.indexOf('flow-now'));
  assert.match(past, /class="fr-round past"/); assert.match(past, /ui\.flow\.cause\.feedback/); assert.match(past, /please change/);
  assert.match(past, /Builder · b2/, 'the past round is a full diagram with its own builders');
  assert.match(past, /class="edge fr-back" marker-end="url\(#fr-arrow\)" d="M\d/, 'the round links down to the next round');
  assert.match(html, /ui\.flow\.skippedSteps/);
  assert.doesNotMatch(html, /\sstyle=/);
});

test('research rounds have no Tests node and end with a conclusion', () => {
  const html = harness({ id: 'j', kind: 'research', status: 'running', stage: 'research', tasks: [{ agent: 'b2' }], oracle: { turns: [{ role: 'lead', by: 'lead', a: 'ok' }] } }).draw(), names = titles(html);
  assert(!names.some(x => x.startsWith('Tests')));
  assert(names.includes('ui.flow.conclusion')); assert(html.includes('ui.oracle.title'));
});

test('the failing step of a past round is marked and links to the next round with its findings', () => {
  const job = { id: 'j', kind: 'code', status: 'running', stage: 'implement', tasks: [{ agent: 'b1' }],
    plans: [{ version: 1, reason: 'initial', summary: 'p1', tasks: [{ agent: 'b1' }] }, { version: 2, reason: 'rework', trigger: 'F1, F2', summary: 'p2', tasks: [{ agent: 'b1' }] }, { version: 3, reason: 'rework', trigger: 'test failed', summary: 'p3', tasks: [{ agent: 'b1' }] }],
    reports: [{ stage: 'plan', summary: 'p1' }, { stage: 'test', summary: 'ok' }, { stage: 'review', agent: 'rev', verdict: 'changes_requested', summary: 'thiếu kiểm tra null', findings: [{ id: 'F1', claim: 'Team.call bỏ qua lỗi' }, 'F2 thiếu test'] },
      { stage: 'plan', summary: 'p2' }, { stage: 'test', summary: 'Test failed: npm test' }, { stage: 'plan', summary: 'p3' }] };
  const html = harness(job).draw(), past = html.slice(html.indexOf('flow-past'), html.indexOf('flow-now'));
  const rounds = past.split('class="fr-round past"').slice(1);
  assert.equal(rounds.length, 2);
  assert.match(rounds[0], /node fr-step failed[^>]*><title>Review · rev\nthiếu kiểm tra null\n• F1 Team.call bỏ qua lỗi\n• F2 thiếu test/);
  assert.match(rounds[0], /node fr-step done[^>]*><title>Tests/, 'passing steps are not marked');
  assert.match(rounds[1], /node fr-step failed[^>]*><title>Tests/);
  assert.equal((past.match(/fr-back/g) || []).length, 2, 'one return arrow per past round');
  // Mũi tên vòng cuối chạm đỉnh node Manager của vòng hiện tại (cùng SVG).
  const shift = Number(html.match(/class="flow-now" transform="translate\(0,([\d.]+)\)"/)[1]), managerTop = Number(html.slice(html.indexOf('flow-now')).match(/transform="translate\(140,([\d.]+)\)"/)[1]);
  const end = [...past.matchAll(/class="edge fr-back"[^>]* d="[^"]* ([\d.]+) ([\d.]+)"/g)].at(-1);
  assert.equal(Number(end[1]), 226); assert.equal(Number(end[2]), shift + managerTop);
});

test('clicking a past step opens its details: findings with evidence, test log, builder report, plan', () => {
  const job = { id: 'j', kind: 'code', status: 'running', stage: 'implement', tasks: [{ agent: 'b1' }],
    plans: [{ version: 1, reason: 'initial', summary: 'p1', tasks: [{ agent: 'b1', instruction: 'làm A' }] }, { version: 2, reason: 'rework', trigger: 'F1', summary: 'p2', tasks: [{ agent: 'b1' }] }],
    reports: [{ stage: 'plan', summary: 'p1' }, { stage: 'implement', agent: 'b1', summary: 'đã làm A' }, { stage: 'test', summary: 'ok' }, { stage: 'review', agent: 'rev', verdict: 'changes_requested', summary: 'thiếu', findings: [{ id: 'F1', impact: 'high', claim: 'Team.call nuốt lỗi', evidence: 'src/team.js:1346' }, 'F2 thiếu test'] }, { stage: 'plan', summary: 'p2' }] };
  const h = harness(job);
  assert.doesNotMatch(h.draw(), /fr-detail/);
  assert.match(h.draw(), /data-fr="0:review" role="button"/);
  for (const [key, expect] of [['0:review', /<b>F1<\/b> <span class="tag">high<\/span> Team.call nuốt lỗi<div class="muted">src\/team.js:1346<\/div>[\s\S]*F2 thiếu test/], ['0:b:b1', /đã làm A/], ['0:manager', /p1[\s\S]*b1: làm A/]]) {
    vm.runInContext(`frOpen = ${JSON.stringify(key)}`, h.context);
    const html = h.draw(); assert.match(html, /class="fr-detail"/); assert.match(html.slice(html.indexOf('fr-detail')), expect, key);
  }
});
