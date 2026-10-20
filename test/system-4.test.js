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

test('oracle: config defaults and invalid account/settings types', async () => {
  const f = await fixture(), config = validateConfig(f.config);
  assert.equal(config.oracle.enabled, false); assert.equal(config.oracle.timeoutMin, 10); assert.equal(config.oracle.maxPerJob, 3);
  assert(Array.isArray(config.oracle.command)); assert.equal(config.oracle.accounts.length, 1);
  for (const oracle of [null, [], { enabled: 'yes' }, { command: 'oracle' }, { command: [] }, { accounts: [] },
    { accounts: [{ id: 'one', args: [] }, { id: 'two', args: [] }, { id: 'three', args: [] }] },
    { accounts: [{ id: 'one', args: [] }, { id: 'one', args: [] }] }, { accounts: [{ id: 'one', args: 'profile' }] },
    { timeoutMin: 0 }, { timeoutMin: Infinity }, { maxPerJob: 1.5 }, { maxPerJob: 0 }]) {
    assert.throws(() => validateConfig({ ...f.config, oracle }), /oracle/);
  }
});

test('oracle: per-job limit and malformed consult make one final planning call', async t => {
  for (const question of ['Opinion?', null]) {
    const f = await fixture(); f.config.oracle = { enabled: true, maxPerJob: 1 }; f.config.peerDialogue = false;
    let calls = 0, plans = 0;
    const team = new Team(f.config, f.data, { runOracle: async () => { calls++; return { answer: 'opinion', session: 'one' }; }, runAgent: async (...args) => {
      if (args[1].stage === 'plan') {
        plans++;
        if (!args[1].oracle?.unavailable) return { status: 'consult', consult: { question } };
        assert(!args[2].includes('return status "consult"'));
      }
      return approvalAgent(...args);
    } }); t.after(() => team.close());
    const job = await team.create({ project: 'test', goal: 'Update hello', planApproval: true }), waiting = await settle(team, job.id, 'waiting');
    assert.equal(waiting.stage, 'implement'); assert.equal(waiting.oracle.unavailable, true);
    assert.equal(calls, question ? 1 : 0); assert.equal(plans, question ? 3 : 2);
  }
});

test('oracle: two concurrent jobs serialize on one account', async t => {
  const f = await fixture(); f.config.oracle = { enabled: true, accounts: [{ id: 'one', args: [] }] }; f.config.peerDialogue = false;
  let active = 0, maxActive = 0, calls = 0, releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const team = new Team(f.config, f.data, { runOracle: async () => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    try { if (calls === 1) await first; return { answer: 'opinion', session: 'one' }; } finally { active--; }
  }, runAgent: async (...args) => args[1].stage === 'plan' && !args[1].oracle?.turns.length
    ? { status: 'consult', consult: { question: 'Opinion?' } } : approvalAgent(...args) });
  t.after(async () => { releaseFirst(); await team.close(); });
  // Drive both plan steps directly so the Lead's own scheduler slot cannot hide a lock bug.
  const jobs = await Promise.all(['First', 'Second'].map(goal => team.create({ project: 'test', goal, paused: true, planApproval: true })));
  const running = jobs.map(job => { job.status = 'running'; team.runs.set(job.id, { agents: new Set(), abort: new AbortController() }); return job; });
  const steps = running.map(job => team.step(job));
  try {
    const deadline = Date.now() + 10000;
    while (team.events(jobs[0].id).filter(e => e.type === 'ORACLE_QUESTION').length + team.events(jobs[1].id).filter(e => e.type === 'ORACLE_QUESTION').length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 1); assert.equal(team.oracleLocks.size, 1);
    releaseFirst(); await Promise.all(steps);
    assert.equal(calls, 2); assert.equal(maxActive, 1); assert.equal(team.oracleLocks.size, 0);
    assert(running.every(job => job.stage === 'implement' && job.oracle.account === 'one'));
  } finally { releaseFirst(); await Promise.allSettled(steps); for (const job of jobs) team.runs.delete(job.id); }
});

test('plan approval: stale version/hash and invalid state are rejected; approval runs the saved plan', async t => {
  const f = await fixture(), team = new Team(f.config, f.data, { runAgent: approvalAgent }); t.after(() => team.close());
  for (const key of ['planApproval', 'planApprovalRework']) assert.throws(() => validateConfig({ ...f.config, [key]: 'yes' }), { message: msg('srv.team.plan_approval_invalid') });
  await assert.rejects(team.create({ project: 'test', goal: 'Update hello', planApproval: 'yes' }), { message: msg('srv.team.plan_approval_invalid') });
  const job = await team.create({ project: 'test', goal: 'Update hello', planApproval: true });
  const waiting = await settle(team, job.id, 'waiting'), p = waiting.plans.at(-1);
  await assert.rejects(team.control(job.id, 'approve-plan', { version: p.version, hash: 'stale' }), { message: msg('srv.team.plan_changed') });
  await assert.rejects(team.control(job.id, 'approve-plan', { version: p.version + 1, hash: p.hash }), { message: msg('srv.team.plan_changed') });
  team.runs.set(job.id, {});
  try { await assert.rejects(team.control(job.id, 'approve-plan', p), { message: msg('srv.team.plan_not_waiting') }); }
  finally { team.runs.delete(job.id); }
  const approved = await team.control(job.id, 'approve-plan', p);
  assert.equal(approved.stage, 'implement'); assert.equal(approved.taskIndex, waiting.taskIndex); assert.equal(approved.planGate, null);
  assert.deepEqual(approved.approvedPlan, { version: p.version, hash: p.hash, at: approved.plans[0].approvedAt, by: 'user' });
  assert.equal(approved.plans[0].approvedBy, 'user');
  const ready = await settle(team, job.id, 'ready');
  assert(ready.reports.some(r => r.stage === 'implement'));
  assert.deepEqual(ready.plans[0].tasks, p.tasks, 'execution does not mutate the snapshot');
  assert.equal(team.planBlocked({ ...ready, tasks: [...ready.tasks, { auto: true }] }), false);
  assert.deepEqual(team.events(job.id).find(e => e.type === 'PLAN_APPROVED').details, { version: p.version, hash: p.hash });
  await assert.rejects(team.control(job.id, 'approve-plan', p), { message: msg('srv.team.plan_not_waiting') });
});

test('plan approval: review rework waits again unless planApprovalRework is disabled', async t => {
  for (const reworkApproval of [true, false]) {
    const f = await fixture(); if (!reworkApproval) f.config.planApprovalRework = false;
    let reviews = 0;
    const team = new Team(f.config, f.data, { runAgent: async (...args) => {
      const r = await approvalAgent(...args);
      if (args[1].stage === 'review' && reviews++ === 0) return { ...r, verdict: 'changes_requested', findings: [{ id: 'F1', claim: 'Refine greeting', impact: 'medium' }] };
      return r;
    } }); t.after(() => team.close());
    const job = await team.create({ project: 'test', goal: 'Update hello', planApproval: true });
    const first = await settle(team, job.id, 'waiting');
    await team.control(job.id, 'approve-plan', first.plans.at(-1));
    const revised = await settle(team, job.id, reworkApproval ? 'waiting' : 'ready'), p = revised.plans.at(-1);
    assert.equal(p.version, 2); assert.equal(p.round, 1); assert.equal(p.reason, 'rework'); assert.equal(p.trigger, 'F1');
    assert.notEqual(p.hash, first.plans[0].hash); assert(revised.plans[0].approvedAt);
    if (reworkApproval) {
      assert.equal(revised.planGate.version, 2); assert(!revised.reports.slice(revised.reports.findLastIndex(r => r.stage === 'plan') + 1).some(r => r.stage === 'implement'));
      await team.control(job.id, 'approve-plan', p); await settle(team, job.id, 'ready');
    } else { assert.equal(revised.planGate, null); assert.equal(revised.approvedPlan.version, 1); }
  }
});

test('plan approval: restart preserves the waiting gate and history without dispatching work', async t => {
  const f = await fixture(); f.config.planApproval = true;
  const team = new Team(f.config, f.data, { runAgent: approvalAgent }); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const waiting = await settle(team, job.id, 'waiting');
  await team.close();
  let calls = 0;
  const reopened = new Team(f.config, f.data, { runAgent: (...args) => { calls++; return approvalAgent(...args); } }); t.after(() => reopened.close());
  await reopened.tick(); await new Promise(r => setTimeout(r, 50));
  const restored = reopened.get(job.id);
  assert.equal(restored.status, 'waiting'); assert.deepEqual(restored.planGate, waiting.planGate); assert.deepEqual(restored.plans, waiting.plans);
  assert.equal(calls, 0); assert(!restored.reports.some(r => r.stage === 'implement'));
});

test('evidence collection preserves paths, filters credentials and Git, and enforces the byte budget', async t => {
  const f = await fixture(), dest = join(f.data, 'archive');
  mkdirSync(join(f.path, '.ai-team/evidence'), { recursive: true });
  writeFileSync(join(f.path, '.ai-team/evidence/check.log'), 'passed');
  writeFileSync(join(f.path, '.ai-team/evidence/view.png'), Buffer.from([137, 80, 78, 71]));
  for (const name of ['.env', 'auth.json', 'controller.token', 'id_ed25519', 'test.key', 'credentials.json', 'my-secret.log', 'passwords.txt', 'access-token.json', 'auth.log']) writeFileSync(join(f.path, '.ai-team/evidence', name), 'dummy');
  const paths = ['.ai-team/evidence', '.git', '../outside', '..\\outside', f.path, 'C:relative', 'bad\0path'];
  const result = collect({ worktree: f.path, paths, dest, maxBytes: 100, exclude: new RegExp(defaultSensitive, 'i') });
  assert.equal(result.bytes, 10);
  assert.deepEqual(result.files.map(f => [f.path, f.type]), [['.ai-team/evidence/check.log', 'text'], ['.ai-team/evidence/view.png', 'image']]);
  assert.equal(readFileSync(join(dest, '.ai-team/evidence/check.log'), 'utf8'), 'passed');
  assert.equal(result.skipped.filter(f => f.reason === 'Credential file').length, 10);
  for (const name of ['passwords.txt', 'access-token.json', 'auth.log']) {
    assert(!result.files.some(f => f.path === `.ai-team/evidence/${name}`));
    assert(result.skipped.some(f => f.path === `.ai-team/evidence/${name}` && f.reason === 'Credential file'));
  }
  writeFileSync(join(f.path, '.ai-team/evidence/private-notes.md'), 'dummy');
  const custom = collect({ worktree: f.path, paths: ['.ai-team\\evidence\\private-notes.md'], dest: join(f.data, 'custom'), maxBytes: 100, exclude: /private-notes/i });
  assert.equal(custom.files.length, 0);
  assert.deepEqual(custom.skipped, [{ path: '.ai-team/evidence/private-notes.md', reason: 'Credential file' }]);
  mkdirSync(join(f.path, '.ai-team/evidence/private-notes'));
  writeFileSync(join(f.path, '.ai-team/evidence/private-notes/check.log'), 'dummy');
  const directory = collect({ worktree: f.path, paths: ['.ai-team\\evidence\\private-notes'], dest: join(f.data, 'directory'), maxBytes: 100, exclude: /private-notes/i });
  assert.equal(directory.files.length, 0);
  assert.deepEqual(directory.skipped, [{ path: '.ai-team/evidence/private-notes', reason: 'Credential file' }]);
  assert(result.skipped.some(f => f.reason === 'Git metadata'));
  assert.equal(result.skipped.filter(f => f.reason === 'Unsafe evidence path').length, 5);
  const limited = collect({ worktree: f.path, paths: ['.ai-team/evidence/check.log'], dest: join(f.data, 'limited'), maxBytes: 10, usedBytes: 5 });
  assert.equal(limited.bytes, 0); assert.equal(limited.files.length, 0); assert.match(limited.skipped[0].reason, /size limit/);
  for (const ext of ['png', 'JPG', 'jpeg', 'gif', 'webp']) assert.equal(kind(`f.${ext}`), 'image');
  for (const ext of ['log', 'txt', 'md', 'json', 'xml', 'csv']) assert.equal(kind(`f.${ext}`), 'text');
  assert.equal(kind('f.htm'), 'html'); assert.equal(kind('f.svg'), 'other');
  assert.equal(safeRel('checks\\view.png'), 'checks/view.png');
});

test('quota, structured reports, isolation, and shell-free prompts', async () => {
  const quota = normalizeCodexQuota({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1800000000 } }, rateLimitsByLimitId: { fast: { primary: { usedPercent: 60 }, secondary: { usedPercent: null } } } });
  assert.equal(quota[0].id, 'fast'); assert.equal(quota[0].windows[0].remaining, 40); assert.equal(quota[0].windows[1].remaining, null);
  assert.equal(normalizeCodexQuota({ rateLimits: { primary: { usedPercent: 120 } } })[0].windows[0].remaining, 0);
  assert.equal(normalizeGoogleQuota({ quota: { pro: { remaining_fraction: .4, reset_time: 'later' } } })[0].windows[0].remaining, 40);
  assert.deepEqual(normalizeGoogleQuota({ response: 'You have 80% left' }), []);
  assert.throws(() => parseReport('complete!')); assert.equal(parseReport('```json\n{"summary":"ok"}\n```').summary, 'ok');
  assert(!redact('secret sk-12345678901234567890').includes('12345678901234567890'));
  // redact chạy trên JSON đã stringify (scrub) không được làm hỏng JSON
  for (const v of ['api_key="k1"', "get('Authorization:\"x\"')"]) { const out = JSON.parse(redact(JSON.stringify(v))); assert(!out.includes('k1') && !out.includes(':"x')); }
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-secret';
  assert.equal(childEnv({ home: 'isolated' }).CODEX_HOME, 'isolated'); assert.equal(childEnv().OPENAI_API_KEY, undefined);
  if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  const input = 'x & echo hacked | $(whoami) `hello` "quoted"\nTiếng Việt';
  const output = await run([process.execPath, '-e', "process.stdin.pipe(process.stdout)"], [], { input });
  assert.equal(output.stdout, input);
  await assert.rejects(run([process.execPath, '-e', 'setInterval(()=>{},1000)'], [], { timeoutMs: 100 }), /timed out/);
  await assert.rejects(run(['fake.cmd'], []), /shell shim/);
});

test('real Git pipeline, exact revision approval, no implicit merge, persisted messages', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  assert(!(await run(['git'], ['-C', f.path, 'worktree', 'list'])).stdout.includes('-review-'), 'review worktree removed after its run');
  assert.equal(readFileSync(join(f.path, 'hello.txt'), 'utf8'), 'Hello!\n');
  assert.equal(ready.tested, ready.revision); assert.equal(ready.reviewed, ready.revision); assert.equal(ready.verified, null); assert(ready.skipped.includes('verify'));
  const events = team.events(job.id);
  for (const type of ['GOAL', 'DECISION', 'TASK_ASSIGNMENT', 'TEST_RESULT', 'REVIEW_RESULT', 'READY_FOR_MERGE']) assert(events.some(e => e.type === type), type);
  writeFileSync(join(ready.worktree, 'hello.txt'), 'tamper');
  await assert.rejects(team.merge(job.id), /Worktree/);
  writeFileSync(join(ready.worktree, 'hello.txt'), 'Hello from AI Team demo!\n');
  await team.merge(job.id);
  assert.equal(team.get(job.id).status, 'merged'); assert.equal(readFileSync(join(f.path, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n'), 'Hello from AI Team demo!\n');
  // Merge xong: không còn worktree (kể cả review) hay branch ai-team/* của việc; diff vẫn xem được từ branch đích.
  assert(!(await run(['git'], ['-C', f.path, 'worktree', 'list'])).stdout.includes(f.data), 'controller worktrees removed');
  assert.equal((await run(['git'], ['-C', f.path, 'branch', '--list', 'ai-team/*'])).stdout.trim(), '');
  assert.match((await team.diff(job.id)).diff, /Hello from AI Team demo/);
  await assert.rejects(team.merge(job.id), /chưa sẵn sàng/);
  await team.close();
  const reopened = new Team(f.config, f.data); assert.equal(reopened.get(job.id).status, 'merged'); assert(reopened.events(job.id).length > events.length); await reopened.close();
  // close is intentionally idempotent for shutdown after a manual close.
});

test('preview starts before/after, checks readyPath and stop kills the entire process tree', { timeout: 60_000 }, async t => {
  const { f, team, job, pids } = await previewFixture(t);
  team.previewChrome = findChrome;
  await team.runPreview(job);
  const preview = team.get(job.id).preview;
  assert.equal(preview.status, 'running'); assert.equal(preview.revision, job.revision); assert.equal(preview.basePid, undefined);
  assert.equal((await fetch(preview.url + '/ready')).status, 200);
  const processes = await (await fetch(preview.url + '/pid')).json(); pids.add(preview.pid);
  assert(processAlive(processes.pid)); assert(processAlive(processes.leaf));
  const trees = (await run(['git'], ['-C', f.path, 'worktree', 'list', '--porcelain'])).stdout;
  assert(!trees.includes('-preview-'));
  assert.equal(team.previews.size, 1);
  const entry = team.get(job.id).evidence.at(-1);
  if (findChrome()) {
    assert.deepEqual(entry.files.map(f => f.path), ['before-home-desktop.png', 'before-home-mobile.png', 'after-home-desktop.png', 'after-home-mobile.png']);
    mkdirSync('.ai-team/evidence', { recursive: true });
    for (const file of entry.files) writeFileSync(join('.ai-team/evidence', `backend-${file.path}`), readFileSync(team.evidenceFile(job.id, `${entry.dir}/${file.path}`).file));
  }
  await team.control(job.id, 'preview-stop');
  assert.equal(team.previews.size, 0); assert.equal(team.get(job.id).preview.stoppedReason, 'user');
  assert(!processAlive(preview.pid)); assert(!processAlive(processes.pid)); assert(!processAlive(processes.leaf));
  await team.control(job.id, 'preview-start');
  assert.equal(team.get(job.id).preview.status, 'running');
  const restarted = team.get(job.id).evidence.at(-1);
  assert(restarted.files.every(f => f.path.startsWith('after-')));
  await team.stopPreview(job.id, 'test');
});

test('preview feedback during startup is preserved and cancellation cannot resurrect the job', { timeout: 60_000 }, async t => {
  const { team, job } = await previewFixture(t);
  const launch = team.runPreview(job);
  await team.control(job.id, 'message', { message: 'Keep this feedback' }); await launch;
  assert.equal(team.get(job.id).messages.at(-1).text, 'Keep this feedback');
  await team.control(job.id, 'cancel');
  assert.equal(team.get(job.id).status, 'cancelled'); assert.equal(team.previews.size, 0); assert.equal(team.get(job.id).preview.stoppedReason, 'cancelled'); assert.equal(team.get(job.id).preview.pid, undefined);
});

test('merge creates a new branch only once and provides exact-revision evidence', async t => {
  const { f, team, job } = await branchReady(t), main = await branchTip(f), target = { type: 'new', branch: 'release/new' };
  job.checkResults.push({ revision: job.base, code: 0 }); job.reports.push({ stage: 'verify', revision: job.base, tests: 'stale' }); team.save(job);
  const check = await team.mergeCheck(job.id, target);
  assert.equal(check.target.mode, 'create'); assert.equal(check.target.tip, null);
  assert.equal(check.evidence.controllerTests.length, 1); assert.equal(check.evidence.aiChecks.length, 1);
  assert.equal(check.evidence.aiChecks[0].selfReported, true); assert.equal(check.evidence.warnNoControllerTest, false);
  assert(check.evidence.files.every(e => e.revision === job.revision));
  await team.merge(job.id, { target });
  assert.equal(await branchTip(f, target.branch), job.revision); assert.equal(await branchTip(f), main);
  assert.deepEqual(team.get(job.id).mergedInto, { branch: target.branch, commit: job.revision, mode: 'create' });
  assert.deepEqual(team.events(job.id).find(e => e.type === 'MERGED').details, team.get(job.id).mergedInto);
});

test('non-ff conflicts abort and remove only the temporary worktree without changing refs', async t => {
  const { f, team, job } = await branchReady(t), target = { type: 'existing', branch: 'release' };
  await run(['git'], ['-C', f.path, 'branch', target.branch]);
  const tip = await branchCommit(f, target.branch, 'hello.txt', 'Conflicting target\n');
  const before = (await run(['git'], ['-C', f.path, 'worktree', 'list', '--porcelain'])).stdout;
  await assert.rejects(team.merge(job.id, { target }), /Merge conflicts: hello.txt/);
  assert.equal(await branchTip(f, target.branch), tip); assert.equal(team.get(job.id).pendingMerge, null);
  assert.equal((await run(['git'], ['-C', f.path, 'worktree', 'list', '--porcelain'])).stdout, before);
});

test('failed merge-commit tests and test mutations never update the target', async t => {
  for (const mutate of [false, true]) {
    const { f, team, job } = await branchReady(t), target = { type: 'existing', branch: 'release' };
    await run(['git'], ['-C', f.path, 'branch', target.branch]); const tip = await branchCommit(f, target.branch);
    team.project('test').tests = [[process.execPath, '-e', mutate ? "require('node:fs').writeFileSync('hello.txt','tampered')" : 'process.exit(9)']];
    const before = (await run(['git'], ['-C', f.path, 'worktree', 'list', '--porcelain'])).stdout;
    if (mutate) {
      await assert.rejects(team.merge(job.id, { target }), /worktree/);
      assert.equal(team.get(job.id).pendingMerge, null);
    } else {
      await assert.rejects(team.merge(job.id, { target }), /tests failed/);
      const prepared = team.get(job.id); assert.equal(prepared.pendingMerge.passed, false);
      assert.equal(prepared.checkResults.at(-1).code, 9);
      assert.equal(prepared.stage, 'rework'); assert.equal(prepared.status, 'queued');
    }
    assert.equal(await branchTip(f, target.branch), tip);
    assert.equal((await run(['git'], ['-C', f.path, 'worktree', 'list', '--porcelain'])).stdout, before);
  }
});

test('pending approval expires when target tip or job revision changes', async t => {
  const { f, team, job } = await branchReady(t), target = { type: 'existing', branch: 'release' };
  await run(['git'], ['-C', f.path, 'branch', target.branch]); await branchCommit(f, target.branch);
  const pending = (await team.merge(job.id, { target })).pendingMerge;
  const moved = await branchCommit(f, target.branch, 'later.txt');
  await assert.rejects(team.merge(job.id, { target, approveMerge: pending.commit }), /stale/);
  assert.equal(team.get(job.id).pendingMerge, null); assert.equal(await branchTip(f, target.branch), moved);
  const prepared = await team.merge(job.id, { target }); assert(prepared.pendingMerge);
  prepared.revision = prepared.base; team.save(prepared); assert.equal(team.get(job.id).pendingMerge, null);
});

test('assign on the diagram changes only this job, survives role sync and stale saves, and the pinned builder is used', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); team.closed = true; t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello', paused: true });
  team.save({ ...team.get(job.id), stage: 'implement', tasks: [{ agent: 'codex-2', difficulty: 5, instruction: 'a' }, { agent: 'codex-2', difficulty: 1, instruction: 'b' }] });
  const stale = team.get(job.id);
  await team.control(job.id, 'assign', { task: 0, agent: 'codex-3' });
  await team.control(job.id, 'assign', { role: 'reviewer', agent: 'codex-1' });
  await assert.rejects(team.control(job.id, 'assign', { task: 0, agent: 'nobody' }));
  team.save(stale); team.syncRoster(); // bản cũ lưu đè + đổi vai trò chung: lựa chọn riêng vẫn còn
  const now = team.get(job.id);
  assert.deepEqual([now.tasks[0].agent, now.tasks[0].pinned, now.tasks[1].agent], ['codex-3', true, 'codex-2']);
  assert(now.roster.builders.includes('codex-3')); assert.equal(now.roster.reviewer, 'codex-1');
  assert(!team.config.pipeline.builders.includes('codex-3'), 'team roles unchanged');
  assert.equal(team.pickBuilder(now, now.tasks[0]), 'codex-3', 'pinned beats difficulty routing');
  assert.equal(team.pickBuilder(now, now.tasks[0], new Set(['codex-3'])), null, 'waits for the pinned member');
  assert.equal(team.checker(now, 'reviewer', now.roster, [], undefined, false), 'codex-1');
  await team.control(job.id, 'assign', { role: 'builder', from: 'codex-2', agent: 'codex-4' });
  assert.equal(team.get(job.id).tasks[1].agent, 'codex-4'); assert(!team.get(job.id).roster.builders.includes('codex-2'));
});

test('member system prompt reaches the agent; risky merge needs typed confirmation', async t => {
  const f = await fixture(); f.config.sensitivePaths = 'hello';
  f.config.agents.find(a => a.id === 'codex-2').systemPrompt = 'Luôn viết test trước.';
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  await settle(team, job.id, 'ready');
  assert(team.events(job.id).some(e => e.to === 'codex-2' && e.details?.prompt?.includes('Luôn viết test trước.')));
  const check = await team.mergeCheck(job.id);
  assert(check.needsConfirm); assert.equal(check.risk, 'high');
  await assert.rejects(team.merge(job.id), /Rủi ro cao/);
  await team.merge(job.id, { confirm: check.code });
  assert.equal(team.get(job.id).status, 'merged');
});

test('one member can hold every role; self-review forces typed merge confirmation', async t => {
  const f = await fixture();
  f.config.agents = [{ id: 'solo', label: 'solo', provider: 'mock' }];
  f.config.pipeline = { manager: 'solo', builders: ['solo'], reviewer: 'solo', verifier: 'solo' };
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  assert.equal(ready.risk, 'high');
  assert(team.events(job.id).some(e => e.type === 'WARNING'));
  const check = await team.mergeCheck(job.id);
  await assert.rejects(team.merge(job.id), /commit/);
  await team.merge(job.id, { confirm: check.code });
});

test('projects can be registered from the UI, including git init and "npm test"-style commands', async t => {
  const f = await fixture(), team = new Team({ ...f.config, demo: false, agents: [{ id: 'c', label: 'c', provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) }], pipeline: {} }, f.data); t.after(() => team.close());
  const { Accounts } = await import('../src/accounts.js');
  const file = join(f.data, 'cfg.json'); writeFileSync(file, '{}');
  const accounts = new Accounts(team, file, process.cwd(), { commandAvailable: () => true }); t.after(() => accounts.close());
  const folder = mkdtempSync(join(tmpdir(), 'proj-'));
  await assert.rejects(accounts.addProject({ path: folder }), /git/);
  const { id } = await accounts.addProject({ path: folder, init: true, tests: 'node -e "process.exit(0)"' });
  const p = team.project(id); assert.deepEqual(p.tests, [['node', '-e', 'process.exit(0)']]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects.length, 2);
  const upd = accounts.updateProject(id, { tests: 'node --test x.js\nno-such-cmd-xyz run', network: true });
  assert.deepEqual(team.project(id).tests, [['node', '--test', 'x.js'], ['no-such-cmd-xyz', 'run']]); assert.deepEqual(team.project(id).access.network, ['*']); assert.equal(team.accessFor(id, 'c').network, true);
  assert.equal(upd.warnings.length, 1); assert.match(upd.warnings[0], /no-such-cmd-xyz/);
  assert.throws(() => accounts.updateProject(id, { tests: [['node', 1]] })); assert.throws(() => accounts.updateProject(id, { network: 'yes' }));
  // Còn công việc chưa xong: 409 kèm danh sách; cancelJobs=true thì hủy rồi gỡ.
  team.save({ id: 'open-job', project: id, goal: 'x', status: 'paused', stage: 'plan', tasks: [], reports: [], messages: [] });
  await assert.rejects(accounts.removeProject(id), e => e.code === 409 && e.jobs[0] === 'open-job');
  await accounts.removeProject(id, { cancelJobs: true }); assert.throws(() => team.project(id));
  assert.equal(team.get('open-job').status, 'cancelled');
});

test('Gemini/Antigravity get the prompt via a file (Windows command-line limit) and progress timing is recorded', async t => {
  // Prompt-file I/O and the full mock pipeline may exceed 20 seconds under load.
  const f = await fixture(); f.config.demo = false;
  f.config.agents = f.config.agents.map(a => a.id === 'gemini' ? { ...a, provider: 'antigravity' } : { ...a, provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) });
  const seen = [];
  const { runAgent } = await import('../src/providers.js');
  const team = new Team(f.config, f.data, { runAgent: (agent, task, prompt, opts) => {
    if (agent.provider === 'antigravity') { seen.push(task.promptFile); assert.equal(readFileSync(join(task.worktree, task.promptFile), 'utf8'), prompt); }
    return runAgent({ ...agent, provider: 'mock' }, task, prompt, opts);
  }, readQuota: async () => ({ buckets: [] }) });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready', 60000);
  assert.deepEqual(seen, ['.ai-team/prompt.md']);
  assert(ready.durations.length >= 4); assert.equal(ready.current, null);
});

test('builder out of quota mid-task: controller hands the task and partial work to another builder', async t => {
  const f = await fixture(); f.config.demo = false;
  f.config.agents = f.config.agents.map(a => ({ ...a, provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) }));
  const seen = [];
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'implement') seen.push({ agent: agent.id, prompt });
    if (task.stage === 'implement' && seen.length === 1) { writeFileSync(join(task.worktree, 'partial.txt'), 'half done\n'); throw new Error("You've hit your usage limit. Try again later."); }
    return runAgent({ ...agent, provider: 'mock' }, task, prompt, opts);
  }, readQuota: async () => ({ buckets: [] }) });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const ready = await settle(team, job.id, 'ready');
  assert.equal(seen.length, 2); assert.notEqual(seen[0].agent, seen[1].agent);
  assert.match(seen[1].prompt, /handover/); assert.match(seen[1].prompt, /partial\.txt/);
  assert(team.events(job.id).some(e => e.type === 'HANDOVER' && e.details.from === seen[0].agent && e.details.to === seen[1].agent));
  assert.equal(team.lowQuota(seen[0].agent), true); assert.equal(ready.tasks[0].ranBy, seen[1].agent); assert.equal(ready.tasks[0].handover, undefined);
});

test('plan challenge: risky plans get one evidence-based challenge; serious objections send the plan back once', async t => {
  for (const objections of [[{ claim: 'Task 1 sửa sai file', failsWhen: 'hello.txt không phải nơi cần đổi', check: 'đọc README', impact: 'high' }], []]) {
    const f = await fixture(); const prompts = [];
    const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
      prompts.push({ stage: task.stage, agent: agent.id, prompt });
      const r = await runAgent(agent, task, prompt, opts);
      if (task.stage === 'plan') r.rigor = 'strict';
      if (task.stage === 'challenge') return { summary: 'x', status: 'completed', objections };
      return r;
    } });
    t.after(() => team.close());
    const job = await team.create({ project: 'test', goal: 'Update hello' });
    await settle(team, job.id, 'ready');
    const plans = prompts.filter(p => p.stage === 'plan'), challenges = prompts.filter(p => p.stage === 'challenge');
    assert.equal(challenges.length, 1); assert.notEqual(challenges[0].agent, 'codex-1'); // không để Manager tự phản biện mình
    assert.equal(plans.length, objections.length ? 2 : 1);
    if (objections.length) assert.match(plans[1].prompt, /"objections"/);
    assert(team.events(job.id).some(e => e.type === 'CHALLENGE'));
  }
});

test('memory: Leader keeps durable project notes and a session summary; next job sees them; backups and export work', { timeout: 150000 }, async t => {
  const f = await fixture(), prompts = [], started = Date.now();
  let round = 0;
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    t.diagnostic(`Memory pipeline: ${task.stage} at ${Date.now() - started}ms`);
    prompts.push({ stage: task.stage, prompt });
    const r = await runAgent(agent, task, prompt, opts);
    if (task.stage === 'final') return { ...r, memory: round++ === 0 ? { add: ['hello.txt Tests: node --test', 'token sk-abcdefghijklmnopqrstuvwxyz123456 leaked'], session: 'Đang sửa hello.txt' } : { remove: [`M${team.memory('test').facts[0].id}`], session: 'Xong hello.txt' } };
    return r;
  } });
  t.after(() => team.close());
  team.start();
  const ses = team.createSession({ project: 'test', name: 'S' });
  const a = await team.create({ project: 'test', goal: 'Update hello', mode: 'full', sessionId: ses.id });
  await settle(team, a.id, 'ready', 60000);
  let m = team.memory('test', ses.id);
  assert.deepEqual(m.facts.map(x => x.text)[0], 'hello.txt Tests: node --test'); assert.doesNotMatch(m.facts[1].text, /sk-abcdef/);
  assert.equal(m.facts[0].scope, 'job');
  const firstMemoryId = `M${m.facts[0].id}`;
  assert.equal((await team.searchMemory({ project: 'test', query: 'hello' })).results.length, 0);
  assert.equal(m.summary, 'Đang sửa hello.txt'); assert.equal(m.log.length, 1); assert.match(m.log[0].text, /Update hello → ready/);
  await team.merge(a.id, { confirm: (await team.mergeCheck(a.id)).code });
  // Việc sau nhận ghi chú liên quan trực tiếp; chỉ phần tóm tắt phiên dành cho Leader.
  prompts.length = 0;
  const b = await team.create({ project: 'test', goal: 'Check hello again', mode: 'full', sessionId: ses.id });
  await settle(team, b.id, 'ready', 60000);
  const plan = prompts.find(p => p.stage === 'plan').prompt, fin = prompts.find(p => p.stage === 'final').prompt, impl = prompts.find(p => p.stage === 'implement').prompt;
  assert.match(plan, /Tests: node --test/); assert.match(plan, /Đang sửa hello.txt/); assert.match(plan, new RegExp(a.id));
  assert.match(fin, /M\d+: hello.txt Tests: node --test/); assert.match(fin, /"memory":\{"add"/);
  assert.match(impl, /Tests: node --test/);
  assert.equal((await team.searchMemory({ project: 'test', job: b.id, memoryId: firstMemoryId })).results.length, 0);
  assert(team.memory('test').facts.some(x => x.text === 'hello.txt Tests: node --test'));
  await team.merge(b.id, { confirm: (await team.mergeCheck(b.id)).code });
  m = team.memory('test', ses.id);
  assert(!m.facts.some(x => x.text === 'hello.txt Tests: node --test')); assert.equal(m.summary, 'Xong hello.txt'); assert.equal(m.log.length, 2);
  assert(team.memory('test', ses.id, true).facts.some(x => x.text === 'hello.txt Tests: node --test' && x.status === 'superseded'));
  // Bạn sửa tay; sao lưu; xuất Markdown.
  team.editMemory({ project: 'test', session: ses.id, add: 'Dùng tiếng Việt trong UI' });
  assert(team.memory('test').facts.some(x => x.text === 'Dùng tiếng Việt trong UI'));
  const file = team.backup('manual'); assert(readFileSync(file).length > 0); assert.equal(team.backups().length >= 1, true);
  const md = await team.exportJob(b.id); assert.match(md, /^# Check hello again/); assert.match(md, /## Báo cáo/);
  await team.control(b.id, 'delete');
  assert(team.backups().some(x => /before-delete/.test(x.file)));
});

test('pending peer questions survive pause without duplication; invalid recipients and edits are rejected', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); team.closed = true; t.after(async () => { team.runs.clear(); await team.close(); });
  const job = await team.create({ project: 'test', goal: 'Peer recovery', paused: true });
  job.tasks = [{ instruction: 'Ask about hello', difficulty: 2, done: false }]; team.save(job);
  const opts = { task: job.tasks[0], taskIndex: 0 }, state = { agents: new Set(), abort: new AbortController() }; team.runs.set(job.id, state);
  t.after(() => team.runs.clear());
  for (const to of ['codex-2', 'outside']) {
    team.agentRun = async () => ({ summary: 'Invalid recipient', status: 'waiting_for_reply', peerRequest: { to, topic: 'Contract', question: 'Confirm it?' } });
    await assert.rejects(team.call(job, 'codex-2', 'implement', 'Ask about hello', undefined, [], opts), /Invalid peerRequest/);
  }
  let sourceCalls = 0;
  team.agentRun = async (agent, task) => {
    if (task.stage === 'consult') { state.abort.abort(new DOMException('Paused', 'AbortError')); throw state.abort.signal.reason; }
    sourceCalls++; writeFileSync(join(task.worktree, 'hello.txt'), 'saved draft\n');
    return { summary: 'Ask contract', status: 'waiting_for_reply', peerRequest: { to: 'codex-4', topic: 'Contract', question: 'Confirm exact greeting?' }, checkpoint: { done: 'Saved draft', next: 'Resolve contract' } };
  };
  await assert.rejects(team.call(job, 'codex-2', 'implement', 'Ask about hello', undefined, [], opts), /Paused/);
  assert.equal(team.slotKeys().length, 0); assert.equal(team.get(job.id).discussions[0].status, 'pending');
  const persisted = team.get(job.id); team.runs.clear(); await team.close();
  const reopened = new Team(f.config, f.data); reopened.closed = true; t.after(async () => { reopened.runs.clear(); await reopened.close(); });
  reopened.runs.set(job.id, { agents: new Set(), abort: new AbortController() }); t.after(() => reopened.runs.clear());
  reopened.agentRun = async (agent, task, prompt) => {
    if (task.stage === 'consult') {
      assert.equal(readFileSync(join(task.worktree, 'hello.txt'), 'utf8'), 'saved draft\n');
      await reopened.control(job.id, 'message', { message: 'Human guidance during consultation' });
      return { summary: 'Recovered reply', status: 'completed', stance: 'answer', answer: 'Use the configured contract', evidence: ['hello.txt:1'] };
    }
    sourceCalls++; assert(prompt.includes('Use the configured contract')); assert(prompt.includes('Human guidance during consultation'));
    return { summary: 'Resolved', status: 'completed', dialogueDecision: { thread: persisted.discussions[0].id, outcome: 'accepted', reason: 'Examined the evidence' } };
  };
  await reopened.call(persisted, 'codex-2', 'implement', 'Ask about hello', undefined, [], { task: persisted.tasks[0], taskIndex: 0 });
  assert.equal(sourceCalls, 2); assert.equal(persisted.discussions[0].messages.length, 2); assert.equal(persisted.discussions[0].rounds, 1);
  assert.equal(reopened.get(job.id).messages.at(-1).text, 'Human guidance during consultation');
  reopened.agentRun = async (agent, task) => task.stage === 'consult'
    ? (writeFileSync(join(task.worktree, 'hello.txt'), 'unauthorized edit\n'), { summary: 'Bad reply', status: 'completed', stance: 'agree', answer: 'Edited the file' })
    : { summary: 'New question', status: 'waiting_for_reply', peerRequest: { to: 'codex-4', topic: 'Another issue', question: 'Examine current draft?' } };
  await assert.rejects(reopened.call(persisted, 'codex-2', 'implement', 'Another issue', undefined, [], { task: persisted.tasks[0], taskIndex: 0 }), e => e.peerWait && /chỉ đọc/.test(e.message));
  assert.equal(readFileSync(join(persisted.worktree, 'hello.txt'), 'utf8'), 'saved draft\n');
  assert.equal(reopened.slotKeys().length, 0);
  assert.throws(() => validateConfig({ ...f.config, peerDialogue: 'yes' }), /boolean/);
});

test('Codex task resume reuses only the same profile/worktree/permissions, checkpoints survive a blocker, and memory credentials expire', async t => {
  const f = await fixture(); f.config.resumeCodexTasks = true;
  f.config.agents.find(a => a.id === 'codex-2').provider = 'codex';
  f.config.agents.find(a => a.id === 'codex-2').home = mkdtempSync(join(tmpdir(), 'ai-team-resume-home-'));
  const calls = []; let team;
  team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'implement') {
      const token = agent.mcp.team_memory.env.TEAM_MEMORY_TOKEN;
      assert.equal(team.memoryReaders.get(token).job, task.id);
      calls.push({ sessionId: task.sessionId, token });
      opts.onEvent('SESSION', { summary: 'session', details: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } });
      if (calls.length === 1) return { summary: 'Needs another step', status: 'blocked', checkpoint: { done: 'Located hello', remaining: 'Update hello', next: 'Continue implementation' } };
    }
    return runAgent({ ...agent, provider: 'mock' }, task, prompt, opts);
  } });
  t.after(() => team.close()); team.start();
  const job = await team.create({ project: 'test', goal: 'Update hello', mode: 'full' });
  const blocked = await settle(team, job.id, 'blocked');
  assert.equal(blocked.tasks[0].checkpoint.next, 'Continue implementation'); assert.equal(team.memoryReaders.size, 0);
  await team.control(job.id, 'resume');
  const ready = await settle(team, job.id, 'ready');
  assert.equal(calls[0].sessionId, undefined); assert.equal(calls[1].sessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(team.memoryReaders.size, 0); assert.equal(ready.tasks[0].checkpoint.done.includes('DEMO'), true);
  // A permission change invalidates the saved conversation, even for the same member and task.
  ready.tasks[0].done = false; ready.status = 'paused'; ready.stage = 'implement'; team.save(ready); team.config.roleCaps = { builder: { network: false } };
  f.config.projects[0].access = { network: ['codex-2'] }; team.config.projects[0].access = f.config.projects[0].access;
  // The first context had no network grant; make an effective permission change here.
  team.config.roleCaps.builder.network = true;
  await team.control(job.id, 'resume'); await settle(team, job.id, 'ready');
  assert.equal(calls[2].sessionId, undefined);
});

test('per-folder permissions per AI: reviewer view-only, builder edits src but not tests; deletes need delete; session sets override the project; role ceilings and shell stop', async t => {
  const f = await fixture();
  const { mkdirSync, existsSync } = await import('node:fs');
  mkdirSync(join(f.path, 'src')); mkdirSync(join(f.path, 'test'));
  writeFileSync(join(f.path, 'src', 'a.js'), '1\n'); writeFileSync(join(f.path, 'test', 'a.test.js'), 't\n');
  await run(['git'], ['-C', f.path, 'add', '.']); await run(['git'], ['-C', f.path, '-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-m', 'dirs']);
  const { levelFor, capsOf } = await import('../src/team.js');
  const paths = [{ path: 'src', grant: { '*': 'read', 'codex-2': 'edit' } }, { path: 'src/gen', grant: { '*': 'read' } }, { path: 'test', grant: { '*': 'read' } }];
  assert.equal(levelFor(paths, 'src/a.js', 'codex-2'), 'edit'); assert.equal(levelFor(paths, 'src/gen/x.js', 'codex-2'), 'read');
  assert.equal(levelFor(paths, 'src/a.js', 'gemini'), 'read'); assert.equal(levelFor(paths, 'srcx/a.js', 'codex-2'), null);
  assert.equal(capsOf({ roleCaps: { builder: { delete: false, merge: true } } }).builder.delete, false);
  assert.equal(capsOf({ roleCaps: { builder: { merge: true } } }).builder.merge, undefined);
  // Builder sửa hello + src (được phép) nhưng cũng sửa test (không được) → file test bị hoàn tác, việc dừng.
  const make = (access, act, extra = {}) => {
    const team = new Team({ ...f.config, ...extra, projects: [{ ...f.config.projects[0], access }] }, mkdtempSync(join(tmpdir(), 'ai-team-perm-')), { runAgent: async (agent, task, prompt, opts) => {
      if (task.stage === 'implement') act(task, opts);
      return runAgent(agent, task, prompt, opts);
    } });
    t.after(() => team.close()); team.start(); return team;
  };
  const base = { folders: [], network: [], repos: [], paths: [{ path: 'src', grant: { '*': 'edit' } }, { path: 'test', grant: { '*': 'read' } }] };
  let team = make(base, task => { writeFileSync(join(task.worktree, 'src', 'a.js'), '2\n'); writeFileSync(join(task.worktree, 'test', 'a.test.js'), 'hacked\n'); });
  let job = await team.create({ project: 'test', goal: 'Update hello and src' });
  let blocked = await settle(team, job.id, 'blocked');
  assert.match(blocked.error, /test\/a\.test\.js/); assert.doesNotMatch(blocked.error, /src\/a\.js/);
  assert.equal(readFileSync(join(blocked.worktree, 'test', 'a.test.js'), 'utf8'), 't\n');
  assert.equal(readFileSync(join(blocked.worktree, 'src', 'a.js'), 'utf8'), '2\n');
  assert(team.events(job.id).some(e => e.type === 'PERMISSION'));
  // Mức "edit" không cho xóa.
  team = make(base, task => rmSync(join(task.worktree, 'src', 'a.js')));
  job = await team.create({ project: 'test', goal: 'Remove src a' });
  blocked = await settle(team, job.id, 'blocked');
  assert.match(blocked.error, /src\/a\.js/); assert(existsSync(join(blocked.worktree, 'src', 'a.js')));
  // Phiên có bộ quyền riêng: cho phép xóa trong src → qua được; dự án khác phiên vẫn giữ mặc định.
  const { accessList } = await import('../src/accounts.js');
  job = await team.create({ project: 'test', goal: 'Remove src a again' });
  team.setSessionAccess(job.sessionId, accessList({ ...base, paths: [{ path: 'src', grant: { '*': 'delete' } }] }, f.config.agents.map(a => a.id), ['test'], 'test'));
  assert.equal(team.accessFor('test', 'codex-2', job.sessionId, 'implement').paths[0].grant['*'], 'delete');
  assert.equal(team.accessFor('test', 'codex-2', null, 'implement').paths[0].grant['*'], 'edit');
  await settle(team, job.id, 'ready');
  assert.throws(() => accessList({ paths: [{ path: '../x' }] }, ['codex-2'], ['test'], 'test'), /\.\./);
  // Trần vai trò: builder không được xóa ở bất kỳ đâu.
  team = make({ ...base, paths: [] }, task => rmSync(join(task.worktree, 'src', 'a.js')), { roleCaps: { builder: { delete: false } } });
  job = await team.create({ project: 'test', goal: 'Remove src a with ceiling' });
  blocked = await settle(team, job.id, 'blocked'); assert.match(blocked.error, /src\/a\.js/);
  // Không được chạy lệnh: agent (không phải Codex) gọi shell → dừng ngay.
  const agents = f.config.agents.map(a => a.id === 'codex-2' ? { ...a, provider: 'mock', label: 'claude-like' } : a);
  const shellTeam = new Team({ ...f.config, agents, projects: [{ ...f.config.projects[0], access: { ...base, paths: [], shell: ['codex-1', 'gemini', 'codex-3'] } }] }, mkdtempSync(join(tmpdir(), 'ai-team-sh-')), { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'implement') { assert.match(prompt, /did not allow you to run shell/); opts.onEvent('ACTIVITY', { summary: 'npm i', details: { name: 'Bash', input: { command: 'npm i' } } }); await new Promise((r, j) => opts.signal.aborted ? j(opts.signal.reason) : opts.signal.addEventListener('abort', () => j(opts.signal.reason))); }
    return runAgent(agent, task, prompt, opts);
  } });
  t.after(() => shellTeam.close()); shellTeam.start();
  job = await shellTeam.create({ project: 'test', goal: 'Update hello with npm' });
  blocked = await settle(shellTeam, job.id, 'blocked'); assert.match(blocked.error, /npm i/);
});
