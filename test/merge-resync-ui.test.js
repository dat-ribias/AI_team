import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness(checks = {}, status = 'ready', others = []) {
  const nodes = new Map(), calls = [], notices = [];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', value: '', hidden: true, disabled: false, open: true, addEventListener() {}, close() { this.open = false; } });
    return nodes.get(id);
  };
  const response = { code: 'JOB', checks: { tested: true, reviewed: true, verified: true, baseUnchanged: true, ready: true, ...checks } };
  const state = { jobs: [{ id: 'job', baseBranch: 'master', status, stage: 'test' }, ...others] };
  const context = vm.createContext({
    document: { querySelector: () => ({ value: 'base' }) }, state, $: get,
    esc: value => String(value ?? '').replace(/"/g, '&quot;'),
    t: (key, vars) => key + JSON.stringify(vars || {}), names: {},
    notice: message => notices.push(message), attempt: fn => fn(),
    refresh: async () => {},
    api: async (path, body) => {
      calls.push({ path, body });
      if (path.includes('merge-check')) return response;
      if (context.failure) throw new Error(context.failure);
      if (path.endsWith('/control')) state.jobs[0].status = 'queued';
      return {};
    }
  });
  const start = source.indexOf("$('merge-go').onclick =");
  const handler = source.slice(start, source.indexOf('\n});', start) + 4);
  vm.runInContext(`let mergeJob = 'job', mergeCheck, mergeRequest = 0, mergeSending = false, resyncSending = false;
    ${functionSource('mergeTarget')}
    ${functionSource('updateMergeButton')}
    async ${functionSource('refreshMergeCheck')}
    ${handler}`, context);
  return { context, get, calls, notices, response, state, refresh: () => vm.runInContext('refreshMergeCheck()', context) };
}

test('changed base offers sync, queues test and closes the popup', async () => {
  const h = harness({ baseUnchanged: false });
  await h.refresh();
  assert.match(h.get('merge-check').innerHTML, /id="merge-resync"/);
  assert.match(h.get('merge-go').title, /blockedBase/);
  await h.get('merge-resync').onclick();
  assert.equal(h.calls.at(-1).path, 'jobs/job/control');
  assert.equal(h.calls.at(-1).body.action, 'sync');
  assert.equal(h.get('merge-dialog').open, false);
  assert.match(h.notices[0], /queued\/test/);
});

test('missing review offers review rather than sync', async () => {
  const h = harness({ reviewed: false });
  await h.refresh();
  await h.get('merge-resync').onclick();
  assert.equal(h.calls.at(-1).body.action, 'review');
});

test('all checks pass: no recovery button and test load only warns', async () => {
  const h = harness({}, 'ready', [1, 2].map(id => ({ id, status: 'running', stage: 'test' })));
  await h.refresh();
  assert.doesNotMatch(h.get('merge-check').innerHTML, /id="merge-resync"/);
  assert.match(h.get('merge-check').innerHTML, /merge-busy.*&quot;n&quot;:2/);
  assert.equal(h.get('merge-go').disabled, false);
});

for (const status of ['running', 'queued']) test(`${status} jobs cannot request recovery`, async () => {
  const h = harness({ baseUnchanged: false }, status);
  await h.refresh();
  assert.equal(h.get('merge-resync').disabled, true);
  await h.get('merge-resync').onclick();
  assert.equal(h.calls.length, 1);
});

test('merge API errors remain visible inside the popup', async () => {
  const h = harness();
  await h.refresh();
  h.context.failure = 'Merge rejected';
  await h.get('merge-go').onclick();
  assert.equal(h.get('merge-error').hidden, false);
  assert.equal(h.get('merge-error').textContent, 'Merge rejected');
  assert.equal(h.get('merge-dialog').open, true);
});

test('merge returning without starting shows an error; refresh clears it', async () => {
  const h = harness();
  await h.refresh();
  await h.get('merge-go').onclick();
  assert.equal(h.get('merge-error').hidden, false);
  assert.match(h.get('merge-error').textContent, /notStarted/);
  await h.refresh();
  assert.equal(h.get('merge-error').hidden, true);
  assert.equal(h.get('merge-error').textContent, '');
});

test('recovery locks while sending, rejects duplicate clicks, and unlocks on error', async () => {
  const h = harness({ baseUnchanged: false });
  await h.refresh();
  h.context.failure = 'Sync rejected';
  const pending = h.get('merge-resync').onclick();
  assert.equal(h.get('merge-resync').disabled, true);
  await h.get('merge-resync').onclick();
  await pending;
  assert.equal(h.calls.filter(c => c.path.endsWith('/control')).length, 1);
  assert.equal(h.get('merge-resync').disabled, false);
  assert.equal(h.get('merge-error').textContent, 'Sync rejected');
  assert.equal(h.get('merge-error').hidden, false);
});
