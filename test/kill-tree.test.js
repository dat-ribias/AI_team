import test from 'node:test';
import assert from 'node:assert/strict';
import { taskkillSucceeded } from '../src/process.js';

test('taskkill succeeds only for exit codes 0 and 128', () => {
  assert.equal(taskkillSucceeded(0), true);
  assert.equal(taskkillSucceeded(128), true);
  assert.equal(taskkillSucceeded(1), false);
  assert.equal(taskkillSucceeded(255), false);
  assert.equal(taskkillSucceeded(null), false);
});
