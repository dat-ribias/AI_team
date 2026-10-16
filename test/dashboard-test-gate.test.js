import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function fragment(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Dashboard fragment exists: ${start}`);
  return source.slice(from, to);
}
const flakySource = fragment("  if (!$('recent-flaky'))", '\n  const resultJob');
const progressSource = fragment('  const progress = (() => {', '\n  const attachments');

function harness(state = {}) {
  const nodes = new Map();
  nodes.set('metrics', { insertAdjacentHTML(position, html) {
    assert.equal(position, 'afterend');
    assert.match(html, /id="recent-flaky"/);
    nodes.set('recent-flaky', { innerHTML: '' });
  } });
  const context = vm.createContext({
    state, $: id => nodes.get(id),
    t: (key, vars = {}) => key + (Object.keys(vars).length ? ': ' + Object.values(vars).join(' | ') : ''),
    clock: value => value, duration: value => value,
    runningOf: job => job.running || [], jobEta: () => '', names: {},
  });
  vm.runInContext(source.match(/^const esc = .*;$/m)[0], context);
  return {
    flaky() {
      vm.runInContext(flakySource, context);
      return nodes.get('recent-flaky').innerHTML;
    },
    progress(job) {
      context.job = job;
      return vm.runInContext(`(() => { ${progressSource}\n return progress; })()`, context);
    },
  };
}

test('flaky list shows its empty state for missing or empty data', () => {
  for (const state of [{}, { flaky: [] }]) {
    const ui = harness(state);
    assert.match(ui.flaky(), /ui\.flaky\.title/);
    assert.match(ui.flaky(), /ui\.flaky\.empty/);
    assert.equal((ui.flaky().match(/id="recent-flaky-title"/g) || []).length, 1);
  }
});

test('flaky list renders test, job and timestamp and escapes test and job names', () => {
  const html = harness({ flaky: [{ test: '<script>"test" & \'x\'</script>', job: '<img src=x onerror="job">', at: '2026-10-15T07:00:00Z' }] }).flaky();
  assert.match(html, /ui\.flaky\.item/);
  assert.match(html, /&lt;script&gt;&quot;test&quot; &amp; &#39;x&#39;&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;job&quot;&gt;/);
  assert.match(html, /2026-10-15T07:00:00Z/);
  assert.doesNotMatch(html, /<script>|<img|ui\.flaky\.empty/);
});

test('flaky list displays only the first ten records in input order', () => {
  const flaky = Array.from({ length: 12 }, (_, i) => ({ test: `TEST_${i}_END`, job: `job-${i}`, at: 'now' }));
  const html = harness({ flaky }).flaky();
  assert.equal((html.match(/ui\.flaky\.item/g) || []).length, 10);
  for (let i = 0; i < 10; i++) {
    assert.ok(html.includes(`TEST_${i}_END`));
    if (i) assert.ok(html.indexOf(`TEST_${i - 1}_END`) < html.indexOf(`TEST_${i}_END`));
  }
  assert.doesNotMatch(html, /TEST_10_END|TEST_11_END/);
});

test('test stage progress shows and escapes queue position before resource waiting reason', () => {
  const ui = harness({ resources: { waitingReason: 'RESOURCE_WAIT' } });
  for (const status of ['running', 'queued']) {
    const html = ui.progress({ status, stage: 'test', tasks: [], waiting: 'chờ lượt test #3 <job>', running: [] });
    assert.match(html, /chờ lượt test #3 &lt;job&gt;/);
    assert.doesNotMatch(html, /RESOURCE_WAIT|<job>/);
  }
  assert.match(ui.progress({ status: 'running', stage: 'test', tasks: [] }), /RESOURCE_WAIT/);
  assert.equal(ui.progress({ status: 'ready', stage: 'test', tasks: [], waiting: 'chờ lượt test #3' }), '');
});

test('example config parses and setup configuration includes the same test concurrency default', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../team.config.example.json', import.meta.url), 'utf8'));
  assert.equal(config.maxConcurrentTests, 1);
  const setup = fs.readFileSync(new URL('../src/setup.js', import.meta.url), 'utf8');
  const object = setup.match(/writeFileSync\(configFile, JSON\.stringify\((\{[^\n]+\}), null, 2\)\);/);
  assert.ok(object, 'Setup writes its initial configuration object');
  // Evaluate only the object literal: never import or execute setup and its filesystem side effects.
  for (const demo of [false, true]) {
    const generated = vm.runInNewContext(`(${object[1]})`, { demo, root: 'example', join: (...parts) => parts.join('/'), agents: [], projects: [] });
    assert.equal(generated.maxConcurrentTests, config.maxConcurrentTests);
  }
});
