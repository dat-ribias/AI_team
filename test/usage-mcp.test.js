import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';

async function fixture() {
  const tools = new Map(), requests = [];
  let response = { ok: true, body: { totals: { tokens: 123 }, groups: [], previous: {} } };
  const source = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  await runInNewContext(`(async () => { ${source}\n })()`, {
    URL, URLSearchParams, AbortSignal, join, resolve, fileURLToPath, z,
    process: { env: {} },
    // Only synthetic config and token; never open controller credentials.
    readFileSync: path => path.endsWith('controller.token') ? 'test-only-token' : JSON.stringify({ port: 3334 }),
    McpServer: class { registerTool(name, config, callback) { tools.set(name, { config, callback }); } async connect() {} },
    StdioServerTransport: class {},
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: response.ok, json: async () => response.body }; },
  });
  const tool = tools.get('usage_report');
  return { tool, requests, call: input => tool.callback(z.object(tool.config.inputSchema).parse(input)), fail: () => { response = { ok: false, body: { error: 'Usage from must precede to' } }; } };
}

test('usage_report sends GET query parameters without a body, preserving encoding', async () => {
  const { tool, requests, call } = await fixture();
  const input = { from: '2026-10-14T00:00:00+09:00', to: '2026-10-15', groupBy: 'job', project: 'p & 日本', session: 's/1', job: 'j?1' };
  const result = await call(input), request = requests[0], url = new URL(request.url);
  assert.equal(url.origin, 'http://127.0.0.1:3334'); assert.equal(url.pathname, '/api/usage');
  assert.deepEqual(Object.fromEntries(url.searchParams), input);
  assert.equal(request.options.method, 'GET'); assert.equal('body' in request.options, false);
  assert.equal(result.isError, false); assert.equal(JSON.parse(result.content[0].text).totals.tokens, 123);
  assert.equal(tool.config.annotations.readOnlyHint, true);
  await call({}); assert.equal(new URL(requests[1].url).search, '');
});

test('usage_report schema rejects invalid group/type before requesting and accepts all groups', async () => {
  const { requests, call } = await fixture();
  for (const input of [{ groupBy: 'provider' }, { from: 123 }, { to: '' }, { project: [] }, { session: null }, { job: 1 }]) assert.throws(() => call(input));
  assert.equal(requests.length, 0);
  for (const groupBy of ['day', 'project', 'session', 'job', 'agent', 'stage', 'model']) await call({ groupBy });
  assert.equal(requests.length, 7);
});

test('usage_report passes API validation errors back as MCP errors', async () => {
  const { fail, call, requests } = await fixture();
  fail();
  const result = await call({ from: '2026-10-15', to: '2026-10-14' });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error, 'Usage from must precede to');
  assert.equal(requests[0].options.method, 'GET');
});
