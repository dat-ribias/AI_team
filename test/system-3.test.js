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

import { fixture, settle, approvalAgent, branchReady, branchCommit, branchTip, processAlive, previewFixture, parallelTeam, overlaps } from './system-helpers.js';

test('oracle: browser CLI argv, answer file and session are separate from logs', async () => {
  const prompt = 'Question with "quotes", & and Unicode: 日本語', args = ['--browser-manual-login', '--browser-manual-login-profile-dir', 'profile with spaces'];
  const script = `const fs = require('node:fs'), assert = require('node:assert/strict'), a = process.argv.slice(1);
    assert.deepEqual(a.slice(0, 2), ['--engine', 'browser']);
    assert.deepEqual(a.slice(2, 5), ${JSON.stringify(args)});
    assert.equal(a[a.indexOf('-p') + 1], ${JSON.stringify(prompt)});
    assert.equal(a[a.indexOf('--followup') + 1], 'parent-session');
    assert.equal(process.env.ORACLE_NO_DETACH, '1');
    assert(a.includes('--wait')); assert.equal(a[a.indexOf('--browser-archive') + 1], 'never');
    fs.writeFileSync(a[a.indexOf('--write-output') + 1], 'Answer only: 日本語', 'utf8');
    console.log('Session: child-session'); console.log('Preamble and timing logs');`;
  assert.deepEqual(await runOracle({ command: [process.execPath, '-e', script, '--'], args, prompt, followup: 'parent-session', timeoutMs: 5000 }), { answer: 'Answer only: 日本語', session: 'child-session' });
});

test('plan approval: assignment updates the gated hash, survives stale saves and uses the pinned member', async t => {
  const f = await fixture(), calls = [], team = new Team(f.config, f.data, { runAgent: async (...args) => { calls.push([args[1].stage, args[0].id]); return approvalAgent(...args); } }); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello', planApproval: true });
  const stale = await settle(team, job.id, 'waiting'), old = stale.plans.at(-1);
  await team.control(job.id, 'assign', { task: 0, agent: 'codex-4' });
  const assigned = team.get(job.id), p = assigned.plans.at(-1);
  assert.notEqual(p.hash, old.hash); assert.equal(assigned.planGate.hash, p.hash); assert.equal(p.tasks[0].agent, 'codex-4');
  await team.control(job.id, 'assign', { role: 'reviewer', agent: 'codex-3' });
  assert.equal(team.get(job.id).plans.at(-1).hash, p.hash, 'role overrides do not change the hash');
  team.save(stale);
  assert.equal(team.get(job.id).plans.at(-1).hash, p.hash); assert.equal(team.get(job.id).planGate.hash, p.hash);
  await assert.rejects(team.control(job.id, 'approve-plan', old), { message: msg('srv.team.plan_changed') });
  await team.control(job.id, 'approve-plan', p);
  const ready = await settle(team, job.id, 'ready');
  assert(calls.some(([stage, agent]) => stage === 'implement' && agent === 'codex-4'));
  await team.control(job.id, 'assign', { role: 'builder', from: 'codex-4', agent: 'codex-2' });
  assert.equal(team.get(job.id).plans.at(-1).hash, ready.plans.at(-1).hash, 'assignment outside the gate preserves history');
});

test('plan approval: feedback creates a new version; snapshots keep the latest 20 monotonic versions', async t => {
  const f = await fixture(), team = new Team(f.config, f.data, { runAgent: approvalAgent }); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello', planApproval: true });
  const waiting = await settle(team, job.id, 'waiting');
  const feedback = 'Please revise the greeting. '.repeat(12);
  const queued = await team.control(job.id, 'message', { message: feedback });
  assert.equal(queued.planGate, null);
  const revised = await settle(team, job.id, 'waiting'), p = revised.plans.at(-1);
  assert.equal(p.version, 2); assert.equal(p.reason, 'feedback'); assert.equal(p.trigger, feedback.trim().slice(0, 200));
  assert.equal(revised.planGate.version, 2); assert.notEqual(p.hash, waiting.plans[0].hash); assert.deepEqual(revised.plans[0], waiting.plans[0]);
  assert(!revised.reports.some(r => r.stage === 'implement'));
  for (let i = 0; i < 20; i++) team.recordPlan(revised);
  assert.equal(revised.plans.length, 20); assert.equal(revised.plans[0].version, 3); assert.equal(revised.plans.at(-1).version, 22);
  team.save(revised);
  const stale = team.get(job.id);
  await team.control(job.id, 'assign', { task: 0, agent: 'codex-4' });
  team.recordPlan(stale); team.save(stale);
  assert.equal(team.get(job.id).plans.at(-1).version, 23, 'a concurrent assignment cannot overwrite a new version when history is full');
});

test('controller archives implement and verify evidence under the checkpoint revision', async t => {
  const f = await fixture(); f.config.projects[0].evidence = ['.ai-team/custom'];
  const stages = [], team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    const report = await runAgent(agent, task, prompt, opts);
    if (task.stage === 'plan') report.rigor = 'strict';
    if (['implement', 'verify'].includes(task.stage)) {
      stages.push([task.stage, task.worktree]);
      assert(prompt.includes('Save evidence of your checks'));
      mkdirSync(join(task.worktree, '.ai-team/evidence'), { recursive: true });
      writeFileSync(join(task.worktree, '.ai-team/evidence', `${task.stage}.png`), Buffer.from([137, 80, 78, 71]));
      mkdirSync(join(task.worktree, '.ai-team/custom'), { recursive: true });
      writeFileSync(join(task.worktree, '.ai-team/custom', `${task.stage}.log`), 'checked');
    }
    return report;
  } }); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' }), ready = await settle(team, job.id, 'ready');
  assert.deepEqual(stages.map(s => s[0]), ['implement', 'verify']); assert.notEqual(stages[0][1], stages[1][1]);
  const items = team.evidence(job.id).items;
  const tracked = await run(['git'], ['-C', ready.worktree, 'ls-tree', '-r', '--name-only', ready.revision]);
  assert(!tracked.stdout.includes('.ai-team/'), 'evidence must remain git-ignored');
  for (const stage of ['implement', 'verify']) {
    const entry = items.find(e => e.stage === stage);
    assert.equal(entry.revision, ready.revision); assert(entry.dir.startsWith(ready.revision + '/'));
    assert(entry.files.some(f => f.path === `.ai-team/evidence/${stage}.png`));
    assert(entry.files.some(f => f.path === `.ai-team/custom/${stage}.log`));
    const file = team.evidenceFile(job.id, `${entry.dir}/.ai-team/evidence/${stage}.png`);
    assert.equal(file.type, 'image'); assert.equal(readFileSync(file.file).length, 4);
  }
  for (const rel of ['../outside', '..\\outside', f.path, 'C:relative', 'bad\0path']) assert.throws(() => team.evidenceFile(job.id, rel), /Unsafe evidence path/);
  const md = await team.exportJob(job.id); assert(md.includes('## Hồ sơ kiểm tra')); assert(md.includes('implement.png')); assert(md.includes('Controller chạy'));
});

test('evidenceMaxMB skips oversized artifacts without failing the job', async t => {
  const f = await fixture(); f.config.evidenceMaxMB = 0.00001;
  f.config.projects[0].tests[0][2] += "; console.log('controller test completed')";
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    const report = await runAgent(agent, task, prompt, opts);
    if (task.stage === 'implement') {
      mkdirSync(join(task.worktree, '.ai-team/evidence'), { recursive: true });
      writeFileSync(join(task.worktree, '.ai-team/evidence/large.log'), 'x'.repeat(100));
    }
    return report;
  } }); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' }), ready = await settle(team, job.id, 'ready');
  assert(ready.evidence.some(e => e.skipped.some(s => /size limit/.test(s.reason))));
  assert(ready.evidenceBytes <= f.config.evidenceMaxMB * 2 ** 20);
  assert.equal(ready.checkResults.at(-1).log, null);
});

test('Git authors: task checkpoints identify members and controller merges identify their work', async t => {
  // Three task checkpoints, merges and final checks need headroom for Git I/O under load.
  const { team, f } = await parallelTeam(t, [
    { title: 'Create first output', agent: 'codex-2', difficulty: 2, instruction: 'T1 edit', files: ['t1.txt'], dependsOn: [] },
    { agent: 'codex-4', difficulty: 2, instruction: 'T2 edit', files: ['t2.txt'], dependsOn: [] },
    { agent: 'codex-2', difficulty: 2, instruction: 'T3 edit', files: ['t3.txt'], dependsOn: [0, 1] },
  ]);
  team.config.agents.find(a => a.id === 'codex-2').label = 'Builder Two\nDisplay';
  team.start();
  const job = await team.create({ project: 'test', goal: 'Git attribution' }), ready = await settle(team, job.id, 'ready', 60000);
  const log = (await run(['git'], ['-C', ready.worktree, 'log', '--format=%an|%ae|%s'])).stdout;
  for (const [i, task] of ready.tasks.entries()) {
    const id = task.ranBy, label = team.agent(id).label.replace(/[\r\n]/g, ' ');
    assert(log.includes(`${label} (AI Team)|${id}@ai-team.local|${taskTitle(task)} (${label})`), log);
    if (i < 2) assert(log.includes(`AI Team controller|controller@ai-team.local|Merge: ${taskTitle(task)} (${label}) [#${job.id}]`), log);
  }
  // A job-level checkpoint uses the last builder even after a checker has run.
  writeFileSync(join(ready.worktree, 'followup.txt'), 'followup\n');
  await team.checkpoint(ready);
  assert.equal((await run(['git'], ['-C', ready.worktree, 'log', '-1', '--format=%an|%ae|%s'])).stdout.trim(),
    `Builder Two Display (AI Team)|codex-2@ai-team.local|${jobTitle(ready)} (Builder Two Display)`);
  ready.tested = ready.reviewed = ready.verified = ready.revision; team.save(ready);
  const target = { type: 'existing', branch: 'release' };
  await run(['git'], ['-C', f.path, 'branch', target.branch]); await branchCommit(f, target.branch);
  const prepared = await team.merge(job.id, { target }), pending = prepared.pendingMerge;
  assert(pending?.passed);
  assert.equal((await run(['git'], ['-C', f.path, 'log', '-1', '--format=%an|%ae|%s', pending.commit])).stdout.trim(),
    `AI Team controller|controller@ai-team.local|Merge: ${jobTitle(ready)} [#${job.id}]`);
  assert.equal((await run(['git'], ['-C', f.path, 'rev-list', '--parents', '-n', '1', pending.commit])).stdout.trim().split(' ').length, 3);
});

test('preview expires at ttl and revision changes invalidate acceptance and stop the server', { timeout: 60_000 }, async t => {
  const { team, job, pids } = await previewFixture(t);
  await team.runPreview(job);
  let fresh = team.get(job.id), pid = fresh.preview.pid; pids.add(pid);
  fresh.preview.expiresAt = new Date(Date.now() - 1).toISOString(); team.save(fresh); await team.tick();
  assert.equal(team.get(job.id).preview.stoppedReason, 'ttl'); assert(!processAlive(pid));
  await team.control(job.id, 'preview-start');
  fresh = team.get(job.id); pid = fresh.preview.pid; pids.add(pid);
  await team.control(job.id, 'accept', { revision: fresh.revision });
  fresh = team.get(job.id); fresh.revision = fresh.base; team.save(fresh); await team.tick();
  assert.equal(team.get(job.id).acceptance, null); assert.equal(team.get(job.id).preview.stoppedReason, 'revision'); assert(!processAlive(pid));
});

test('preview acceptance can be disabled and projects without preview retain merge behavior', { timeout: 60_000 }, async t => {
  const { team, job } = await previewFixture(t, { requireAcceptance: false });
  assert.equal((await team.mergeCheck(job.id)).acceptance.required, false); await team.merge(job.id);
  const plain = await branchReady(t); assert.equal((await plain.team.mergeCheck(plain.job.id)).acceptance.required, false); await plain.team.merge(plain.job.id);
});

test('update-ref CAS rejects a target move after the final target check', async t => {
  const { f, team, job } = await branchReady(t), target = { type: 'existing', branch: 'release' };
  await run(['git'], ['-C', f.path, 'branch', target.branch]);
  await team.mergeCheck(job.id, target);
  const original = team.mergeTarget.bind(team); let calls = 0, moved;
  team.mergeTarget = async (...args) => {
    const result = await original(...args);
    if (++calls === 2) moved = await branchCommit(f, target.branch);
    return result;
  };
  await assert.rejects(team.merge(job.id, { target }), /cannot lock ref|expected/);
  assert.equal(await branchTip(f, target.branch), moved); assert.equal(team.get(job.id).status, 'ready');
});

test('existing checkout fast-forwards cleanly and other worktree checkouts are refused', async t => {
  const { f, team, job } = await branchReady(t), target = { type: 'existing', branch: 'main' };
  assert.equal((await team.mergeCheck(job.id, target)).target.mode, 'ff');
  writeFileSync(join(f.path, 'dirty.txt'), 'dirty');
  await assert.rejects(team.merge(job.id, { target }), /commit/); rmSync(join(f.path, 'dirty.txt'));
  await run(['git'], ['-C', f.path, 'worktree', 'add', '-b', 'release', join(f.data, 'other-owner'), 'main']);
  await assert.rejects(team.merge(job.id, { target: { type: 'existing', branch: 'release' } }), /another worktree/);
  await team.merge(job.id, { target }); assert.equal(await branchTip(f), job.revision);
  assert.equal(readFileSync(join(f.path, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n'), 'Hello from AI Team demo!\n');
});

test('non-ff merge runs tests on its merge commit and needs a second exact owner approval', async t => {
  for (const checkedOut of [false, true]) {
    const { f, team, job } = await branchReady(t), target = { type: 'existing', branch: checkedOut ? 'main' : 'release' };
    if (!checkedOut) await run(['git'], ['-C', f.path, 'branch', target.branch]);
    const tip = await branchCommit(f, target.branch);
    if (checkedOut) await run(['git'], ['-C', f.path, 'reset', '--hard', tip]);
    const worktrees = (await run(['git'], ['-C', f.path, 'worktree', 'list', '--porcelain'])).stdout;
    assert.equal((await team.mergeCheck(job.id, target)).target.mode, 'merge');
    const prepared = await team.merge(job.id, { target }), pending = prepared.pendingMerge;
    assert.equal(prepared.status, 'ready'); assert(pending.passed); assert.equal(await branchTip(f, target.branch), tip);
    const parents = (await run(['git'], ['-C', f.path, 'rev-list', '--parents', '-n', '1', pending.commit])).stdout.trim().split(' ');
    assert.deepEqual(parents, [pending.commit, tip, job.revision]);
    assert(prepared.checkResults.some(r => r.revision === pending.commit && r.code === 0 && r.log));
    assert.equal((await run(['git'], ['-C', f.path, 'worktree', 'list', '--porcelain'])).stdout, worktrees);
    const check = await team.mergeCheck(job.id, target); assert(check.pendingMerge.diff.includes('hello.txt')); assert(check.checks.baseUnchanged);
    assert.equal((await team.mergeCheck(job.id, { type: 'new', branch: 'another-target' })).pendingMerge, null);
    assert(team.events(job.id).some(e => e.type === 'MERGE_PENDING'));
    await assert.rejects(team.merge(job.id, { target }), /exact pending/);
    await assert.rejects(team.merge(job.id, { target, approveMerge: job.revision }), /exact pending/);
    assert.equal(await branchTip(f, target.branch), tip);
    await team.merge(job.id, { target, approveMerge: pending.commit });
    assert.equal(await branchTip(f, target.branch), pending.commit); assert.equal(team.get(job.id).mergedInto.mode, 'merge');
    if (checkedOut) assert.equal(readFileSync(join(f.path, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n'), 'Hello from AI Team demo!\n');
  }
});

test('linked repositories reject another base and non-base merge targets', async t => {
  const f = await fixture(), linked = await fixture();
  f.config.projects.push({ ...linked.config.projects[0], id: 'linked' });
  f.config.projects[0].access = { repos: [{ project: 'linked', members: ['codex-2'] }] };
  await run(['git'], ['-C', f.path, 'branch', 'release']);
  const team = new Team(f.config, f.data); team.closed = true; t.after(() => team.close());
  await assert.rejects(team.create({ project: 'test', goal: 'x', baseBranch: 'release', paused: true }), /not supported/);
  const job = await team.create({ project: 'test', goal: 'x', paused: true });
  Object.assign(job, { status: 'ready', tested: job.revision, reviewed: job.revision, verified: job.revision }); team.save(job);
  for (const type of ['existing', 'new']) {
    const target = { type, branch: type === 'new' ? 'brand-new' : 'release' };
    assert.match((await team.mergeCheck(job.id, target)).target.error, /not supported/);
    await assert.rejects(team.merge(job.id, { target }), /not supported/);
  }
  assert.equal(await branchTip(f), job.base);
});

test('a builder who is also the verifier keeps the task the Lead gave them; verify moves to someone else', async t => {
  const f = await fixture(); f.config.pipeline.builders = ['codex-2', 'codex-3'];
  const team = new Team(f.config, f.data); team.closed = true; t.after(() => team.close());
  const job = team.get((await team.create({ project: 'test', goal: 'Update hello', paused: true })).id);
  assert.equal(team.chooseBuilder(job, { agent: 'codex-3', difficulty: 1, instruction: 'a' }), 'codex-3');
  assert.notEqual(team.checker({ ...job, implementers: ['codex-3'] }, 'verifier', job.roster, ['codex-3'], undefined, false), 'codex-3');
});

test('pause cancels process; resume retains work; new guidance invalidates ready approval', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Demo pause' });
  while (!team.active) await new Promise(r => setTimeout(r, 10));
  await team.control(job.id, 'pause');
  await settle(team, job.id, 'paused');
  await team.control(job.id, 'reassign', { agent: 'codex-4' });
  await team.control(job.id, 'message', { message: 'Keep changes minimal' }); // chat vào task đã dừng = tự chạy tiếp
  await settle(team, job.id, 'ready');
  assert(team.events(job.id).some(e => e.to === 'codex-4' && e.type === 'TASK_ASSIGNMENT'));
  await team.control(job.id, 'message', { message: 'New requirement' });
  assert.equal(team.get(job.id).status, 'queued'); assert.equal(team.get(job.id).reviewed, null);
  await assert.rejects(team.merge(job.id), /chưa sẵn sàng/);
  await settle(team, job.id, 'ready');
});

test('cancel during a mock agent run is terminal and idempotent; stale saves cannot resurrect it or alter the source repo', async t => {
  const sourceRefs = async () => Promise.all([['worktree', 'list', '--porcelain'], ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/ai-team']].map(async args => (await run(['git'], ['-C', process.cwd(), ...args])).stdout));
  const before = await sourceRefs(), f = await fixture();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const config = { demo: true, planApproval: false, maxRamPercent: 100, maxCpuPercent: 100,
    agents: [{ id: 'solo', label: 'solo', provider: 'mock' }],
    pipeline: { manager: 'solo', builders: ['solo'], reviewer: 'solo', verifier: 'solo' },
    projects: [{ id: 'test', path: f.path, tests: [] }],
  };
  const team = new Team(config, f.data, { runAgent: (agent, task, prompt, opts) => {
    entered(opts.signal); return runAgent(agent, task, prompt, opts);
  } });
  t.after(async () => { await team.close(); rmSync(f.data, { recursive: true, force: true }); rmSync(f.path, { recursive: true, force: true }); });
  team.save({ id: 'cancel-test', project: 'test', goal: 'Update hello', status: 'queued', stage: 'plan',
    worktree: f.path, tasks: [], taskIndex: 0, reports: [], messages: [], round: 0 });
  const running = team.tick(), signal = await started;
  const stale = team.get('cancel-test');
  assert.equal(stale.status, 'running'); assert.equal(stale.current.agent, 'solo');
  const cancelled = await team.control(stale.id, 'cancel');
  assert.equal(signal.aborted, true); assert.equal(signal.reason.name, 'AbortError');
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.error, null); assert.equal(cancelled.current, null);
  const events = team.events(stale.id);
  assert.deepEqual(await team.control(stale.id, 'cancel'), cancelled);
  assert.deepEqual(team.events(stale.id), events);
  await running;
  for (const status of ['running', 'queued', 'ready', 'blocked', 'cancelled']) {
    team.save({ ...stale, status, error: 'Run interrupted' });
    assert.deepEqual(team.get(stale.id), cancelled);
  }
  assert.equal(team.active, null);
  assert(!team.events(stale.id).some(e => e.type === 'BLOCKER' || /Run interrupted/.test(e.summary)));
  // Deleting a finished job removes its log; repeated deletion is idempotent.
  await team.control(stale.id, 'delete');
  assert.throws(() => team.get(stale.id)); assert.equal(team.events(stale.id).length, 0);
  assert.deepEqual(await team.control(stale.id, 'delete'), { id: stale.id, deleted: true });
  // Xóa phiên: từ chối khi còn việc đang chạy; không thì xóa cả việc trong phiên.
  const ses = team.createSession({ project: 'test', name: 'tmp' });
  team.save({ ...stale, id: 'ses-job', sessionId: ses.id, status: 'running' });
  await assert.rejects(team.deleteSession(ses.id));
  team.save({ ...team.get('ses-job'), status: 'done' });
  assert.equal((await team.deleteSession(ses.id)).jobs, 1);
  assert.throws(() => team.get('ses-job')); assert(!team.sessions().some(x => x.id === ses.id));
  assert.deepEqual(await sourceRefs(), before);
});

test('cancel wins concurrent sync and review saves', async t => {
  for (const action of ['sync', 'review']) {
    const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
    const job = await team.create({ project: 'test', goal: 'Update hello' });
    await settle(team, job.id, 'ready');
    if (action === 'sync') {
      writeFileSync(join(f.path, 'other.txt'), 'x\n');
      await run(['git'], ['-C', f.path, 'add', '.']);
      await run(['git'], ['-C', f.path, '-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-m', 'other']);
    }
    const pending = team.control(job.id, action);
    const cancelled = await team.control(job.id, 'cancel');
    assert.deepEqual(await pending, cancelled);
    assert.deepEqual(team.get(job.id), cancelled);
    assert.deepEqual(await team.control(job.id, 'cancel'), cancelled);
  }
});

test('hard task is rerouted to a capable builder; checker cannot review own code', async t => {
  const f = await fixture();
  f.config.agents.find(a => a.id === 'codex-2').tier = 'weak';
  f.config.agents.find(a => a.id === 'codex-4').tier = 'strong';
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'hard change' });
  const ready = await settle(team, job.id, 'ready');
  assert.equal(ready.tasks[0].difficulty, 4); assert.equal(ready.tasks[0].ranBy, 'codex-4');
  assert(team.events(job.id).some(e => e.type === 'REROUTE' && e.details.chosen === 'codex-4'));
  const plan = team.events(job.id).find(e => e.type === 'TASK_ASSIGNMENT' && e.details?.stage === 'plan');
  assert.match(plan.details.prompt, /maxDifficulty/);
});

test('lead asks clarifying questions and waits; the answer resumes planning', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'hỏi lại: sửa trang' });
  const waiting = await settle(team, job.id, 'waiting');
  assert.equal(waiting.questions.length, 1); assert.equal(waiting.tasks.length, 0);
  assert(team.events(job.id).some(e => e.type === 'QUESTION' && e.to === 'user'));
  await team.control(job.id, 'message', { message: 'Trang hello.txt' });
  await settle(team, job.id, 'ready');
});

test('review/verify run the project checks themselves in a detached worktree', async t => {
  for (const [provider, shell] of [['codex', true], ['claude', true], ['claude', false]]) {
    const f = await fixture(); f.config.demo = false;
    f.config.pipeline.builders = ['codex-2'];
    f.config.agents = f.config.agents.map(a => ({ ...a, provider: a.id === 'codex-2' ? provider : 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) }));
    f.config.projects[0].access = { shell: shell ? ['*'] : f.config.agents.filter(a => a.id !== 'codex-2').map(a => a.id) };
    const seen = [];
    const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
      seen.push({ agent: agent.id, provider: agent.provider, stage: task.stage, checks: task.checks, worktree: task.worktree, prompt });
      if (['review', 'verify'].includes(task.stage)) assert.equal((await run(['git'], ['-C', task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'HEAD');
      if (task.stage === 'review') writeFileSync(join(task.worktree, 'coverage.tmp'), 'x'); // check sinh file tạm: không được chặn
      const report = await runAgent({ ...agent, provider: 'mock' }, task, prompt, opts);
      if (task.stage === 'plan') report.flow = { steps: ['review', 'verify'] };
      return report;
    }, readQuota: async () => ({ buckets: [] }) });
    t.after(() => team.close());
    const job = await team.create({ project: 'test', goal: 'Update hello' });
    const ready = await settle(team, job.id, 'ready');
    for (const stage of ['review', 'verify']) {
      const checker = seen.find(s => s.stage === stage);
      assert(checker, `${provider}: missing ${stage}`);
      assert.deepEqual(checker.checks, f.config.projects[0].tests);
      assert.notEqual(checker.worktree, ready.worktree);
      assert.match(checker.prompt, /Run the commands in "checks" yourself/);
    }
    const impl = seen.find(s => s.stage === 'implement' && s.agent === 'codex-2' && s.provider === provider);
    assert(impl, `missing ${provider} builder`);
    if (provider === 'codex') assert.deepEqual(impl.checks, []);
    else assert.deepEqual(impl.checks, shell ? f.config.projects[0].tests : []);
    t.diagnostic(JSON.stringify({ provider, shell, calls: seen.map(({ agent, provider, stage, checks }) => ({ agent, provider, stage, checks })) }));
  }
});

test('structured rebuttal: a rejected finding becomes a dispute that forces verify; unresolved high findings go to the human', async t => {
  // Rework, dispute verification and escalation each run a full mock pipeline.
  const f = await fixture(); const seen = [];
  const finding = { id: 'F1', claim: 'Thiếu xử lý file rỗng', failsWhen: 'hello.txt rỗng', check: 'chạy test với file rỗng', impact: 'high' };
  let reviews = 0;
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    seen.push({ stage: task.stage, prompt });
    const r = await runAgent(agent, task, prompt, opts);
    if (task.stage === 'review' && reviews++ === 0) return { ...r, verdict: 'changes_requested', findings: [finding] };
    if (task.stage === 'implement' && task.round) return { ...r, responses: [{ finding: 'F1', action: 'rejected', evidence: 'test hiện có đã phủ file rỗng (test/x:12)' }] };
    if (task.stage === 'verify') return { ...r, rulings: [{ finding: 'F1', upheld: false, evidence: 'đã chạy test, pass' }] };
    return r;
  } });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  // This rework/dispute pipeline can still be verifying at 20s under controller load.
  const ready = await settle(team, job.id, 'ready', 60_000);
  const verify = seen.find(x => x.stage === 'verify');
  assert(verify, 'verify phải bị ép chạy vì có tranh chấp (rigor standard, không có cổng rủi ro)');
  assert.match(verify.prompt, /"disputes"/); assert.match(verify.prompt, /đã phủ file rỗng/);
  const ev = team.events(job.id); assert(ev.some(e => e.type === 'DISPUTE')); assert(ev.some(e => e.type === 'RULING'));
  assert.deepEqual(ready.disputes, []);
  // Hết vòng sửa mà reviewer vẫn giữ finding mức high → chờ người quyết, không BLOCKED mù.
  const g = await fixture(); g.config.maxReworkRounds = 0;
  const team2 = new Team(g.config, g.data, { runAgent: async (agent, task, prompt, opts) => {
    const r = await runAgent(agent, task, prompt, opts);
    return task.stage === 'review' ? { ...r, verdict: 'changes_requested', findings: [finding] } : r;
  } });
  t.after(() => team2.close());
  const j2 = await team2.create({ project: 'test', goal: 'Update hello' });
  const waiting = await settle(team2, j2.id, 'waiting', 60000);
  assert.match(waiting.questions[0], /F1: Thiếu xử lý file rỗng/);
});

test('per-member MCP config is validated and limited to Codex/Claude', async t => {
  const f = await fixture();
  const team = new Team({ ...f.config, demo: false, agents: [{ id: 'c', label: 'c', provider: 'claude', home: mkdtempSync(join(tmpdir(), 'h-')) }, { id: 'g', label: 'g', provider: 'antigravity' }], pipeline: {} }, f.data); t.after(() => team.close());
  const { Accounts } = await import('../src/accounts.js');
  const file = join(f.data, 'cfg.json'); writeFileSync(file, '{}');
  const accounts = new Accounts(team, file, process.cwd(), { commandAvailable: () => true }); t.after(() => accounts.close());
  assert.throws(() => accounts.profile('c', { mcp: '{bad' }), /MCP/);
  accounts.profile('c', { mcp: '{"gitnexus": {"command": "npx", "args": ["-y", "gitnexus", "mcp"]}}' });
  assert.deepEqual(team.agent('c').mcp.gitnexus.args, ['-y', 'gitnexus', 'mcp']);
  assert.deepEqual(team.members(['c'])[0].mcpServers, ['gitnexus']);
  assert.throws(() => accounts.profile('g', { mcp: { x: { command: 'y' } } }), /Codex|Claude/);
});

test('chat sessions per project; fast path picks the strongest member', async t => {
  const f = await fixture();
  f.config.agents.find(a => a.id === 'codex-2').tier = 'weak'; f.config.agents.find(a => a.id === 'codex-4').tier = 'strong';
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const s = team.createSession({ project: 'test', name: 'UI' });
  const job = await team.create({ project: 'test', goal: 'Update hello text', mode: 'fast', sessionId: s.id });
  const ready = await settle(team, job.id, 'ready');
  assert.equal(ready.sessionId, s.id); assert.equal(ready.tasks[0].ranBy, 'codex-4');
  const other = await team.create({ project: 'test', goal: 'x', mode: 'full' });
  assert.notEqual(other.sessionId, undefined);
  team.renameSession(s.id, 'UI work'); assert(team.state().sessions.some(x => x.name === 'UI work'));
});

test('busy strong builder: weak one takes the task only when it finishes sooner', async t => {
  const f = await fixture();
  f.config.agents.find(a => a.id === 'codex-2').tier = 'strong';
  f.config.agents.find(a => a.id === 'codex-4').tier = 'normal';
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'x' });
  const task = { agent: 'codex-2', difficulty: 3, instruction: 'x', estMinutes: 10 };
  assert.equal(team.pickBuilder(job, { ...task }), 'codex-2'); // strong and free
  team.remainingMinutes = () => 30;
  assert.equal(team.pickBuilder(job, { ...task }, new Set(['codex-2'])), 'codex-4'); // waiting 30+10 > 10
  team.remainingMinutes = () => 1; team.factor = id => id === 'codex-4' ? 3 : 1;
  assert.equal(team.pickBuilder(job, { ...task }, new Set(['codex-2'])), null); // waiting 1+10 < 30 → wait
  assert.equal(team.pickBuilder(job, { ...task, difficulty: 5 }, new Set(['codex-2'])), null); // beyond weaker member
});

test('per-project access: folders and Internet per member; Leader proposes a draft that the owner saves', async t => {
  const f = await fixture();
  const agents = [{ id: 'lead', label: 'L', provider: 'mock' }, { id: 'b1', label: 'B1', provider: 'mock' }, { id: 'b2', label: 'B2', provider: 'mock' }];
  const docs = mkdtempSync(join(tmpdir(), 'docs-')), spec = mkdtempSync(join(tmpdir(), 'spec-'));
  let seen;
  const team = new Team({ ...f.config, agents, pipeline: { manager: 'lead', builders: ['b1', 'b2'], reviewer: 'lead', verifier: 'lead' } }, f.data, { runAgent: async (agent, task, prompt) => {
    seen = { agent: agent.id, readDirs: task.readDirs, prompt };
    return { summary: 'ok', status: 'completed', folders: [{ path: docs, members: ['b1', 'ghost'], why: 'API spec' }, { path: join(docs, 'missing'), members: ['*'] }], network: { members: ['b2'], why: 'npm docs' }, notes: ['check spec'] };
  } });
  t.after(() => team.close());
  const { Accounts } = await import('../src/accounts.js');
  const file = join(f.data, 'cfg.json'); writeFileSync(file, '{}');
  const accounts = new Accounts(team, file, process.cwd(), { commandAvailable: () => true }); t.after(() => accounts.close());
  const pid = f.config.projects[0].id;
  // Cấu hình cũ (readDirs cho mọi người) vẫn hiểu được; sửa bằng ô cũ thì chuyển sang access mà giữ quyền riêng.
  accounts.updateProject(pid, { readDirs: spec, network: false });
  assert.deepEqual(team.accessFor(pid, 'b2'), { readDirs: [spec], network: false, shell: true, delete: true, paths: [] });
  // Leader đề xuất: được đọc các thư mục ứng viên; bản nháp bỏ member/thư mục không có thật; chưa lưu gì.
  const r = await team.proposeAccess(pid, [docs]);
  assert.equal(seen.agent, 'lead'); assert(seen.readDirs.includes(docs)); assert.match(seen.prompt, /least privilege/);
  assert.deepEqual(r.draft, { folders: [{ path: docs, members: ['b1'], why: 'API spec' }], network: ['b2'], repos: [], paths: [], shell: ['*'] });
  assert.deepEqual(team.accessFor(pid, 'b1').readDirs, [spec]);
  // Bạn lưu: mỗi member chỉ thấy đúng thư mục/mạng được cấp.
  accounts.setAccess(pid, { folders: [...r.draft.folders, { path: spec, members: ['*'] }], network: r.draft.network });
  assert.deepEqual(team.accessFor(pid, 'b1').readDirs, [docs, spec]); assert.equal(team.accessFor(pid, 'b1').network, false);
  assert.equal(team.accessFor(pid, 'b2').network, true);
  assert.throws(() => accounts.setAccess(pid, { folders: [{ path: docs, members: ['ghost'] }] }), /ghost/);
  assert.throws(() => accounts.setAccess(pid, { folders: [{ path: join(docs, 'missing'), members: ['*'] }] }));
  assert.deepEqual(team.state().projects.find(p => p.id === pid).access.network, ['b2']);
});

test('peer dialogue releases the only slot, carries unfinished code, and keeps independent review gates', async t => {
  const f = await fixture(), seen = [];
  f.config.projects[0].access = { folders: [{ path: f.path, members: ['codex-2', 'codex-4'] }, { path: f.data, members: ['codex-4'] }], network: ['codex-4'], shell: ['*'] };
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    seen.push([agent.id, task.stage]); assert.equal(team.slotKeys().length, 1);
    const discussion = task.discussions?.at(-1);
    if (task.stage === 'implement') {
      if (!discussion) {
        writeFileSync(join(task.worktree, 'hello.txt'), 'incorrect assumption\n');
        writeFileSync(join(task.worktree, 'partial.txt'), 'unfinished evidence\n');
        return { summary: 'Need the expected greeting', status: 'waiting_for_reply', peerRequest: { to: 'codex-4', topic: 'Greeting contract', claim: 'Use an arbitrary greeting', question: 'What exact greeting does the test require?', evidence: ['hello.txt:1'] }, checkpoint: { done: 'Drafted greeting', remaining: 'Confirm contract', next: 'Ask codex-4' } };
      }
      assert(prompt.includes('The assertion requires Hello from AI Team demo!'));
      assert(prompt.includes('Drafted greeting')); assert(!task.tasks[0].done);
      writeFileSync(join(task.worktree, 'hello.txt'), 'Hello from AI Team demo!\n');
      return { summary: 'Corrected the assumption', status: 'completed', dialogueDecision: { thread: discussion.id, outcome: 'accepted', reason: 'Used the assertion as the contract', evidence: ['configured test assertion'] } };
    }
    if (task.stage === 'consult') {
      assert.equal(task.network, false); assert.equal(task.researchWeb, false); assert.deepEqual(task.checks, []);
      assert(!task.readDirs.includes(f.data)); assert.notEqual(task.worktree, task.tasks[0]?.worktree || team.get(task.id).worktree);
      if (discussion.stage === 'implement') {
        assert.equal(agent.id, 'codex-4'); assert(prompt.includes('What exact greeting does the test require?'));
        assert.equal(readFileSync(join(task.worktree, 'partial.txt'), 'utf8'), 'unfinished evidence\n');
        assert.equal(readFileSync(join(task.worktree, 'hello.txt'), 'utf8'), 'incorrect assumption\n');
        return { summary: 'Contract evidence', status: 'completed', stance: 'disagree', answer: 'The assertion requires Hello from AI Team demo!', evidence: ['configured test assertion'] };
      }
      assert.equal(agent.id, 'codex-2'); assert(prompt.includes('Explain why the greeting changed'));
      return { summary: 'Author explanation', status: 'completed', stance: 'answer', answer: 'Changed it to satisfy the configured assertion', evidence: ['hello.txt:1'] };
    }
    if (task.stage === 'review') {
      if (discussion?.stage !== 'review') return { summary: 'Ask the author', status: 'waiting_for_reply', peerRequest: { to: 'codex-2', topic: 'Author explanation', claim: 'Greeting change is necessary', question: 'Explain why the greeting changed', evidence: ['hello.txt:1'] } };
      assert(prompt.includes('Changed it to satisfy the configured assertion'));
      assert.equal(task.tested, task.revision);
      const report = await runAgent(agent, task, prompt, opts);
      return { ...report, dialogueDecision: { thread: discussion.id, outcome: 'accepted', reason: 'Reviewed the diff and test evidence independently', evidence: ['hello.txt:1'] } };
    }
    return runAgent(agent, task, prompt, opts);
  } });
  team.capacity = () => ({ start: team.runs.size ? 0 : 1, hardStop: false }); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello with a peer question' });
  const ready = await settle(team, job.id, 'ready', 40000);
  assert.equal(ready.discussions.length, 2); assert(ready.discussions.every(d => d.status === 'resolved' && d.messages.length === 2));
  assert.equal(ready.tasks[0].done, true); assert.equal(ready.reviewed, ready.revision); assert.equal(ready.tested, ready.revision);
  assert.equal(ready.metrics.peerQuestions, 2); assert.equal(ready.metrics.peerReplies, 2); assert.equal(ready.metrics.peerResolved, 2);
  assert.equal(seen.filter(([, s]) => s === 'plan').length, 1); assert.equal(seen.filter(([, s]) => s === 'consult').length, 2);
  assert.equal(team.useOf('codex-2'), 0); assert.equal(team.memoryReaders.size, 0);
  assert.equal(readFileSync(join(f.path, 'hello.txt'), 'utf8'), 'Hello!\n');
  const md = await team.exportJob(job.id); assert(md.includes('## Đối thoại theo vấn đề')); assert(md.includes('What exact greeting does the test require?'));
  assert(!team.memory('test').facts.some(m => m.text.includes('What exact greeting')));
  await team.merge(job.id); assert.equal(team.get(job.id).status, 'merged');
});

test('job title: create validates, lead title never overrides owner title, rename, legacy fallback', async t => {
  const { autoTitle, jobTitle } = await import('../src/team.js');
  const f = await fixture();
  let planStarted, releasePlan;
  const started = new Promise(resolve => { planStarted = resolve; });
  const released = new Promise(resolve => { releasePlan = resolve; });
  const team = new Team(f.config, f.data, { runAgent: async (...args) => {
    if (args[1].stage === 'plan' && args[1].goal === 'Rename during plan') { planStarted(); await released; }
    const report = await approvalAgent(...args);
    return args[1].stage === 'plan' ? { ...report, title: '  Lead   T  ' } : report;
  } }); t.after(() => team.close());
  const input = { project: 'test', goal: 'First line\nFull goal details', paused: true, planApproval: true };
  for (const title of ['', '   ', 'x'.repeat(61), 123, null]) {
    await assert.rejects(team.create({ ...input, title }), { message: msg('srv.team.title_invalid') });
  }
  const owner = await team.create({ ...input, title: 'Abc' });
  assert.equal(owner.title, 'Abc'); assert.equal(owner.titleBy, 'user');
  const auto = await team.create(input);
  assert.equal(auto.title, 'First line'); assert.equal(auto.titleBy, 'auto');
  assert.equal(autoTitle('\n  First   line \nDetails'), 'First line');
  assert.equal(autoTitle('x'.repeat(61)), 'x'.repeat(59) + '…');
  assert.equal(autoTitle('x'.repeat(60)), 'x'.repeat(60));
  for (const end of ['. ', '。', '!', '?']) assert.equal(autoTitle('First' + end + 'x'.repeat(80)), 'First' + end.trim());
  assert.equal(autoTitle('x'.repeat(60) + '! more'), 'x'.repeat(59) + '…');
  await team.control(auto.id, 'resume');
  const planned = await settle(team, auto.id, 'waiting');
  assert.equal(planned.title, 'Lead T'); assert.equal(planned.titleBy, 'lead');
  await team.control(owner.id, 'resume');
  const ownerPlanned = await settle(team, owner.id, 'waiting');
  assert.equal(ownerPlanned.title, 'Abc'); assert.equal(ownerPlanned.titleBy, 'user');
  for (const title of ['', 'x'.repeat(61), 123]) {
    await assert.rejects(team.control(auto.id, 'rename', { title }), { message: msg('srv.team.title_invalid') });
  }
  const renamed = await team.control(auto.id, 'rename', { title: '  Owner   title  ' });
  assert.equal(renamed.title, 'Owner title'); assert.equal(renamed.titleBy, 'user');
  assert.equal(team.get(auto.id).title, 'Owner title');
  assert(team.events(auto.id).some(e => e.type === 'CONTROL' && e.from === 'user' && e.to === 'team' && e.summary === msg('srv.team.renamed', { 0: 'Owner title' })));
  team.save(planned);
  assert.equal(team.get(auto.id).title, 'Owner title', 'stale saves preserve the owner title');
  for (const status of ['running', 'merging', 'done', 'merged', 'cancelled']) {
    const job = team.get(auto.id); job.status = status; team.save(job);
    const title = 'Renamed ' + status;
    assert.equal((await team.control(auto.id, 'rename', { title })).title, title);
    assert.equal(team.get(auto.id).title, title); assert.equal(team.get(auto.id).status, status);
  }
  const legacy = team.get(owner.id); delete legacy.title; delete legacy.titleBy;
  team.db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
  assert.equal(jobTitle(legacy), 'First line');
  assert.equal(team.state().jobs.find(j => j.id === legacy.id).title, 'First line');
  assert.equal(team.get(legacy.id).title, undefined, 'state fallback does not migrate old jobs');
  const duringPlan = await team.create({ ...input, goal: 'Rename during plan', paused: false });
  await started;
  await team.control(duringPlan.id, 'rename', { title: 'Owner during plan' });
  releasePlan();
  const afterPlan = await settle(team, duringPlan.id, 'waiting');
  assert.equal(afterPlan.title, 'Owner during plan'); assert.equal(afterPlan.titleBy, 'user');
  const exported = await team.exportJob(owner.id);
  assert(exported.includes('# First line')); assert(exported.includes('## Mục tiêu\n\n' + legacy.goal));
});
