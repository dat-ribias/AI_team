import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { removeTempDir } from '../src/preview.js';

test('removeTempDir logs and returns false when EPERM persists', async () => {
  let attempts = 0;
  const logs = [];
  const removed = await removeTempDir('locked-profile', {
    async rm(dir, options) {
      attempts++;
      assert.equal(dir, 'locked-profile');
      assert.deepEqual(options, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    },
    delayMs: 1,
    log: line => logs.push(line),
  });
  assert.equal(removed, false);
  assert.equal(attempts, 21);
  assert.deepEqual(logs, ['[preview] could not remove temp dir locked-profile: EPERM']);
});

test('removeTempDir with retries=0 attempts and logs exactly once', async () => {
  let attempts = 0;
  const logs = [];
  const removed = await removeTempDir('locked-profile', {
    async rm() { attempts++; throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
    retries: 0,
    log: line => logs.push(line),
  });
  assert.equal(removed, false);
  assert.equal(attempts, 1);
  assert.deepEqual(logs, ['[preview] could not remove temp dir locked-profile: EPERM']);
});

test('removeTempDir returns false after exhausting EBUSY and ENOTEMPTY retries', async () => {
  for (const code of ['EBUSY', 'ENOTEMPTY']) {
    let attempts = 0;
    const logs = [];
    assert.equal(await removeTempDir('locked-profile', {
      async rm() { attempts++; throw Object.assign(new Error('locked'), { code }); },
      retries: 2,
      delayMs: 1,
      log: line => logs.push(line),
    }), false);
    assert.equal(attempts, 3);
    assert.deepEqual(logs, [`[preview] could not remove temp dir locked-profile: ${code}`]);
  }
});

test('removeTempDir retries transient filesystem locks', async () => {
  for (const code of ['EPERM', 'EBUSY', 'ENOTEMPTY']) {
    let attempts = 0;
    assert.equal(await removeTempDir('profile', {
      async rm() { if (++attempts <= 2) throw Object.assign(new Error('locked'), { code }); },
      delayMs: 1,
      log() { assert.fail('successful cleanup must not warn'); },
    }), true);
    assert.equal(attempts, 3);
  }
});

test('removeTempDir propagates unrelated filesystem errors', async () => {
  const error = Object.assign(new Error('invalid'), { code: 'EINVAL' });
  let attempts = 0;
  await assert.rejects(removeTempDir('profile', {
    async rm() { attempts++; throw error; },
    delayMs: 1,
    log() { assert.fail('unrelated errors must propagate'); },
  }), actual => actual === error);
  assert.equal(attempts, 1);
});

test('removeTempDir keeps the event loop responsive while EPERM persists', async () => {
  let lastTick = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const interval = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - lastTick);
    lastTick = now;
    ticks++;
  }, 10);
  try {
    assert.equal(await removeTempDir('locked-profile', {
      async rm() { throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
      retries: 10,
      delayMs: 20,
      log() {},
    }), false);
    maxGap = Math.max(maxGap, performance.now() - lastTick);
    assert(ticks > 0, 'interval must tick during cleanup');
    assert(maxGap < 50, `event loop tick gap was ${maxGap.toFixed(1)}ms`);
  } finally {
    clearInterval(interval);
  }
});

test('removeTempDir removes a real directory with fs.promises.rm', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-team-preview-cleanup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  writeFileSync(join(dir, 'file.txt'), 'cleanup fixture', 'utf8');
  assert.equal(await removeTempDir(dir), true);
  assert.equal(existsSync(dir), false);
});

test('screenshot cleanup awaits removeTempDir from its finally block', () => {
  const source = readFileSync(new URL('../src/preview.js', import.meta.url), 'utf8');
  const screenshot = source.slice(source.indexOf('export async function screenshot'));
  assert.match(screenshot, /finally\s*\{[\s\S]*await removeTempDir\(profile\);[\s\S]*\}\s*\}/);
});
