import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Team } from '../src/team.js';
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
  return { team, root, create, execute, runner };
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
  const names = ['flaky (a.b)? [x] + test', 'second flaky test'], sibling = join(root, 'sibling-count');
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
  assert.equal(saved.checkResults[1].command.filter(arg => arg.startsWith('--test-name-pattern=')).length, 2);
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

test('runTests does not retry more than twenty failures or a file-only failure', async t => {
  const { create, execute, runner } = await fixture(t), job = await create();
  const many = runner("const { test } = require('node:test'); for (let i = 0; i < 21; i++) test('failure ' + i, () => { throw new Error('failed'); });");
  assert.equal(await execute(job, [many]).result, false); assert.equal(job.checkResults.length, 1);
  const invalid = runner('this is invalid JavaScript;');
  assert.equal(await execute(job, [invalid]).result, false); assert.equal(job.checkResults.length, 2);
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
