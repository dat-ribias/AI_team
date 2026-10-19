import test from 'node:test';
import assert from 'node:assert/strict';
import { callCost } from '../src/usage.js';

test('callCost: USD per 1M tokens, cached is a subset of input except for Claude, unknown model → null', () => {
  const pricing = { 'gpt-5': { input: 1, output: 10, cached: 0.1 }, 'gpt-5-mini': { input: 0.5, output: 2 }, opus: { input: 5, output: 25, cached: 0.5, cacheWrite: 6.25 } };
  assert.equal(callCost({ model: 'gpt-5', provider: 'codex', inputTokens: 1e6, cachedTokens: 5e5, outputTokens: 1e5 }, pricing), 0.5 + 0.05 + 1);
  assert.equal(callCost({ model: 'gpt-5-mini-2026', provider: 'codex', inputTokens: 2e6, outputTokens: 0 }, pricing), 1); // longest prefix wins
  assert.equal(callCost({ model: 'opus', provider: 'claude', inputTokens: 1e6, cachedTokens: 1e6, cacheCreationTokens: 1e6, outputTokens: 0 }, pricing), 5 + 0.5 + 6.25);
  assert.equal(callCost({ model: 'unknown', inputTokens: 1, outputTokens: 1 }, pricing), null);
  assert.equal(callCost({ model: 'opus', inputTokens: null, outputTokens: 1 }, pricing), null);
  assert.equal(callCost({ model: 'gpt-5', inputTokens: 1, outputTokens: 1 }, { 'gpt-5': { input: null, output: null } }), null);
});
