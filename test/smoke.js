import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Against the running demo; never dispatches a model or mutates a user's project.
const configPath = resolve('.team/demo.config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const token = readFileSync(join(config.dataDir, 'controller.token'), 'utf8');
const origin = `http://127.0.0.1:${config.port}`;
assert.equal((await fetch(origin + '/api/state')).status, 401);
assert.equal((await fetch(origin + '/api/state', { headers: { Authorization: `Bearer ${token}`, Origin: 'https://untrusted.example' } })).status, 403);
assert.equal((await fetch(origin + '/api/jobs', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' })).status, 403);
const page = await fetch(origin);
assert(page.headers.get('set-cookie').includes(`team_session_${config.port}=`));
const state = await (await fetch(origin + '/api/state', { headers: { Authorization: `Bearer ${token}` } })).json();
assert.equal(state.demo, true); assert.equal(state.agents.length, 4);
const client = new Client({ name: 'ai-team-smoke', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/mcp.js')], env: { ...process.env, TEAM_CONFIG: configPath } }));
  const tools = await client.listTools();
  assert(tools.tools.some(t => t.name === 'delegate_task'));
  assert(!tools.tools.some(t => /merge/.test(t.name)));
  const result = await client.callTool({ name: 'team_status', arguments: {} });
  assert.equal(result.isError, false); assert.equal(JSON.parse(result.content[0].text).agents.length, 4);
  console.log('PASS: HTTP auth, CSRF, origin, isolated cookie, MCP handshake + tools/status.');
} finally { await client.close(); }
