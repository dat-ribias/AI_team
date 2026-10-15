import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempDir } from '../src/preview.js';

test('removeTempDir logs and returns false when EPERM persists', async () => {
  let attempts = 0;
  const logs = [];
  const removed = await removeTempDir('locked-profile', {
    rm(dir, options) {
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

test('removeTempDir retries transient filesystem locks', async () => {
  for (const code of ['EPERM', 'EBUSY', 'ENOTEMPTY']) {
    let attempts = 0;
    assert.equal(await removeTempDir('profile', {
      rm() { if (++attempts <= 2) throw Object.assign(new Error('locked'), { code }); },
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
    rm() { attempts++; throw error; },
    delayMs: 1,
    log() { assert.fail('unrelated errors must propagate'); },
  }), actual => actual === error);
  assert.equal(attempts, 1);
});

test('removeTempDir removes a real directory with rmSync', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-team-preview-cleanup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  writeFileSync(join(dir, 'file.txt'), 'cleanup fixture', 'utf8');
  assert.equal(await removeTempDir(dir), true);
  assert.equal(existsSync(dir), false);
});
