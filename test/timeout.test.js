import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/process.js';

test('silent process is killed by the idle timeout', async () => {
  await assert.rejects(run([process.execPath, '-e', 'setInterval(() => {}, 1000)'], [], {
    idleTimeoutMs: 500, timeoutMs: 5000,
  }), error => error.timeout === 'idle' && error.message === `Agent silent for ${500 / 60_000} min`);
});

test('regular stdout keeps a process alive for four idle periods', async () => {
  const result = await run([process.execPath, '-e', `
    const timer = setInterval(() => process.stdout.write('activity\\n'), 100);
    setTimeout(() => clearInterval(timer), 2000);
  `], [], { idleTimeoutMs: 500, timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.ok(result.stdout.split('\n').filter(Boolean).length >= 15);
});

test('stderr chunks without newlines reset the idle timeout', async () => {
  const result = await run([process.execPath, '-e', `
    const timer = setInterval(() => process.stderr.write('.'), 100);
    setTimeout(() => clearInterval(timer), 2000);
  `], [], { idleTimeoutMs: 500, timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.ok(result.stderr.length >= 15);
});

test('maximum timeout kills a process even with regular output', async () => {
  let lines = 0;
  await assert.rejects(run([process.execPath, '-e', `
    setInterval(() => console.log('activity'), 100);
  `], [], { idleTimeoutMs: 500, timeoutMs: 1200, onLine: () => lines++ }), error => error.timeout === 'max');
  assert.ok(lines >= 5);
});

test('run without timeout options permits a silent process', async () => {
  const result = await run([process.execPath, '-e', 'setTimeout(() => {}, 1000)']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
