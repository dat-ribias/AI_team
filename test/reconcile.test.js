import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/process.js';
import { mainBranchOf, integrationBranchOf, inventoryJob, classify, listOrphans } from '../src/reconcile.js';

async function git(root, args) {
  const result = await run(['git'], ['-C', root, ...args], { timeoutMs: 30_000 });
  return result.stdout.trim();
}
function file(path, text = 'content\n') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
async function commit(root, name = 'change.txt', text = 'change\n') {
  file(join(root, name), text);
  await git(root, ['add', '--all']);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--no-verify', '-m', name]);
  return git(root, ['rev-parse', 'HEAD']);
}
async function repository(root, branch = 'master') {
  await git(join(root, '..'), ['init', '-b', branch, root]);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await commit(root, 'initial.txt');
  return git(root, ['rev-parse', 'HEAD']);
}
async function fixture(t, options = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'ai-team-reconcile-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'repo'), dataDir = join(temp, 'data');
  mkdirSync(dataDir);
  const base = await repository(root, options.main || 'master');
  const id = 'abcdef12', branch = `ai-team/${id}-task-title`, worktree = join(dataDir, 'worktrees', id);
  await git(root, ['worktree', 'add', '-b', branch, worktree]);
  const job = { id, status: 'ready', branch, base, revision: base, worktree, tasks: [] };
  const ctx = { root, dataDir, project: { path: root }, job, git, run };
  const inspect = () => inventoryJob(ctx);
  return { ...ctx, temp, ctx, inspect };
}
async function changed(ctx) {
  ctx.job.revision = await commit(ctx.job.worktree);
  return ctx.job.revision;
}
async function merge(root, branch, destination = 'master') {
  await git(root, ['checkout', destination]);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'merge', '--no-edit', '--no-ff', branch]);
}

test('main and integration branches use configuration, exact local refs and master/main fallback', async t => {
  const ctx = await fixture(t, { main: 'main' });
  assert.equal(await mainBranchOf(ctx.root, {}, git), 'main');
  await git(ctx.root, ['branch', 'master']);
  assert.equal(await mainBranchOf(ctx.root, {}, git), 'master');
  assert.equal(await mainBranchOf(ctx.root, { mainBranch: 'release' }, git), 'release');
  assert.equal(await integrationBranchOf(ctx.root, { integrationBranch: 'dev' }, git), null);
  await git(ctx.root, ['branch', 'dev']);
  assert.equal(await integrationBranchOf(ctx.root, { integrationBranch: 'dev' }, git), 'dev');
  await git(ctx.root, ['checkout', '--detach']);
  await git(ctx.root, ['branch', '-D', 'master', 'main']);
  await git(ctx.root, ['branch', 'master/topic']);
  assert.equal(await mainBranchOf(ctx.root, {}, git), null);
});

for (const status of ['cancelled', 'ready', 'merged']) test(`manual merge into master overrides stored ${status} status`, async t => {
  const ctx = await fixture(t);
  const tip = await changed(ctx);
  ctx.job.status = status;
  await merge(ctx.root, ctx.job.branch);
  const inventory = await ctx.inspect(), repo = inventory.repos[0];
  assert.equal(classify(ctx.job, inventory).state, 'in_master');
  assert.deepEqual(repo.revision, { commit: tip, exists: true, inMain: true, inIntegration: false });
  assert.equal(repo.branches[0].ownCommits, 1);
  assert.ok(repo.branches[0].lastCommitAt);
});

test('a merged job integrated into dev waits for owner RC approval', async t => {
  const ctx = await fixture(t);
  await changed(ctx);
  await git(ctx.root, ['branch', 'dev']);
  await merge(ctx.root, ctx.job.branch, 'dev');
  ctx.ctx.project.integrationBranch = 'dev'; ctx.job.status = 'merged';
  const inventory = await ctx.inspect(), result = classify(ctx.job, inventory);
  assert.equal(result.state, 'awaiting_owner');
  assert.equal(result.reason, 'đã vào dev, chờ duyệt RC lên master');
  assert.equal(inventory.repos[0].branches[0].inIntegration, true);
  assert.equal(inventory.repos[0].revision.inMain, false);
});

test('stored merged status without ancestry proof is merge_stuck, including a missing revision', async t => {
  const ctx = await fixture(t);
  const tip = await changed(ctx); ctx.job.status = 'merged';
  const result = classify(ctx.job, await ctx.inspect());
  assert.equal(result.state, 'merge_stuck'); assert.ok(result.reason.includes(tip)); assert.ok(result.reason.includes('master'));
  ctx.job.revision = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const inventory = await ctx.inspect();
  assert.equal(inventory.repos[0].revision.exists, false);
  assert.equal(classify(ctx.job, inventory).state, 'merge_stuck');
});

test('cancelled job retains divergent child WIP even when its primary branch is clean', async t => {
  const ctx = await fixture(t), child = `${ctx.job.branch}-t1`;
  const wt = `${ctx.job.worktree}-t1`;
  await git(ctx.root, ['worktree', 'add', '-b', child, wt]);
  const tip = await commit(wt, 'wip.txt');
  ctx.job.status = 'cancelled'; ctx.job.tasks = [{ id: 'task-one', checkpoint: { wip: { branch: child, commit: tip } } }];
  const inventory = await ctx.inspect(), result = classify(ctx.job, inventory);
  assert.equal(inventory.repos[0].branches.find(b => b.name === ctx.job.branch).ownCommits, 0);
  assert.deepEqual(inventory.repos[0].wip, [{ task: 'task-one', commit: tip, reachable: true, inMain: false }]);
  assert.equal(result.state, 'cancelled_unmerged'); assert.ok(result.reason.includes(child)); assert.ok(result.reason.includes(tip));
  await git(ctx.root, ['worktree', 'remove', wt]);
  await git(ctx.root, ['branch', '-D', child]);
  const unreachable = await ctx.inspect();
  assert.equal(unreachable.repos[0].wip[0].reachable, false);
  assert.equal(classify(ctx.job, unreachable).state, 'cancelled_unmerged');
});

test('tracked and untracked dirty files are preserved with spaces and unicode', async t => {
  const ctx = await fixture(t); ctx.job.status = 'cancelled';
  file(join(ctx.job.worktree, 'initial.txt'), 'modified\n');
  file(join(ctx.job.worktree, 'new file tiếng Việt.txt'));
  const inventory = await ctx.inspect(), dirty = inventory.repos[0].dirty;
  assert.deepEqual(dirty, [{ worktree: ctx.job.worktree.replace(/\\/g, '/'), files: ['initial.txt', 'new file tiếng Việt.txt'] }]);
  const result = classify(ctx.job, inventory);
  assert.equal(result.state, 'cancelled_unmerged'); assert.ok(result.reason.includes('initial.txt')); assert.ok(result.reason.includes('new file tiếng Việt.txt'));
});

test('a linked repository not merged into main prevents global in_master', async t => {
  const ctx = await fixture(t), path = join(ctx.temp, 'linked');
  const base = await repository(path, 'main'), branch = `${ctx.job.branch}-linked`, worktree = `${ctx.job.worktree}@linked`;
  await git(path, ['worktree', 'add', '-b', branch, worktree]);
  const revision = await commit(worktree, 'linked.txt');
  ctx.job.linked = [{ path, branch, base, revision, worktree }];
  await changed(ctx); await merge(ctx.root, ctx.job.branch);
  const inventory = await ctx.inspect(), result = classify(ctx.job, inventory);
  assert.equal(inventory.repos.length, 2); assert.equal(inventory.repos[1].main, 'main');
  assert.equal(inventory.repos[1].branches[0].ownCommits, 1);
  assert.equal(result.state, 'merge_stuck'); assert.ok(result.reason.includes(path));
  await merge(path, branch, 'main');
  assert.equal(classify(ctx.job, await ctx.inspect()).state, 'in_master');
});

test('jobs without their own commits never become in_master', async t => {
  const ctx = await fixture(t);
  assert.equal(classify(ctx.job, await ctx.inspect()).state, 'awaiting_owner');
  ctx.job.status = 'cancelled';
  const inventory = await ctx.inspect();
  assert.equal(classify(ctx.job, inventory).state, 'cancelled_clean');
  assert.equal(classify(null, inventory).state, 'cancelled_clean');
});

test('saved revision proves a manual merge after branch cleanup, but divergent WIP prevents it', async t => {
  const ctx = await fixture(t);
  await changed(ctx); await merge(ctx.root, ctx.job.branch);
  await git(ctx.root, ['worktree', 'remove', ctx.job.worktree]);
  await git(ctx.root, ['branch', '-D', ctx.job.branch]);
  let inventory = await ctx.inspect();
  assert.deepEqual(inventory.repos[0].branches, []);
  assert.equal(classify(ctx.job, inventory).state, 'in_master');
  const child = `${ctx.job.branch}-t2`, wt = `${ctx.job.worktree}-t2`;
  await git(ctx.root, ['worktree', 'add', '-b', child, wt, ctx.job.base]);
  const tip = await commit(wt, 'divergent.txt');
  ctx.job.tasks = [{ checkpoint: { wip: { branch: child, commit: tip } } }];
  ctx.job.status = 'cancelled';
  inventory = await ctx.inspect();
  assert.equal(inventory.repos[0].revision.inMain, true);
  assert.equal(classify(ctx.job, inventory).state, 'cancelled_unmerged');
});

test('deleted job branches and worktrees are listed with real ancestry and dirty flags', async t => {
  const ctx = await fixture(t), tip = await changed(ctx);
  await merge(ctx.root, ctx.job.branch);
  file(join(ctx.job.worktree, 'loose.txt'));
  const other = 'ai-team/1234abcd-not-merged', outside = join(ctx.temp, 'external-ai-tree');
  await git(ctx.root, ['worktree', 'add', '-b', other, outside]);
  await commit(outside, 'other.txt');
  const user = join(ctx.temp, 'user-tree');
  await git(ctx.root, ['worktree', 'add', '-b', 'personal', user]);
  await git(ctx.root, ['branch', 'ai-team/not-a-job']);
  const list = () => listOrphans({ projects: [ctx.project], jobs: [], dataDir: ctx.dataDir, git, run });
  const items = await list();
  const branch = items.find(item => item.kind === 'branch' && item.target === ctx.job.branch);
  assert.equal(branch.tip, tip); assert.equal(branch.inMain, true); assert.equal(branch.ownCommits, 0); assert.ok(branch.lastCommitAt);
  const tree = items.find(item => item.kind === 'worktree' && item.jobId === ctx.job.id);
  assert.equal(tree.inMain, true); assert.equal(tree.dirty, true); assert.equal(tree.prunable, false);
  assert.equal(items.find(item => item.kind === 'branch' && item.target === other).inMain, false);
  assert.ok(items.some(item => item.kind === 'worktree' && item.branch === other));
  assert.equal(items.some(item => item.target === user || item.target === ctx.root || item.target === 'personal' || item.target === 'ai-team/not-a-job'), false);
  assert.deepEqual(await listOrphans({ projects: [ctx.project], jobs: [ctx.job, { id: '1234abcd' }], dataDir: ctx.dataDir, git, run }), []);
});

test('prunable worktrees remain in orphan inventory but are never inspected for dirt', async t => {
  const ctx = await fixture(t);
  rmSync(ctx.job.worktree, { recursive: true });
  const before = await git(ctx.root, ['worktree', 'list', '--porcelain']);
  assert.ok(before.includes('prunable'));
  assert.deepEqual((await ctx.inspect()).repos[0].dirty, []);
  const items = await listOrphans({ projects: [ctx.project], jobs: [], dataDir: ctx.dataDir, git, run });
  const tree = items.find(item => item.kind === 'worktree');
  assert.equal(tree.prunable, true); assert.equal(tree.dirty, false); assert.equal(existsSync(ctx.job.worktree), false);
  assert.equal(await git(ctx.root, ['worktree', 'list', '--porcelain']), before);
});

test('detached orphan worktrees under dataDir are included and live job scratch trees are excluded', async t => {
  const ctx = await fixture(t), detached = join(ctx.dataDir, 'worktrees', '1234abcd-review-scratch');
  await git(ctx.root, ['worktree', 'add', '--detach', detached]);
  const scratch = `${ctx.job.worktree}-review-scratch`;
  await git(ctx.root, ['worktree', 'add', '--detach', scratch]);
  const items = await listOrphans({ projects: [ctx.project], jobs: [ctx.job], dataDir: ctx.dataDir, git, run });
  assert.equal(items.length, 1); assert.equal(items[0].jobId, '1234abcd'); assert.equal(items[0].kind, 'worktree');
});

test('reconciliation is read only, including the worktree index during dirty checks', async t => {
  const ctx = await fixture(t);
  file(join(ctx.job.worktree, 'initial.txt'), 'dirty\n');
  const index = await git(ctx.job.worktree, ['rev-parse', '--git-path', 'index']);
  const before = readFileSync(index), refs = await git(ctx.root, ['show-ref']), trees = await git(ctx.root, ['worktree', 'list', '--porcelain']);
  const commands = [], readRun = async (command, args, options) => { commands.push(args); return run(command, args, options); };
  await inventoryJob({ ...ctx.ctx, run: readRun });
  await listOrphans({ projects: [ctx.project], jobs: [], dataDir: ctx.dataDir, git, run: readRun });
  assert.deepEqual(readFileSync(index), before);
  assert.equal(await git(ctx.root, ['show-ref']), refs); assert.equal(await git(ctx.root, ['worktree', 'list', '--porcelain']), trees);
  assert.ok(commands.every(args => args[0] === '--no-optional-locks'));
});

test('ancestry errors above exit code one propagate instead of claiming a merge', async t => {
  const ctx = await fixture(t);
  const failRun = (command, args, options) => args.includes('--is-ancestor') ? Promise.resolve({ code: 128, stdout: '', stderr: 'ancestry unavailable' }) : run(command, args, options);
  await assert.rejects(inventoryJob({ ...ctx.ctx, run: failRun }), /ancestry unavailable/);
});

test('classification order and merge failure details match owner action rules', () => {
  const inventory = { repos: [{ root: 'repo', main: 'master', integration: null, branches: [{ ownCommits: 1, inMain: true }], revision: { commit: 'tip', exists: true, inMain: true }, wip: [], dirty: [] }] };
  for (const status of ['running', 'queued', 'merging', 'paused']) {
    const result = classify({ status, base: 'base' }, inventory);
    assert.equal(result.state, 'working'); assert.equal(result.reason, status);
  }
  for (const kind of ['base_moved', 'conflict', 'tests_failed']) {
    const result = classify({ status: 'ready', mergeFailure: { kind, files: ['conflict.txt'] } }, { repos: [] });
    assert.deepEqual(result, { state: 'merge_stuck', reason: kind, kind, files: ['conflict.txt'] });
  }
  assert.deepEqual(classify({ status: 'blocked', error: 'owner input' }, { repos: [] }), { state: 'awaiting_owner', reason: 'owner input' });
  assert.equal(classify({ kind: 'research' }, { repos: [] }).state, 'done');
  assert.equal(classify({ status: 'done' }, { repos: [] }).state, 'done');
  const unmergedWip = structuredClone(inventory); unmergedWip.repos[0].wip = [{ commit: 'wip', inMain: false }];
  assert.equal(classify({ status: 'cancelled', base: 'base' }, unmergedWip).state, 'cancelled_unmerged');
});
