import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team, jobTitle, taskTitle, validateConfig, redact, routeGoal, compressOutput, computeSlots, defaultSensitive } from '../src/team.js';
import { testList } from '../src/accounts.js';
import { run, childEnv } from '../src/process.js';
import { runOracle } from '../src/oracle.js';
import { parseReport, normalizeCodexQuota, normalizeGoogleQuota, runAgent } from '../src/providers.js';
import { exportTransfer, importTransfer } from '../src/transfer.js';
import { fileHash, MemoryStore, hash } from '../src/memory.js';
import { ledger, question, answer, decide, refreshLedger } from '../src/discussions.js';
import { collect, kind, safeRel } from '../src/evidence.js';
import { msg } from '../src/i18n.js';
import { validatePreview, previewEnv, startServer, waitReady, freePort, stopTree, findChrome, screenshot } from '../src/preview.js';

// Shared helpers for test/system-*.test.js (split from system.test.js to run in parallel).

export async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-check-'));
  await run(['git'], ['init', '-b', 'main', path]);
  // Fixture expectations use LF regardless of the machine's global Git setting.
  await run(['git'], ['-C', path, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  // challenge: 'high' giữ luồng cũ cho các test chức năng khác; phản biện mọi job có test riêng (test/challenge.test.js).
  const config = { demo: true, planApproval: false, maxRamPercent: 100, maxCpuPercent: 100, challenge: 'high',
    agents: ['codex-1', 'codex-2', 'codex-3', 'codex-4', 'gemini'].map(id => ({ id, label: id, role: id, provider: 'mock' })),
    pipeline: { manager: 'codex-1', builders: ['codex-2', 'codex-4'], reviewer: 'gemini', verifier: 'codex-3' },
    projects: [{ id: 'test', path, tests: [[process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('hello.txt','utf8'),'Hello from AI Team demo!\\n')"]] }],
  };
  return { config, path, data: mkdtempSync(join(tmpdir(), 'ai-team-state-')) };
}
export async function settle(team, id, expected, timeoutMs = 20000) {
  const timeout = Date.now() + timeoutMs;
  while (Date.now() < timeout) {
    const job = team.get(id);
    if (job.status === expected && !team.active) return job;
    if (job.status === 'blocked' && expected !== 'blocked') assert.fail(job.error);
    await new Promise(r => setTimeout(r, 30));
  }
  assert.fail(`Timeout: ${JSON.stringify(team.get(id))}`);
}

export async function approvalAgent(agent, task, prompt, opts) {
  if (task.stage === 'plan') return { summary: `Plan round ${task.round}: ${task.messages.map(m => m.text).join('; ')}`,
    kind: /research/i.test(task.goal) ? 'research' : 'code', rigor: 'standard', risk: 'low',
    tasks: [{ kind: /research/i.test(task.goal) ? 'research' : 'implement', agent: 'codex-2', difficulty: 2, instruction: 'Update hello.txt', files: /research/i.test(task.goal) ? [] : ['hello.txt'], dependsOn: [] }] };
  if (task.stage === 'implement') return runAgent(agent, task, prompt, opts);
  return { summary: 'Checked', status: 'completed', verdict: 'approved', findings: [], objections: [] };
}

export async function branchReady(t, f = null, baseBranch) {
  f ||= await fixture();
  const team = new Team(f.config, f.data); team.closed = true; t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello', paused: true, ...(baseBranch ? { baseBranch } : {}) });
  writeFileSync(join(job.worktree, 'hello.txt'), 'Hello from AI Team demo!\n');
  await team.checkpoint(job);
  assert(await team.runTests(job, job.worktree, job.revision, f.config.projects[0].tests));
  Object.assign(job, { status: 'ready', tested: job.revision, reviewed: job.revision, verified: job.revision,
    reports: [...job.reports, { stage: 'review', agent: 'gemini', verdict: 'approved', findings: [], tests: 'AI assertion', revision: job.revision }] });
  team.save(job); return { f, team, job };
}
export async function branchCommit(f, branch, file = 'other.txt', content = 'Target work\n') {
  const tip = (await run(['git'], ['-C', f.path, 'rev-parse', `refs/heads/${branch}`])).stdout.trim();
  const wt = join(f.data, 'target-edit');
  await run(['git'], ['-C', f.path, 'worktree', 'add', '--detach', wt, tip]);
  try {
    writeFileSync(join(wt, file), content);
    await run(['git'], ['-C', wt, 'add', '.']);
    await run(['git'], ['-C', wt, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'target change']);
    const commit = (await run(['git'], ['-C', wt, 'rev-parse', 'HEAD'])).stdout.trim();
    await run(['git'], ['-C', f.path, 'update-ref', `refs/heads/${branch}`, commit, tip]); return commit;
  } finally { await run(['git'], ['-C', f.path, 'worktree', 'remove', '--force', wt]); }
}
export async function branchTip(f, branch = 'main') { return (await run(['git'], ['-C', f.path, 'rev-parse', `refs/heads/${branch}`])).stdout.trim(); }

export const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export async function previewFixture(t, config = {}) {
  const f = await fixture();
  writeFileSync(join(f.path, 'server.js'), `const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const owner = ${process.pid};
const guard = "setInterval(() => { try { process.kill(" + owner + ", 0); process.kill(" + process.pid + ", 0); } catch { process.exit(); } }, 200); setTimeout(() => process.exit(), 45000).unref();";
const leaf = spawn(process.execPath, ['-e', guard], { stdio: 'ignore', windowsHide: true });
setInterval(() => { try { process.kill(owner, 0); process.kill(process.ppid, 0); } catch { process.exit(); } }, 200);
setTimeout(() => process.exit(), 45000).unref();
const server = createServer((req, res) => {
  if (req.url === '/pid') return res.end(JSON.stringify({ pid: process.pid, leaf: leaf.pid }));
  res.writeHead(req.url === '/' || req.url === '/ready' ? 200 : 404, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><body><h1>Preview fixture</h1></body></html>');
});
setTimeout(() => server.listen(Number(process.argv[2]), '127.0.0.1'), Number(process.argv[3]) || 0);
`);
  await run(['git'], ['-C', f.path, 'add', 'server.js']);
  await run(['git'], ['-C', f.path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'preview fixture']);
  f.config.projects[0].preview = { command: 'node server.js {port}', readyPath: '/ready', timeoutSec: 5, ttlMin: 1, portRange: [4200, 4299], ...config };
  const result = await branchReady(t, f), pids = new Set();
  result.job.kind = 'code'; result.team.save(result.job);
  result.team.previewChrome = () => null;
  result.team.capacity = () => ({ start: 3 - result.team.runs.size - result.team.previews.size, hardStop: false });
  t.after(async () => {
    for (const p of result.team.previews.values()) { if (p.after?.pid) pids.add(p.after.pid); if (p.before?.pid) pids.add(p.before.pid); }
    await result.team.close();
    for (const pid of pids) await stopTree(pid);
    rmSync(f.data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(f.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { ...result, pids };
}

export async function parallelTeam(t, plan, kind = 'code') {
  const f = await fixture();
  f.config.projects[0].tests = [];
  f.config.resources = { reserveGB: 0, ramPerAgentGB: 0.01, maxAgents: 4, hardStopRamPercent: 100 };
  f.config.pipeline.builders = ['codex-2', 'codex-4'];
  const spans = [], prompts = [];
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'plan') return { summary: 'plan', kind, rigor: 'standard', risk: 'low', status: 'planned', tasks: plan };
    if (['implement', 'research'].includes(task.stage)) {
      const n = Number(/T(\d)/.exec(prompt)?.[1]); prompts.push(prompt);
      const span = { n, agent: agent.id, start: Date.now() }; spans.push(span);
      await new Promise(r => setTimeout(r, 400));
      if (task.stage === 'implement') writeFileSync(join(task.worktree, `t${n}.txt`), `task ${n}\n`);
      span.end = Date.now();
      return { summary: `done T${n}`, status: 'completed', verdict: 'approved', findings: [], contextGaps: n === 1 ? ['read utils.js'] : [] };
    }
    return runAgent(agent, task, prompt, opts);
  } });
  t.after(() => team.close());
  return { team, spans, prompts, f };
}
export const overlaps = (a, b) => a.start < b.end && b.start < a.end;
