import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.ACTIVITY_UI_SOURCE || new URL('../public/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', querySelector(selector) { return selector === '.live-log' && this.innerHTML.includes('class="live-log"') ? { scrollIntoView() {}, scrollHeight: 100 } : null; }, querySelectorAll: () => [], showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  const context = vm.createContext({ document: { getElementById: get, addEventListener: (_type, fn) => { context.click = fn; }, querySelectorAll: () => [] }, Date, Map, Set });
  const key = source.match(/^const activityRunKey = .*;$/m)?.[0] || '';
  const handler = source.slice(source.lastIndexOf("document.addEventListener('click', e => {"), source.indexOf('\n});', source.lastIndexOf("document.addEventListener('click', e => {")) + 4);
  vm.runInContext(`
    const $ = id => document.getElementById(id);
    const esc = value => String(value ?? '').replace(/"/g, '&quot;');
    const t = (key, vars) => key + JSON.stringify(vars || {});
    const duration = value => value;
    const cut = value => value;
    const activityInfo = () => ({ warn: true, text: 'silent' });
    const runningOf = job => job?.running || [];
    const nodeOfRun = run => run.stage;
    const roleLabel = kind => kind;
    const slotMember = () => {};
    const actView = e => e.summary;
    const drawState = () => {};
    const drawTimeline = () => {};
    let state, selected, events, filter, tab, slot = null;
    ${key}
    ${['activityHTML', 'slotLive', 'refreshSlotLive', 'openSlot'].map(functionSource).join('\n')}
    ${handler}
  `, context);
  vm.runInContext(`
    state = { agents: [], jobs: [{ id: 'job', status: 'running', running: [
      { agent: 'same', task: 0, stage: 'implement', startedAt: '2026-10-14T00:00:00Z' },
      { agent: 'same', task: 1, stage: 'review', startedAt: '2026-10-14T00:01:00Z' }
    ] }] };
    selected = 'job';
    events = [
      { from: 'same', type: 'ACTIVITY', seq: 1, summary: 'FIRST_LOG', details: { task: 0, stage: 'implement', startedAt: '2026-10-14T00:00:00Z' } },
      { from: 'same', type: 'ACTIVITY', seq: 2, summary: 'SECOND_LOG', details: { task: 1, stage: 'review', startedAt: '2026-10-14T00:01:00Z' } },
      { from: 'same', type: 'ACTIVITY', seq: 3, summary: 'AMBIGUOUS_LOG', details: {} }
    ];
  `, context);
  const clickRow = index => {
    const html = vm.runInContext(`activityHTML(state.jobs[0].running[${index}], state.jobs[0])`, context);
    const dataset = Object.fromEntries([...html.matchAll(/data-activity-(check|job)="([^"]*)"/g)].map(([, key, value]) => ['activity' + key[0].toUpperCase() + key.slice(1), value.replace(/&quot;/g, '"')]));
    const button = { dataset };
    context.click({ target: { closest: selector => selector === '[data-activity-check]' ? button : null } });
  };
  return { context, get, clickRow };
}

test('second silence warning selects its task and log, including an already open agent slot', () => {
  const { context, get, clickRow } = harness();
  clickRow(0);
  clickRow(1);
  assert.equal(vm.runInContext('slot.task', context), 1);
  assert.match(get('slot-live').innerHTML, /SECOND_LOG/);
  assert.doesNotMatch(get('slot-live').innerHTML, /FIRST_LOG|AMBIGUOUS_LOG/);
  vm.runInContext("selected = 'other'; refreshSlotLive()", context);
  assert.equal(vm.runInContext('slot.task', context), 1);
  assert.match(get('slot-live').innerHTML, /SECOND_LOG/);
  assert.match(get('slot-live').innerHTML, /review/);
});

test('task slots without attributable activity stay open instead of showing another task timeline', () => {
  const { context, get, clickRow } = harness();
  vm.runInContext('events = events.filter(e => e.details.task == null)', context);
  clickRow(1);
  assert.equal(vm.runInContext('slot.task', context), 1);
  assert.equal(get('slot-dialog').open, true);
  assert.doesNotMatch(get('slot-live').innerHTML, /AMBIGUOUS_LOG/);
});
