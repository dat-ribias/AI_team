import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const fn = name => { const i = source.indexOf(`function ${name}(`); return source.slice(i, source.indexOf('\n}', i) + 2); };
const line = start => source.split('\n').find(l => l.startsWith(start));

test('evidence: only the current commit is shown as latest, duplicates collapse, older commits are folded', () => {
  const context = vm.createContext({ names: {}, clock: x => String(x).slice(11, 16), t: (k, v = {}) => k + (Object.keys(v).length ? JSON.stringify(v) : '') });
  vm.runInContext([source.match(/^const esc = .*;$/m)[0], line('const evidenceURL'), line('const evidenceLink'), ...['controllerTestHTML', 'aiCheckHTML', 'evidencePanelHTML'].map(fn)].join('\n'), context);
  const img = path => ({ path, type: 'image', bytes: 3 });
  const groups = [
    { revision: 'r2', at: 2, checks: [{ command: ['npm', 'test'], code: 1, at: '2026-10-21T08:00:00Z' }, { command: ['npm', 'test'], code: 0, at: '2026-10-21T08:10:00Z' }],
      reports: [{ stage: 'review', agent: 'rev', verdict: 'changes_requested' }, { stage: 'review', agent: 'rev', verdict: 'approved' }],
      items: [{ stage: 'implement', agent: 'b1', at: '2026-10-21T08:00:00Z', dir: 'r2/a', files: [img('home.png'), img('old-only.png')] }, { stage: 'verify', agent: 'v', at: '2026-10-21T08:20:00Z', dir: 'r2/b', files: [img('home.png')] }] },
    { revision: 'r1', at: 1, checks: [], reports: [], items: [{ stage: 'implement', agent: 'b1', at: '2026-10-21T07:00:00Z', dir: 'r1/a', files: [img('home.png')] }] },
  ];
  const html = vm.runInContext('evidencePanelHTML', context)('j', { revision: 'r2' }, groups);
  const [current, older] = html.split('<details class="evidence-older">');
  assert.match(current, /evidence-current"><h3><span class="tag evidence-latest">ui\.evidence\.latest<\/span>/);
  assert.equal((current.match(/alt="home\.png"/g) || []).length, 1, 'same-name image from the earlier run of this commit is hidden');
  assert.match(current, /r2%2Fb%2Fhome\.png/, 'the newest copy is the one kept'); assert.match(current, /old-only\.png/);
  assert.match(current, /ui\.evidence\.hiddenDuplicates\{&quot;n&quot;:1\}/);
  assert.equal((current.match(/npm test/g) || []).length, 1, 'only the last run of each test command'); assert.match(current, /evidence-pass/);
  assert.match(current, /approved/); assert.doesNotMatch(current, /changes_requested/, 'only the latest review');
  assert.match(older, /^<summary>ui\.evidence\.older\{&quot;n&quot;:1\}<\/summary>/); assert.match(older, /r1%2Fa%2Fhome\.png/);
  const none = vm.runInContext('evidencePanelHTML', context)('j', { revision: 'r3' }, groups);
  assert.match(none, /^<p class="error-box">ui\.evidence\.noCurrent\{&quot;revision&quot;:&quot;r3&quot;\}/);
});
