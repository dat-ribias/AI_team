import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTargetedTests } from '../src/team.js';

const testFiles = [
  { path: 'test/app.test.js', text: "readFileSync('public/app.js', 'utf8')" },
  { path: 'test/other.test.js', text: "import '../src/other.js'" },
  { path: 'test/system.test.js', text: "readFileSync('public/app.js', 'utf8')" },
];

test('selectTargetedTests selects only tests mentioning the changed source basename', () => {
  assert.deepEqual(selectTargetedTests(['public/app.js'], testFiles), ['test/app.test.js']);
});

test('selectTargetedTests falls back to the full suite for core changes or an empty diff', () => {
  for (const path of ['src/team.js', 'src/server.js', 'package.json', 'test/system.test.js']) {
    assert.equal(selectTargetedTests(['public/app.js', path], testFiles), null);
  }
  assert.equal(selectTargetedTests([], testFiles), null);
});

test('selectTargetedTests falls back to the full suite without related tests', () => {
  assert.equal(selectTargetedTests(['src/unmatched.js'], testFiles), null);
  assert.equal(selectTargetedTests(['public/app.js'], []), null);
});

test('selectTargetedTests includes changed test files that still exist', () => {
  assert.deepEqual(selectTargetedTests(['test/other.test.js'], testFiles), ['test/other.test.js']);
  assert.equal(selectTargetedTests(['test/deleted.test.js'], testFiles), null);
});

test('selectTargetedTests never selects the system suite through basename matching', () => {
  assert.equal(selectTargetedTests(['public/app.js'], [testFiles[2]]), null);
});

test('selectTargetedTests returns sorted unique paths without changing the inputs', () => {
  const changed = ['test/other.test.js', 'public/app.js', 'test/app.test.js'];
  const files = [testFiles[1], testFiles[0], testFiles[0]];
  assert.deepEqual(selectTargetedTests(changed, files), ['test/app.test.js', 'test/other.test.js']);
  assert.deepEqual(changed, ['test/other.test.js', 'public/app.js', 'test/app.test.js']);
  assert.deepEqual(files, [testFiles[1], testFiles[0], testFiles[0]]);
});
