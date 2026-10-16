import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('  const reworkOpen ='), source.indexOf('  const openTasks ='));
const bindingStart = source.indexOf("  $('inspector').querySelectorAll('[data-rework-extra], [data-rework-handoff]')");
const bindings = source.slice(bindingStart, source.indexOf("  $('reassign').onchange", bindingStart));

function harness(open = false, status = 'blocked', handoff = false) {
  const buttons = ['data-rework-extra', 'data-rework-handoff'].map(attribute => ({
    disabled: false, hasAttribute: name => name === attribute
  }));
  const calls = [];
  let refreshes = 0;
  const context = vm.createContext({
    job: {
      id: 'mixed-digest', status, handoff,
      reworkDigest: {
        round: 2, scopeAdds: 1, open: ['F3', 'F4', 'F5'],
        rounds: [{ n: 2, agent: 'reviewer', stage: 'review', verdict: 'changes_requested', findings: [
          { id: 'F1', claim: 'Owner scope', origin: 'owner', open: false },
          { id: 'F2', claim: 'Builder defect', origin: 'builder', open: false },
          { id: 'F3', claim: '<img src=x onerror="alert(1)"> & unsafe', origin: 'unknown', open: true },
          { id: 'F4', claim: 'Missing origin', open: true },
          { id: 'F5', claim: 'Unexpected origin', origin: 'reviewer', open: true }
        ] }]
      }
    },
    names: { reviewer: 'Reviewer' },
    $: () => ({ querySelector: () => ({ open }), querySelectorAll: () => buttons }),
    t: (key, vars) => key + (vars ? JSON.stringify(vars) : ''),
    attempt: fn => fn(),
    api: async (path, payload) => { calls.push({ path, ...payload }); },
    refresh: async () => { refreshes++; }
  });
  vm.runInContext(`${source.match(/^const esc = .*;$/m)[0]}\n${renderer}\n${bindings}`, context);
  return { html: vm.runInContext('rework', context), buttons, calls, refreshes: () => refreshes };
}

test('digest labels only explicit owner and builder origins and escapes findings', () => {
  const { html } = harness();
  const rows = [...html.matchAll(/<li><b>(F\d)<\/b>(.*?)<\/li>/g)];
  assert.equal(rows.length, 5);
  const labels = ['owner', 'builder', 'unknown', 'unknown', 'unknown'];
  rows.forEach(([, id, row], index) => {
    assert.match(row, new RegExp(`ui\\.rework\\.${labels[index]}<`), id);
    assert.equal(row.includes('ui.rework.open'), index >= 2, id);
  });
  assert.match(rows[2][2], /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; unsafe/);
  assert.doesNotMatch(html, /<img|style\s*=/i);
  assert.match(html, /Reviewer/);
  assert.match(html, /changes_requested/);
  assert.match(html, /<summary>ui.rework.title/);
  assert.match(html, /&quot;rounds&quot;:2,&quot;open&quot;:3,&quot;scope&quot;:1/);
});

test('digest starts collapsed and preserves expanded state on redraw', () => {
  assert.doesNotMatch(harness().html, /data-rework-digest open/);
  assert.match(harness(true).html, /data-rework-digest open/);
});

test('digest buttons send extra-round resume and handoff pause for this job', async () => {
  for (const status of ['blocked', 'waiting']) {
    const h = harness(false, status);
    assert.match(h.html, /data-rework-extra>ui.rework.extraRound/);
    assert.match(h.html, /data-rework-handoff>ui.rework.handoff/);
    await h.buttons[0].onclick();
    await h.buttons[1].onclick();
    assert.deepEqual(h.calls, [
      { path: 'jobs/mixed-digest/control', action: 'resume', extraRound: true },
      { path: 'jobs/mixed-digest/control', action: 'pause', handoff: true }
    ]);
    assert.equal(h.refreshes(), 2);
    assert.ok(h.buttons.every(button => !button.disabled));
  }
});

test('digest replaces controls with handoff notice after owner takes over', () => {
  const { html } = harness(false, 'paused', true);
  assert.match(html, /ui.rework.handedOff/);
  assert.doesNotMatch(html, /data-rework-extra|data-rework-handoff/);
});
