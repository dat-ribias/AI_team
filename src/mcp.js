import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = JSON.parse(readFileSync(process.env.TEAM_CONFIG || join(root, 'team.config.json'), 'utf8'));
const token = readFileSync(join(config.dataDir || join(root, '.team/state'), 'controller.token'), 'utf8');
const server = new McpServer({ name: 'ai-team', version: '0.1.0' });
async function api(path, data) {
  const response = await fetch(`http://127.0.0.1:${config.port || 3333}/api/${path}`, {
    method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Team-Request': '1' },
    ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !response.ok };
}
server.registerTool('team_status', { description: 'Read agents, jobs, quota and resources.', inputSchema: {} }, () => api('state'));
server.registerTool('delegate_task', { description: 'Create a supervised goal in a registered project. Manager plans, workers implement, reviewer and verifier check. Merge requires a human in the dashboard.', inputSchema: { project: z.string(), goal: z.string().min(1).max(20000) } }, input => api('jobs', input));
server.registerTool('get_agent_status', { description: 'Read a task and its current stage.', inputSchema: { task_id: z.string() } }, ({ task_id }) => api(`jobs/${encodeURIComponent(task_id)}`));
server.registerTool('read_messages', { description: 'Read logged assignments, decisions, results and observable actions. Page by last seq.', inputSchema: { task_id: z.string(), after: z.number().int().min(0).optional() } }, ({ task_id, after = 0 }) => api(`jobs/${encodeURIComponent(task_id)}/events?after=${after}`));
server.registerTool('send_message', { description: 'Queue guidance for the next agent invocation; does not interrupt the active CLI.', inputSchema: { task_id: z.string(), message: z.string().min(1).max(20000) } }, ({ task_id, message }) => api(`jobs/${encodeURIComponent(task_id)}/control`, { action: 'message', message }));
server.registerTool('control_task', { description: 'Pause, resume, cancel, or request a new test/review cycle.', inputSchema: { task_id: z.string(), action: z.enum(['pause', 'resume', 'cancel', 'review']) } }, ({ task_id, action }) => api(`jobs/${encodeURIComponent(task_id)}/control`, { action }));
await server.connect(new StdioServerTransport());
