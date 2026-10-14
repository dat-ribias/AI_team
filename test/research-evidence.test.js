import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team } from '../src/team.js';
import { run } from '../src/process.js';
import { msg } from '../src/i18n.js';

async function fixture(t, { preview, provider = 'mock' } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-research-check-'));
  await run(['git'], ['init', '-b', 'main', path]);
  await run(['git'], ['-C', path, 'config', 'core.autocrlf', 'false']);
  mkdirSync(join(path, 'src'));
  writeFileSync(join(path, 'src', 'x.js'), 'original\n');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, planApproval: false, maxRamPercent: 100, maxCpuPercent: 100,
    agents: ['codex-1', 'codex-2', 'codex-3', 'gemini'].map(id => ({ id, label: id, role: id, provider: id === 'codex-2' ? provider : 'mock', home: join(path, '.mock-home', id) })),
    pipeline: { manager: 'codex-1', builders: ['codex-2'], reviewer: 'gemini', verifier: 'codex-3' },
    projects: [{ id: 'test', path, tests: [], preview }],
  };
  const team = new Team(config, mkdtempSync(join(tmpdir(), 'ai-team-research-state-')));
  t.after(() => team.close());
  return team;
}

async function settle(team, id, expected) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const job = team.get(id);
    if (job.status === expected && !team.active) return job;
    if (job.status === 'blocked' && expected !== 'blocked') assert.fail(job.error);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(`Timeout: ${JSON.stringify(team.get(id))}`);
}

const completed = { summary: 'Checked', status: 'completed', verdict: 'approved', findings: [] };
function researchAgent(team, research) {
  team.agentRun = async (agent, task, prompt) => {
    if (task.stage === 'plan') return { summary: 'Investigate with evidence', kind: 'research', rigor: 'light', risk: 'low',
      tasks: [{ kind: 'research', agent: 'codex-2', difficulty: 2, instruction: 'Investigate', files: ['.ai-team/evidence/shot.txt'], dependsOn: [] }] };
    if (task.stage === 'research') await research(task, prompt);
    return completed;
  };
}

for (const provider of ['codex', 'claude']) test(`research archives evidence without changing revision (${provider})`, async t => {
  const team = await fixture(t, { provider });
  let worktree, snapshot;
  researchAgent(team, async (task, prompt) => {
    worktree = task.worktree;
    snapshot = JSON.parse(prompt.match(/Code snapshot: (\{[^\n]+\})/)[1]);
    assert.equal(task.demoServer, undefined);
    mkdirSync(join(worktree, '.ai-team', 'evidence'), { recursive: true });
    writeFileSync(join(worktree, '.ai-team', 'evidence', 'shot.txt'), 'research proof');
  });
  const job = await team.create({ project: 'test', goal: 'Research evidence' });
  const done = await settle(team, job.id, 'done');
  assert.equal(done.revision, done.base);
  const archive = done.evidence.find(e => e.stage === 'research');
  assert(archive.files.some(f => f.path === '.ai-team/evidence/shot.txt'));
  assert.equal(readFileSync(join(team.dataDir, 'evidence', job.id, archive.dir, '.ai-team', 'evidence', 'shot.txt'), 'utf8'), 'research proof');
  assert.deepEqual(done.reports.find(r => r.stage === 'research').codeSnapshot, snapshot, 'Evidence did not change the code snapshot');
  if (provider === 'claude') assert.equal(existsSync(worktree), false, 'Scratch evidence was archived before removal');
  else assert.equal((await run(['git'], ['-C', worktree, 'status', '--porcelain'])).stdout.trim(), '');
});

for (const throws of [false, true]) test(`research reverts forbidden tracked and new files${throws ? ' after agent failure' : ''}`, async t => {
  const team = await fixture(t, { provider: 'codex' });
  researchAgent(team, async task => {
    writeFileSync(join(task.worktree, 'src', 'x.js'), 'forbidden\n');
    writeFileSync(join(task.worktree, 'src', 'new.js'), 'forbidden\n');
    if (throws) throw new Error('Mock agent failed');
  });
  const job = await team.create({ project: 'test', goal: 'Research source' });
  const blocked = await settle(team, job.id, 'blocked');
  assert.equal(readFileSync(join(blocked.worktree, 'src', 'x.js'), 'utf8'), 'original\n');
  assert.equal(existsSync(join(blocked.worktree, 'src', 'new.js')), false);
  assert.equal(blocked.revision, blocked.base);
  const event = team.events(job.id).find(e => e.type === 'PERMISSION');
  assert.deepEqual(event.details.files.map(f => f.path).sort(), ['src/new.js', 'src/x.js']);
  assert.equal(event.summary, msg('srv.team.research_write_blocked', { 0: 'codex-2', 1: event.details.files.map(f => f.path).join(', ') }));
});

const shellCommand = command => process.platform === 'win32' ? `"${command}"` : command;
const preview = { command: shellCommand(`"${process.execPath}" -e "require('node:http').createServer((req,res)=>res.end(JSON.stringify({dataDir:process.env.DATA_DIR}))).listen({port},'127.0.0.1')"`), portRange: [43050, 43070], timeoutSec: 5,
  routes: [{ name: 'home', path: '/' }] };

for (const throws of [false, true]) test(`research receives a managed demo and cleans up${throws ? ' after agent failure' : ''}`, async t => {
  const team = await fixture(t, { preview });
  let url, dataDir;
  researchAgent(team, async (task, prompt) => {
    url = task.demoServer.url;
    assert(prompt.includes(`"demoServer":${JSON.stringify(task.demoServer)}`));
    assert.match(prompt, /Do not start a server yourself/);
    assert.notEqual(new URL(url).port, '3333');
    assert.deepEqual(task.demoServer.routes, preview.routes);
    assert(Date.parse(task.demoServer.stopsAt) > Date.now());
    assert(Date.parse(task.demoServer.stopsAt) <= Date.now() + 15 * 60000);
    ({ dataDir } = await (await fetch(url)).json());
    assert(dataDir.startsWith(join(tmpdir(), 'ai-team-demo-')));
    assert(existsSync(dataDir));
    if (throws) throw new Error('Mock demo agent failed');
  });
  const job = await team.create({ project: 'test', goal: 'Research demo' });
  await settle(team, job.id, throws ? 'blocked' : 'done');
  assert(url, 'Agent received demo URL');
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  assert.equal(existsSync(dataDir), false);
  const events = team.events(job.id);
  assert.equal(events.filter(e => e.type === 'DEMO_STARTED').length, 1);
  assert.equal(events.filter(e => e.type === 'DEMO_STOPPED').length, 1);
});

test('research continues when the demo cannot start', async t => {
  const team = await fixture(t, { preview: { ...preview, command: shellCommand(`"${process.execPath}" -e "process.exit(1)" "{port}"`) } });
  researchAgent(team, async task => assert.equal(task.demoServer, undefined));
  const job = await team.create({ project: 'test', goal: 'Research unavailable demo' });
  await settle(team, job.id, 'done');
  assert(team.events(job.id).some(e => e.type === 'WARNING' && e.summary === msg('srv.team.demo_failed', { 0: 'Preview process exited' })));
  assert(!team.events(job.id).some(e => e.type === 'DEMO_STARTED'));
});
