import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Team, validateConfig } from '../src/team.js';
import { run } from '../src/process.js';

async function fixture(t, maxConcurrentTests = 1) {
  const evidence = resolve('.ai-team/evidence'); mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, 'test-gate-tmp-')), path = join(root, 'repo'), data = join(root, 'data'), pending = [];
  // Nested node --test processes must run independently of this test runner.
  const context = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  let team;
  t.after(async () => {
    for (const runtime of team?.runs.values() || []) runtime.abort.abort();
    await Promise.allSettled(pending);
    if (team) await team.close();
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
    assert(resolve(root).startsWith(evidence + sep) && root.includes('test-gate-tmp-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  mkdirSync(path); mkdirSync(data);
  await run(['git'], ['init', '-b', 'main', path], { timeoutMs: 10000 });
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n', 'utf8');
  await run(['git'], ['-C', path, 'add', '.'], { timeoutMs: 10000 });
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial'], { timeoutMs: 10000 });
  const config = { demo: true, planApproval: false, maxConcurrentTests, maxRamPercent: 100, maxCpuPercent: 100,
    agents: ['manager', 'builder', 'reviewer', 'verifier'].map(id => ({ id, label: id, provider: 'mock' })),
    pipeline: { manager: 'manager', builders: ['builder'], reviewer: 'reviewer', verifier: 'verifier' },
    projects: [{ id: 'test', path, tests: [] }],
  };
  team = new Team(config, data); team.closed = true;
  const create = () => team.create({ project: 'test', goal: 'Test controller gate', paused: true });
  const execute = (job, commands) => {
    const abort = new AbortController();
    team.runs.set(job.id, { job: job.id, agents: new Set(), abort });
    const result = team.runTests(job, job.worktree, job.revision, commands).finally(() => team.runs.delete(job.id));
    pending.push(result); return { result, abort };
  };
  const runner = (source, reporter = 'tap') => {
    const file = join(root, 'controller.test.cjs'); writeFileSync(file, source, 'utf8');
    const command = [process.execPath, '--test', '--test-timeout=10000', `--test-reporter=${reporter}`, file];
    config.projects[0].tests = [command]; return command;
  };
  return { team, root, create, execute, runner, pending };
}

test('runTests serializes controllers and saves the waiting position without holding an agent', async t => {
  const { team, root, create, execute } = await fixture(t), first = await create(), second = await create();
  const command = file => [process.execPath, '-e', `const fs = require('node:fs'); const start = Date.now(); setTimeout(() => fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify([start, Date.now()])), 300)`];
  const a = join(root, 'first.json'), b = join(root, 'second.json');
  const one = execute(first, [command(a)]), two = execute(second, [command(b)]);
  assert.match(second.waiting, /#1/); assert.match(team.get(second.id).waiting, /#1/);
  assert.equal(team.busyAgents().size, 0);
  assert.deepEqual(await Promise.all([one.result, two.result]), [true, true]);
  const [startA, endA] = JSON.parse(readFileSync(a, 'utf8')), [startB, endB] = JSON.parse(readFileSync(b, 'utf8'));
  assert(endA <= startB || endB <= startA);
  assert.equal(second.waiting, null); assert.equal(team.get(second.id).waiting, null); assert.equal(team.activeTests, 0);
});

test('runTests removes aborted waiters, updates FIFO positions and retains the active slot', async t => {
  const { team, create, execute } = await fixture(t), jobs = await Promise.all([create(), create(), create()]);
  const one = execute(jobs[0], [[process.execPath, '-e', 'setTimeout(() => {}, 300)']]);
  const two = execute(jobs[1], [[process.execPath, '-e', 'process.exit(99)']]);
  const three = execute(jobs[2], [[process.execPath, '-e', 'console.log("third")']]);
  assert.match(jobs[1].waiting, /#1/); assert.match(jobs[2].waiting, /#2/);
  const reason = new Error('cancel queued test'), rejected = assert.rejects(two.result, error => error === reason);
  two.abort.abort(reason); await rejected;
  assert.equal(jobs[1].waiting, null); assert.match(jobs[2].waiting, /#1/); assert.equal(team.activeTests, 1);
  assert.deepEqual(await Promise.all([one.result, three.result]), [true, true]);
  assert.equal(jobs[1].checkResults?.length || 0, 0); assert.equal(team.activeTests, 0);
});

test('runTests releases its slot after a process error and clamps limits below one', async t => {
  const { team, root, create, execute } = await fixture(t, 0), first = await create(), second = await create();
  const one = execute(first, [[join(root, 'missing-node.exe')]]), rejected = assert.rejects(one.result, /ENOENT/);
  const two = execute(second, [[process.execPath, '-e', 'console.log("after error")']]);
  assert.match(second.waiting, /#1/); await rejected; assert(await two.result);
  assert.equal(team.activeTests, 0); assert.equal(team.state().resources.maxConcurrentTests, 1);
});

test('runTests permits the configured number of controllers and defaults to one', async t => {
  const { team, create, execute } = await fixture(t, 2), jobs = await Promise.all([create(), create(), create()]);
  const results = jobs.map(job => execute(job, [[process.execPath, '-e', 'setTimeout(() => {}, 100)']]).result);
  assert.equal(team.activeTests, 2); assert.equal(jobs[1].waiting, null); assert.match(jobs[2].waiting, /#1/);
  assert.deepEqual(await Promise.all(results), [true, true, true]);
  delete team.config.maxConcurrentTests;
  assert.equal(team.state().resources.maxConcurrentTests, 1);
});

for (const reporter of ['tap', 'spec']) test(`runTests retries only failed names once and avoids rework (${reporter})`, async t => {
  const { team, root, create, runner } = await fixture(t), job = await create();
  const names = ['flaky (a.b)? [x] + test', 'second flaky test', 'backslash \\ # hash {1,2}'], sibling = join(root, 'sibling-count');
  runner(`const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs');
    ${names.map((name, i) => `test(${JSON.stringify(name)}, () => { const marker = ${JSON.stringify(join(root, 'marker-' + i))}; if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); assert.fail('first attempt'); } });`).join('\n')}
    test('passing sibling', () => { const file = ${JSON.stringify(sibling)}; fs.writeFileSync(file, String(Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0) + 1)); });`, reporter);
  job.stage = 'test';
  team.gate = async () => ({});
  team.afterChecks = async current => { current.stage = 'review'; };
  await team.runJob(job);
  const saved = team.get(job.id), warnings = team.events(job.id).filter(event => event.type === 'FLAKY_WARNING');
  assert.equal(saved.stage, 'review'); assert.equal(saved.tested, job.revision);
  assert.equal(saved.reports.filter(report => report.stage === 'test').length, 0);
  assert.deepEqual(saved.checkResults.map(check => check.code), [1, 0]);
  assert.equal(warnings.length, 1); assert.deepEqual(warnings[0].details.names, names);
  assert.deepEqual(saved.flaky.map(item => item.test), names); assert.equal(readFileSync(sibling, 'utf8'), '1');
  assert.equal(saved.checkResults[1].command.filter(arg => arg.startsWith('--test-name-pattern=')).length, 1);
  for (const check of saved.checkResults) assert(readFileSync(team.evidenceFile(job.id, check.log).file, 'utf8').length > 0);
  assert.deepEqual(team.state().flaky.map(item => item.test).sort(), [...names].sort());
});

test('runTests retries a real failure once and the test stage still enters rework', async t => {
  const { team, create, runner } = await fixture(t), job = await create();
  runner("require('node:test').test('always fails', () => { require('node:assert/strict').fail('real regression'); });");
  job.stage = 'test'; await team.runJob(job);
  const saved = team.get(job.id);
  assert.equal(saved.stage, 'rework'); assert.deepEqual(saved.checkResults.map(check => check.code), [1, 1]);
  assert.equal(saved.reports.filter(report => report.stage === 'test').length, 1);
  assert.equal(team.events(job.id).filter(event => event.type === 'FLAKY_WARNING').length, 0);
});

test('runTests does not retry a failing command without node --test', async t => {
  const { team, root, create, execute } = await fixture(t), job = await create(), count = join(root, 'count');
  const command = [process.execPath, '-e', `const fs = require('node:fs'), file = ${JSON.stringify(count)}; fs.appendFileSync(file, 'run\\n'); console.log('not ok 1 - fake test'); process.exit(1)`];
  assert.equal(await execute(job, [command]).result, false);
  assert.equal(job.checkResults.length, 1); assert.equal(job.reports.at(-1).stage, 'test');
  assert.equal(readFileSync(count, 'utf8'), 'run\n'); assert.equal(team.activeTests, 0);
});

test('runTests rejects an exit-zero retry when its pattern matches no tests', async t => {
  const { create, execute, root, runner } = await fixture(t), job = await create(), marker = join(root, 'name-marker');
  const command = runner(`const fs = require('node:fs'), marker = ${JSON.stringify(marker)}, first = !fs.existsSync(marker); fs.writeFileSync(marker, '1');
    require('node:test').test(first ? 'original name' : 'changed name', () => { if (first) require('node:assert/strict').fail('first attempt'); });`);
  assert.equal(await execute(job, [command]).result, false, JSON.stringify(job.checkResults));
  assert.deepEqual(job.checkResults.map(check => check.code), [1, 0]);
  assert.equal(job.reports.at(-1).stage, 'test'); assert(!job.flaky);
});

test('runTests retries more than twenty failures with one union and rejects file-only failures', async t => {
  const { root, create, execute, runner } = await fixture(t), job = await create();
  const many = runner(`const { test } = require('node:test'), fs = require('node:fs'), marker = ${JSON.stringify(join(root, 'many-marker'))};
    const first = !fs.existsSync(marker); fs.writeFileSync(marker, '1');
    for (let i = 0; i < 21; i++) test('failure ' + i, () => { if (first) throw new Error('failed'); });`);
  assert.equal(await execute(job, [many]).result, true); assert.equal(job.checkResults.length, 2); assert.equal(job.flaky.length, 21);
  assert.equal(job.checkResults[1].command.filter(arg => arg.startsWith('--test-name-pattern=')).length, 1);
  const invalid = runner('this is invalid JavaScript;');
  assert.equal(await execute(job, [invalid]).result, false); assert.equal(job.checkResults.length, 3);
});

test('waiting controllers free scheduler capacity and restore accounting on grant', async t => {
  const { team, create, execute, pending } = await fixture(t), jobs = await Promise.all([create(), create(), create()]);
  team.config.resources = { maxAgents: 2, reserveGB: 0, ramPerAgentGB: 0.001, hardStopRamPercent: 100 };
  team.sampleResources = () => ({ cpuPercent: 0 }); team.kick = () => {};
  const command = [process.execPath, '-e', 'setTimeout(() => {}, 700)'];
  const one = execute(jobs[0], [command]), two = execute(jobs[1], [command]);
  let firstFinished = false, agentStarted = false;
  one.result.then(() => { firstFinished = true; });
  assert.equal(team.runs.size, 2); assert.equal(team.state().resources.active, 1); assert.equal(team.capacity().start, 1);
  team.step = async job => {
    assert.equal(job.id, jobs[2].id); assert.equal(firstFinished, false);
    const runtime = team.runs.get(job.id); runtime.agents.add('builder'); agentStarted = true;
    assert(team.busyAgents().has('builder')); assert.equal(team.state().resources.active, 2);
    runtime.agents.clear(); job.status = 'paused';
  };
  jobs[2].status = 'queued'; team.save(jobs[2]); team.closed = false;
  const tick = team.tick(); pending.push(tick); await tick; team.closed = true;
  assert(agentStarted); await one.result;
  assert.equal(team.runs.get(jobs[1].id).waitingForTest, false);
  assert.equal(team.state().resources.active, 1); assert.equal(team.activeTests, 1); assert.equal(jobs[1].waiting, null);
  assert(await two.result); assert.equal(team.state().resources.active, 0); assert.equal(team.activeTests, 0);
});

for (const action of ['pause', 'cancel']) test(`${action} removes a test waiter without overwriting control state`, async t => {
  const { team, create, execute } = await fixture(t), first = await create(), second = await create();
  second.status = 'running'; team.save(second);
  const one = execute(first, [[process.execPath, '-e', 'setTimeout(() => {}, 400)']]);
  const two = execute(second, [[process.execPath, '-e', 'process.exit(99)']]);
  const rejected = assert.rejects(two.result, { name: 'AbortError' });
  const stopPreview = team.stopPreview.bind(team);
  team.stopPreview = async (id, reason) => {
    if (id === second.id && reason === 'cancelled') assert(two.abort.signal.aborted, 'cancel must remove the waiter before preview cleanup awaits');
    return stopPreview(id, reason);
  };
  await team.control(second.id, action); await rejected;
  assert.equal(team.get(second.id).status, action === 'pause' ? 'paused' : 'cancelled');
  assert.equal(team.get(second.id).waiting, null); assert.equal(team.testQueue.length, 0);
  assert.equal(team.activeTests, team.runs.has(first.id) ? 1 : 0);
  assert(await one.result); assert.equal(team.activeTests, 0);
});

test('close aborts active tests and all queued waiters without granting a cancelled slot', async t => {
  const { team, create, execute } = await fixture(t), jobs = await Promise.all([create(), create(), create()]);
  const results = jobs.map(job => execute(job, [[process.execPath, '-e', 'setTimeout(() => {}, 30000)']]).result);
  const settled = Promise.allSettled(results);
  await team.close();
  assert((await settled).every(result => result.status === 'rejected'));
  assert.equal(team.testQueue.length, 0); assert.equal(team.activeTests, 0); assert.equal(team.runs.size, 0);
});

test('maxConcurrentTests normalizes finite integers and invalid values without deadlocks', async t => {
  const { team } = await fixture(t);
  for (const [value, expected] of [[undefined, 1], [0, 1], [-2, 1], [2.9, 2], [NaN, 1], [Infinity, 1], [-Infinity, 1], ['2', 1], [null, 1]]) {
    assert.equal(validateConfig({ ...team.config, maxConcurrentTests: value }).maxConcurrentTests, expected);
    team.config.maxConcurrentTests = value;
    assert.equal(team.state().resources.maxConcurrentTests, expected);
  }
});

for (const reporter of ['tap', 'spec']) test(`nested suites and subtests retry full paths without running passing siblings (${reporter})`, async t => {
  const { team, root, create, runner, execute } = await fixture(t), job = await create(), sibling = join(root, 'nested-sibling');
  const command = runner(`const { test, describe, it } = require('node:test'); const fs = require('node:fs');
    const flaky = name => { const marker = ${JSON.stringify(root)} + '/' + name; if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); throw Error('first'); } };
    describe('suite (a.b)?', () => { describe('nested [x]+', () => {
      it('leaf ^$|test', () => flaky('suite-marker'));
      it('passing sibling', () => fs.appendFileSync(${JSON.stringify(sibling)}, 'x'));
    }); });
    test('parent', async t => { await t.test('child *?', () => flaky('parent-marker')); await t.test('sibling', () => fs.appendFileSync(${JSON.stringify(sibling)}, 'x')); });
    describe('other suite', () => { it('leaf ^$|test', () => fs.appendFileSync(${JSON.stringify(sibling)}, 'x')); });`, reporter);
  command.splice(2, 0, '--test-name-pattern', 'suite|parent|other', '--test-skip-pattern=never present');
  assert(await execute(job, [command]).result, JSON.stringify(job.checkResults));
  assert.deepEqual(job.flaky.map(item => item.test), ['suite (a.b)? nested [x]+ leaf ^$|test', 'parent child *?']);
  assert.equal(readFileSync(sibling, 'utf8'), 'xxx');
  const pattern = job.checkResults[1].command.find(arg => arg.startsWith('--test-name-pattern='));
  assert.match(pattern, /^--test-name-pattern=\^\(\?:/); assert.equal(team.activeTests, 0);
});

for (const mode of ['skip', 'todo', 'cancel', 'partial', 'crash', 'unknown', 'exit-zero-failure']) test(`retry never masks ${mode} results`, async t => {
  const { root, create, execute, runner } = await fixture(t), job = await create(), marker = join(root, 'retry-mode');
  const command = runner(`const { test } = require('node:test'); const fs = require('node:fs'); const marker = ${JSON.stringify(marker)}, first = !fs.existsSync(marker); fs.writeFileSync(marker, '1');
    test('failed test', ${mode === 'skip' || mode === 'todo' ? `{ ${mode}: !first },` : mode === 'cancel' ? '{ timeout: 50 },' : ''} async () => {
      if (first) throw Error('first failure');
      ${mode === 'cancel' ? 'await new Promise(() => {});' : ''}
      ${mode === 'crash' ? 'process.exit(2);' : ''}
    });
    ${mode === 'partial' ? "test(first ? 'second failure' : 'renamed', () => { if (first) throw Error('also fails'); });" : ''}
    ${mode === 'unknown' ? "if (!first) process.on('exit', () => { process.exitCode = 2; });" : ''}
    ${mode === 'exit-zero-failure' ? "if (!first) { test('failed test', () => { throw Error('same name still fails'); }); process.on('exit', () => { process.exitCode = 0; }); }" : ''}`);
  assert.equal(await execute(job, [command]).result, false, JSON.stringify(job.checkResults));
  assert.equal(job.checkResults.length, 2); assert(!job.flaky); assert.equal(job.reports.at(-1).stage, 'test');
});

test('file crashes alongside named failures are not retried', async t => {
  const { root, create, execute, runner } = await fixture(t), job = await create();
  const command = runner("require('node:test').test('named failure', () => { throw Error('failed'); });");
  const crashed = join(root, 'crashed.test.cjs'); writeFileSync(crashed, 'process.exit(2);', 'utf8'); command.push(crashed);
  assert.equal(await execute(job, [command]).result, false);
  assert.equal(job.checkResults.length, 1); assert(!job.flaky);
});

test('abort immediately after a FIFO grant releases exactly once', async t => {
  const { team, create, execute } = await fixture(t), job = await create();
  team.activeTests = 1;
  const queued = execute(job, [[process.execPath, '-e', 'process.exit(99)']]);
  const reason = new Error('abort at grant'), rejected = assert.rejects(queued.result, error => error === reason);
  team.releaseTest(); assert.equal(team.runs.get(job.id).waitingForTest, false);
  queued.abort.abort(reason); await rejected;
  assert.equal(team.activeTests, 0); assert.equal(team.testQueue.length, 0); assert.equal(team.state().resources.active, 0);
  assert.equal(job.waiting, null); assert.equal(team.get(job.id).waiting, null);
  assert.equal(job.checkResults?.length || 0, 0);
});

test('streamed spec results survive decimal/alternate durations and output beyond the process buffer', async t => {
  const { team, root, create, execute, runner } = await fixture(t), job = await create(), reporter = join(root, 'duration-reporter.cjs');
  writeFileSync(reporter, `const { Readable } = require('node:stream'), { spec } = require('node:test/reporters');
    module.exports = async function* (source) {
      let i = 0; const units = ['1.25s', '2.5µs', '0.2ns', '1.2m', '1h', '1.5ms'];
      for await (const chunk of Readable.from(source).compose(new spec())) yield String(chunk).replace(/\\([\\d.]+ms\\)/g, () => '(' + units[i++ % units.length] + ')');
      for (let n = 0; n < 550; n++) yield '.'.repeat(4096) + '\\n';
    };`, 'utf8');
  const command = runner(`const { test } = require('node:test'), fs = require('node:fs'), marker = ${JSON.stringify(join(root, 'duration-marker'))};
    const first = !fs.existsSync(marker); fs.writeFileSync(marker, '1');
    for (let i = 0; i < 6; i++) test('duration ' + i, () => { if (first) throw Error('first'); });`, pathToFileURL(reporter).href);
  assert(await execute(job, [command]).result, JSON.stringify(job.checkResults));
  assert.equal(job.flaky.length, 6); assert.deepEqual(job.checkResults.map(check => check.code), [1, 0]);
  for (const check of job.checkResults) {
    const log = readFileSync(team.evidenceFile(job.id, check.log).file, 'utf8');
    assert(log.length > 2_000_000); assert.match(log, /ℹ pass \d+/);
  }
});

test('oversized retry patterns fail closed without an arbitrary test-count limit', async t => {
  const { create, execute, runner } = await fixture(t), job = await create();
  const command = runner("require('node:test').test('long name '.repeat(3000), () => { throw Error('failed'); });");
  assert.equal(await execute(job, [command]).result, false); assert.equal(job.checkResults.length, 1); assert(!job.flaky);
});

test('ambiguous duplicate names and unrecognized spec failures cannot become flaky', async t => {
  const { root, create, execute, runner } = await fixture(t), job = await create();
  const command = runner("require('node:test').test('duplicate', () => { throw Error('failed'); });");
  const other = join(root, 'duplicate.test.cjs'); writeFileSync(other, "require('node:test').test('duplicate', () => {});", 'utf8'); command.push(other);
  assert.equal(await execute(job, [command]).result, false); assert.equal(job.checkResults.length, 1); assert(!job.flaky);
  const unknown = runner("console.log('✖ unknown result without duration'); require('node:test').test('named', () => { throw Error('failed'); });", 'spec');
  assert.equal(await execute(job, [unknown]).result, false); assert.equal(job.checkResults.length, 2); assert(!job.flaky);
});

test('state exposes the newest fifty flaky tests with job titles', async t => {
  const { team, create } = await fixture(t), job = await create();
  job.flaky = Array.from({ length: 55 }, (_, i) => ({ test: `test ${i}`, revision: job.revision, at: new Date(1700000000000 + i * 1000).toISOString() }));
  team.save(job);
  const { flaky, resources } = team.state();
  assert.equal(flaky.length, 50); assert.equal(flaky[0].test, 'test 54'); assert.equal(flaky.at(-1).test, 'test 5');
  assert.deepEqual(Object.keys(flaky[0]).sort(), ['at', 'job', 'revision', 'test', 'title']);
  assert.equal(flaky[0].job, job.id); assert.equal(flaky[0].title, job.title); assert.equal(resources.maxConcurrentTests, 1);
});
