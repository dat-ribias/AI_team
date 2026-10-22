import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const fn = name => { const i = source.indexOf(`function ${name}(`); return source.slice(i, source.indexOf('\n}', i) + 2); };
const boardSource = source.slice(source.indexOf('let jobsSearchQuery'), source.indexOf('\n}', source.indexOf('function jobCardHTML(')) + 2);

function harness(jobs, view = 'board') {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', value: '', checked: false, open: true, classList: { toggle() {} }, querySelectorAll: () => [] }); return nodes.get(id); };
  const context = vm.createContext({ state: { jobs, projects: [{ id: 'p' }], sessions: [], limits: { rounds: 3 } }, selected: null, names: {}, $: get,
    document: { querySelectorAll: () => [] }, t: (k, v = {}) => k + (Object.keys(v).length ? JSON.stringify(v) : ''), store: { get: () => view },
    runningOf: j => j.running || [], statusLabel: x => x, jobTitle: j => j.title || j.id, cut: v => String(v || ''), clock: () => 'now',
    deletable: j => !['running', 'queued'].includes(j.status), hueClass: () => 'hue-1', jobWorker: j => (j.running || []).map(r => r.agent).join(', ') });
  vm.runInContext(source.match(/^const esc = .*;$/m)[0], context);
  vm.runInContext(fn('gitOf') + '\n' + fn('drawJobsDialog') + '\n' + boardSource, context);
  return { context, get, lane: j => vm.runInContext(`jobLane(${JSON.stringify(j)})`, context), draw() { vm.runInContext('drawJobsDialog()', context); return get('jobs-dialog-list').innerHTML; } };
}
const job = (o) => ({ id: 'j' + Math.random().toString(16).slice(2, 10), project: 'p', tasks: [], round: 0, ...o });

test('jobLane puts every status in exactly one column with the reason and the owner action', () => {
  const { lane } = harness([]);
  const cases = [
    [{ status: 'waiting', planGate: { version: 2 } }, 'needs', 'plan'],
    [{ status: 'waiting', questions: ['?'] }, 'needs', 'answer'],
    [{ status: 'ready' }, 'needs', 'merge'],
    [{ status: 'ready', mergeFailure: { kind: 'conflict' } }, 'needs', 'error'],
    [{ status: 'blocked', error: 'x' }, 'needs', 'error'],
    [{ status: 'ready', mergeQueue: { position: 2 } }, 'needs', undefined],
    [{ status: 'running', round: 0, running: [{ agent: 'a', stage: 'implement' }] }, 'active', undefined],
    [{ status: 'waiting', peerWait: { to: 'a' } }, 'active', undefined],
    [{ status: 'running', round: 2 }, 'active', undefined], // đang chạy vòng sửa: vẫn là Đang làm (khớp thanh bên), lý do ghi vòng sửa
    [{ status: 'paused', round: 1 }, 'returned', undefined],
    [{ status: 'queued', round: 1 }, 'returned', undefined],
    [{ status: 'queued' }, 'waiting', undefined],
    [{ status: 'paused' }, 'waiting', undefined],
    [{ status: 'waiting', blockedReason: { kind: 'depends', ids: ['abc'] } }, 'waiting', undefined],
    [{ status: 'merged' }, 'done', undefined], [{ status: 'done', kind: 'research' }, 'done', undefined], [{ status: 'cancelled' }, 'done', undefined],
  ];
  for (const [j, l, action] of cases) { const r = lane(job(j)); assert.equal(r.lane, l, JSON.stringify(j)); assert.equal(r.action ?? undefined, action, JSON.stringify(j)); assert(r.reason); }
  assert.match(lane(job({ status: 'running', round: 2 })).reason, /ui\.board\.reason\.round/);
});

test('board renders the five columns with counts, collapses Done and supports the needs-me filter', () => {
  const jobs = [job({ status: 'waiting', planGate: { version: 1 }, title: '<b>x</b>' }), job({ status: 'running', running: [{ agent: 'a' }] }), ...Array.from({ length: 10 }, () => job({ status: 'merged' }))];
  const h = harness(jobs), html = h.draw();
  for (const l of ['needs', 'active', 'waiting', 'returned', 'done']) assert.match(html, new RegExp(`board-col lane-${l}`));
  assert.equal((html.match(/data-job-select=/g) || []).length, 2 + 8, 'Done shows the latest 8');
  assert.match(html, /ui\.board\.more\{&quot;n&quot;:2\}/); assert.match(html, /ui\.board\.action\.plan/);
  assert(!html.includes('<b>x</b>'), 'titles are escaped'); assert.doesNotMatch(html, /\sstyle=/);
  vm.runInContext('jobsMine = true', h.context); const mine = h.draw();
  assert.equal((mine.match(/data-job-select=/g) || []).length, 1); assert.doesNotMatch(mine, /lane-done/);
});

test('list view groups by the same columns', () => {
  const html = harness([job({ status: 'queued' }), job({ status: 'blocked', error: 'e' })], 'list').draw();
  assert.match(html, /<details class="jobs-group lane-needs" open>/); assert.match(html, /jobs-group lane-waiting/); assert.doesNotMatch(html, /jobs-board/);
});
