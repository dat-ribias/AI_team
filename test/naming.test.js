import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team, titleSlug, taskTitle } from '../src/team.js';
import { run } from '../src/process.js';

const git = async (root, ...args) => (await run(['git'], ['-C', root, ...args])).stdout.trim();
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-team-naming-')), data = mkdtempSync(join(tmpdir(), 'ai-team-naming-state-'));
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'hello.txt'), 'Hello!\n');
  await git(root, 'add', '.');
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial');
  const team = new Team({ demo: true, agents: [{ id: 'builder', label: 'Builder Name', provider: 'mock' }],
    pipeline: { manager: 'builder', builders: ['builder'], reviewer: 'builder', verifier: 'builder' },
    projects: [{ id: 'test', path: root, tests: [] }] }, data);
  team.closed = true;
  t.after(async () => { await team.close(); rmSync(data, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  return { root, team };
}

test('branch slug handles Vietnamese, special characters, empty titles and length limits', () => {
  assert.equal(titleSlug('\u0110\u1eb7t t\u00ean c\u00f4ng vi\u1ec7c'), 'dat-ten-cong-viec');
  assert.equal(titleSlug('  Fix: [API] / bugs?!  '), 'fix-api-bugs');
  assert.equal(titleSlug(''), '');
  assert.equal(titleSlug('\u65e5\u672c\u8a9e !!!'), '');
  assert.equal(titleSlug('a'.repeat(39) + ' -- end'), 'a'.repeat(39));
  assert.equal(titleSlug('x'.repeat(80)), 'x'.repeat(40));
});

test('task titles prefer the cleaned explicit title and fall back to the first instruction line', () => {
  assert.equal(taskTitle({ title: '  Fix\n  API ', instruction: 'ignored' }), 'Fix API');
  assert.equal(taskTitle({ title: '  ', instruction: '  First  line\nSecond line' }), 'First line');
  assert.equal(taskTitle({ instruction: 'x'.repeat(80) }), 'x'.repeat(60));
  assert.equal(taskTitle({ title: 'y'.repeat(80) }), 'y'.repeat(60));
});

test('new job branches use owner or automatic titles and keep worktree paths stable', async t => {
  const { root, team } = await fixture(t);
  for (const input of [{ title: '\u0110\u1eb7t t\u00ean !!!', goal: 'Ignored' }, { goal: 'Fix API\nDetails' }, { goal: '\u65e5\u672c\u8a9e' }]) {
    const job = await team.create({ project: 'test', ...input, paused: true });
    const slug = titleSlug(input.title || input.goal.split('\n')[0]);
    assert.equal(job.branch, `ai-team/${job.id}${slug ? `-${slug}` : ''}`);
    assert.equal(job.worktree, join(team.dataDir, 'worktrees', job.id));
    assert.equal(await git(root, 'check-ref-format', '--branch', job.branch), job.branch);
    await team.control(job.id, 'rename', { title: 'Renamed task' });
    assert.equal(team.get(job.id).branch, job.branch);
  }
});

test('checkpoints use task titles and member labels while legacy branches keep their names', async t => {
  const { root, team } = await fixture(t);
  const job = await team.create({ project: 'test', goal: 'Job title', paused: true });
  await git(job.worktree, 'branch', '-m', `ai-team/${job.id}`);
  job.branch = `ai-team/${job.id}`;
  job.tasks = [{ title: '  Task  title ', instruction: 'Fallback' }];
  writeFileSync(join(job.worktree, 'hello.txt'), 'Task edit\n');
  await team.commitAll(job, job.worktree, job.branch, { agent: 'builder', taskIndex: 0 });
  assert.equal(await git(root, 'log', '-1', '--format=%an|%ae|%s', job.branch), 'Builder Name (AI Team)|builder@ai-team.local|Task title (Builder Name)');
  writeFileSync(join(job.worktree, 'hello.txt'), 'Job edit\n');
  await team.commitAll(job);
  assert.equal(await git(root, 'log', '-1', '--format=%s', job.branch), 'Job title (Builder Name)');
  assert.equal(await git(job.worktree, 'branch', '--show-current'), `ai-team/${job.id}`);
});
