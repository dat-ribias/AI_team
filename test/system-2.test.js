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

test('oracle: CLI errors, rate limit, captcha, login, timeout and cancellation fail briefly', async () => {
  for (const [script, message] of [
    ['process.exit(2)', /exit 2/],
    ["console.log('Too many requests')", /Too many requests/],
    ["console.log('captcha')", /captcha/],
    ["console.log('Please log in')", /not logged in/],
    ["console.log('Session: timeout-session'); setTimeout(() => {}, 10000)", /timeout/],
    ["console.log('Session: no-answer')", /no answer output/],
  ]) await assert.rejects(runOracle({ command: [process.execPath, '-e', script, '--'], prompt: 'question', timeoutMs: script.includes('setTimeout') ? 300 : 5000 }), message);
  const abort = new AbortController(); abort.abort(new Error('cancel oracle'));
  await assert.rejects(runOracle({ command: [process.execPath, '-e', 'setTimeout(() => {}, 10000)', '--'], prompt: 'question', signal: abort.signal }), /cancel oracle/);
});

test('oracle: separate accounts run concurrently and a cancelled waiter retains the active lock', async t => {
  const f = await fixture(); f.config.oracle = { enabled: true, accounts: [{ id: 'one', args: ['one'] }, { id: 'two', args: ['two'] }] };
  let release, started = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const team = new Team(f.config, f.data, { runOracle: async input => {
    started++; await gate; return { answer: 'opinion', session: input.args[0] };
  } }); t.after(async () => { release(); await team.close(); });
  const jobs = [];
  for (const goal of ['First', 'Second', 'Waiter', 'Next']) {
    const job = await team.create({ project: 'test', goal, paused: true });
    job.oracle = { turns: [] }; jobs.push(job);
    team.runs.set(job.id, { agents: new Set(), abort: new AbortController() });
  }
  const calls = [];
  try {
    calls.push(team.askOracle(jobs[0], 'codex-1', 'First?'), team.askOracle(jobs[1], 'codex-1', 'Second?'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, 2); assert.notEqual(jobs[0].oracle.account, jobs[1].oracle.account);
    jobs[2].oracle.account = jobs[0].oracle.account;
    const waiter = team.askOracle(jobs[2], 'codex-1', 'Wait?'), rejected = assert.rejects(waiter, /stop waiter/);
    team.runs.get(jobs[2].id).abort.abort(new Error('stop waiter')); await rejected;
    assert(team.oracleLocks.has(jobs[0].oracle.account));
    jobs[3].oracle.account = jobs[0].oracle.account;
    calls.push(team.askOracle(jobs[3], 'codex-1', 'Next?'));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(started, 2);
    release(); await Promise.all(calls);
    assert.equal(started, 3); assert.equal(team.oracleLocks.size, 0);
  } finally { release(); await Promise.allSettled(calls); for (const job of jobs) team.runs.delete(job.id); }
});

test('plan approval: research and fast paths run freely, but fast escalation waits for the owner', async t => {
  for (const scenario of ['research', 'fast', 'auto', 'escalate', 'disabled']) {
    const f = await fixture(); f.config.planApproval = true;
    if (scenario === 'escalate') f.config.projects[0].tests = [[process.execPath, '-e', 'process.exit(1)']];
    const team = new Team(f.config, f.data, { runAgent: approvalAgent }); t.after(() => team.close());
    const job = await team.create({ project: 'test', goal: scenario === 'research' ? 'Research greeting' : 'Update hello text',
      mode: ['fast', 'auto'].includes(scenario) ? scenario : scenario === 'escalate' ? 'fast' : 'full', ...(scenario === 'disabled' ? { planApproval: false } : {}) });
    const result = await settle(team, job.id, scenario === 'research' ? 'done' : scenario === 'escalate' ? 'waiting' : 'ready');
    assert.equal(result.planApproval, scenario !== 'disabled');
    if (scenario === 'escalate') {
      assert.equal(result.fast, false); assert.equal(result.plans[0].reason, 'escalate'); assert.equal(result.planGate.version, 1);
      assert.equal(result.reports.filter(r => r.stage === 'implement').length, 1, 'only the fast implementation ran');
    } else {
      assert.equal(result.planGate, null); assert(!team.events(job.id).some(e => e.type === 'PLAN_PROPOSED'));
      assert.equal(result.plans.length, ['research', 'disabled'].includes(scenario) ? 1 : 0);
    }
  }
});

test('evidence collection skips outside symlinks and ancestor junctions', async t => {
  const f = await fixture(), outside = join(f.data, 'outside');
  mkdirSync(outside); writeFileSync(join(outside, 'check.log'), 'outside');
  try { symlinkSync(outside, join(f.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip(`Symlinks unavailable: ${e.code}`); throw e; }
  const result = collect({ worktree: f.path, paths: ['linked', 'linked/check.log'], dest: join(f.data, 'archive'), maxBytes: 100 });
  assert.equal(result.files.length, 0); assert.equal(result.skipped.length, 2);
  assert(result.skipped.every(f => /Symlink|junction|outside the worktree/.test(f.reason)));
});

test('evidenceFile rejects symlinked archive directories and files', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); team.closed = true; t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Archive paths', paused: true });
  const root = join(f.data, 'evidence', job.id), outside = join(f.data, 'outside');
  mkdirSync(root, { recursive: true }); mkdirSync(outside); writeFileSync(join(outside, 'check.log'), 'outside');
  try { symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip(`Symlinks unavailable: ${e.code}`); throw e; }
  assert.throws(() => team.evidenceFile(job.id, 'linked/check.log'), /symlinks/);
  assert.throws(() => team.evidenceFile(job.id, 'linked'), /symlinks/);
  await t.test('file symlink', t => {
    try { symlinkSync(join(outside, 'check.log'), join(root, 'file.log'), 'file'); }
    catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip(`Symlinks unavailable: ${e.code}`); throw e; }
    assert.throws(() => team.evidenceFile(job.id, 'file.log'), /symlinks/);
  });
});

test('runTests archives complete redacted logs and records duration for the supplied revision', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); team.closed = true; t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Logs', paused: true });
  const revision = 'a'.repeat(40), command = [process.execPath, '-e', "console.error('BEGIN api_key=dummy-private-value'); for(let i=0;i<700;i++) console.error('line '+i+' '+'x'.repeat(100)); console.log('END')"];
  assert(await team.runTests(job, job.worktree, revision, [command])); team.save(job);
  const check = team.evidence(job.id).checkResults.at(-1);
  assert.equal(check.revision, revision); assert.equal(check.code, 0); assert(check.ms >= 0); assert(check.log.startsWith(revision + '/test-controller/'));
  const full = readFileSync(team.evidenceFile(job.id, check.log).file, 'utf8');
  assert(full.includes('BEGIN api_key=[REDACTED]')); assert(!full.includes('dummy-private-value'));
  assert(full.includes('line 0 ')); assert(full.includes('line 699 ')); assert(full.includes('END'));
  assert(full.length > 70000); assert(check.output.length < 5000);
  assert.equal(job.evidenceBytes, Buffer.byteLength(full));
  const md = await team.exportJob(job.id); assert(md.includes(check.log)); assert(md.includes(revision));
  assert(!await team.runTests(job, job.worktree, revision, [[process.execPath, '-e', "console.error('FAILED'); process.exit(7)"]]));
  assert.equal(job.checkResults.at(-1).code, 7); assert(job.checkResults.at(-1).log);
});

test('discussion ledger rejects mismatched replies/stale evidence and keeps outstanding claims', () => {
  const d = ledger({ id: 'D-test', from: 'a', topic: 'Contract', messages: [], status: 'pending' }), s = { fingerprint: 'v1' };
  question(d, { question: 'Check both', claims: [{ statement: 'Second claim' }], claimIds: ['C1','C2'], evidence: ['hello.txt:1'] }, s, 'a');
  assert.throws(() => answer(d, { replyTo: 'M99', answer: 'yes' }, s, 'b'), /pending message/);
  assert.throws(() => answer(d, { claimIds: ['C1'], answer: 'yes' }, s, 'b'), /every requested/);
  answer(d, { replyTo: 'M1', claimIds: ['C1','C2'], answer: 'Both checked', evidence: ['contract:1'] }, s, 'b');
  assert.equal(d.messages[1].replyTo, 'M1'); assert.equal(d.messages[0].delivery, 'answered');
  assert(!decide(d, { thread: d.id, outcome: 'accepted', reason: 'Partial', claimIds: ['C1'], evidenceIds: ['E1'] }, s, 'a'));
  assert(!decide(d, { thread: d.id, outcome: 'accepted', reason: 'Conditional', claimIds: ['C2'], evidenceIds: ['E2'], remaining: ['Check Unicode'] }, s, 'a'));
  assert.throws(() => decide(d, { thread: d.id, outcome: 'accepted', reason: 'Invalid obligations', remaining: 'Still needs Unicode' }, s, 'a'), /obligations must be arrays/);
  refreshLedger(d, { fingerprint: 'v2' });
  assert.throws(() => decide(d, { thread: d.id, outcome: 'rejected', reason: 'Old proof', evidenceIds: ['E2'] }, { fingerprint: 'v2' }, 'a'), /stale evidence/);
  assert(decide(d, { thread: d.id, outcome: 'rejected', reason: 'Fresh proof', claimIds: ['C1','C2'], evidence: ['Current contract'], conditions: ['ASCII only'] }, { fingerprint: 'v2' }, 'a'));
});

test('independent dialogue, content freshness, ownership handover and separate quality judgments', async t => {
  const f = await fixture(), seen = [], team = new Team(f.config, f.data); team.closed = true; t.after(async () => { team.runs.clear(); await team.close(); });
  const job = await team.create({ project: 'test', goal: 'Update hello', dialogueMode: 'independent', paused: true });
  await team.ensureExclude(job.worktree); mkdirSync(join(job.worktree, '.ai-team'), { recursive: true }); writeFileSync(join(job.worktree, '.ai-team', 'prompt.md'), 'UNIQUE_PEER_CLAIM');
  job.tasks = [{ instruction: 'Check greeting', files: ['hello.txt'], difficulty: 2 }];
  team.runs.set(job.id, { agents: new Set(), abort: new AbortController() });
  let asked = false, quota = false;
  team.agentRun = async (agent, task, prompt) => {
    seen.push([agent.id, task.stage]);
    if (task.stage === 'assess') { assert(!prompt.includes('UNIQUE_PEER_CLAIM')); assert(!prompt.includes('UNIQUE_PEER_QUESTION')); assert(!prompt.includes('"discussion"')); assert(!existsSync(join(task.worktree, '.ai-team', 'prompt.md'))); return { status: 'completed', summary: 'Own view', answer: 'The configured greeting', evidence: ['hello.txt:1'] }; }
    if (task.stage === 'consult') return { status: 'completed', summary: 'Reply', replyTo: 'M1', claimIds: ['C1'], stance: 'answer', answer: 'Use the configured greeting', evidence: ['hello.txt:1'] };
    if (!asked) { asked = true; return { status: 'waiting_for_reply', summary: 'Need contract', peerRequest: { to: 'gemini', topic: 'Greeting', claim: 'UNIQUE_PEER_CLAIM', question: 'UNIQUE_PEER_QUESTION', files: ['hello.txt'], evidence: ['hello.txt:1'] } }; }
    if (agent.id === 'codex-2' && !quota) { quota = true; throw new Error('429 quota exhausted'); }
    assert.equal(agent.id, 'codex-4'); assert(prompt.includes('Use the configured greeting'));
    writeFileSync(join(task.worktree, 'hello.txt'), 'Hello from AI Team demo!\n');
    return { status: 'completed', summary: 'Fixed', dialogueDecision: { thread: job.discussions[0].id, outcome: 'accepted', reason: 'Verified configured contract', choice: 'Use configured greeting', evidence: ['Updated hello.txt:1'], conditions: ['Greeting contract stays unchanged'] } };
  };
  await team.callWithHandover(job, job.tasks[0], 0, 'codex-2', 'implement', []);
  const d = job.discussions[0]; assert.equal(d.owner, 'codex-4'); assert.deepEqual(d.owners, ['codex-2','codex-4']); assert.equal(d.status, 'resolved'); assert.equal(d.messages[1].replyTo, 'M1');
  assert.deepEqual(seen.map(x => x[1]), ['implement','assess','consult','implement','implement']);
  assert.equal(d.evidence[0].status, 'stale'); assert.equal(d.evidence.at(-1).status, 'current');
  await team.commitAll(job); await team.checkDiscussions(job);
  writeFileSync(join(job.worktree, 'unrelated.txt'), 'Other work\n'); await team.commitAll(job); await team.checkDiscussions(job);
  team.runs.clear(); team.save(job);
  await team.control(job.id, 'score-claim', { thread: d.id, claim: 'C1', before: false, after: true, evidence: ['Configured greeting test'] });
  assert.equal(team.get(job.id).discussions[0].claims[0].judgment.transition, 'wrongToRight');
  await team.control(job.id, 'score-claim', { thread: d.id, claim: 'C1', before: true, after: false, evidence: ['Counterexample'] });
  assert.equal(team.get(job.id).discussions[0].claims[0].judgment.transition, 'rightToWrong');
  await assert.rejects(team.control(job.id, 'score-claim', { thread: d.id, claim: 'C1', before: 'true', after: false, evidence: ['Invalid label'] }), /Scoring/);
  writeFileSync(join(job.worktree, 'hello.txt'), 'Changed contract\n');
  await assert.rejects(team.checkDiscussions(job), e => e.peerWait && /obligations/.test(e.message));
  assert.equal(d.status, 'reopened'); assert.equal(d.history.length, 1); assert.equal(d.claims[0].status, 'open');
  await team.control(job.id, 'revisit-discussion', { thread: d.id, task: 0, recipient: 'gemini' });
  assert.equal(team.get(job.id).stage, 'implement'); assert.equal(team.get(job.id).tasks[0].done, false);
});

test('comparison uses identical inputs and fixed budgets without automatically running AI', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); team.closed = true; t.after(() => team.close());
  const result = await team.createComparison({ project: 'test', goal: 'Compare greeting', tokenBudget: 1000, callBudget: 5 });
  assert.deepEqual(result.jobs.map(j => j.dialogueMode), ['off','direct','independent']);
  assert(result.jobs.every(j => j.status === 'paused' && !j.usage && j.tokenBudget === 1000 && j.callBudget === 5 && j.base === result.jobs[0].base && j.comparison.input === result.jobs[0].comparison.input));
  const job = result.jobs[0]; job.usage = { calls: 5, tokens: 0 }; team.save(job);
  await assert.rejects(team.control(job.id, 'resume'), /budget exhausted/);
  await assert.rejects(team.invoke(job, 'codex-1', 'plan', 'Over budget', undefined, [], {}, team.agent('codex-1'), new AbortController().signal), /Call budget/);
  assert.equal(team.get(job.id).callBudget, 5);
  const next = result.jobs[1]; team.config.agents[0].model = 'changed';
  await assert.rejects(team.control(next.id, 'resume'), /models, roles, tools or permissions changed/);
  await assert.rejects(team.createComparison({ project: 'test', goal: 'Missing budgets' }), /positive/);
  await team.remember(next, { add: ['Comparison answer must stay private'], session: 'Do not leak this answer' });
  assert(!team.memory('test').facts.some(r => r.text.includes('Comparison answer')));
  assert.equal(team.sessions().find(s => s.id === next.sessionId).notes, '');
  team.config.maxTokensPerJob = 1000;
  const ordinary = await team.create({ project: 'test', goal: 'Legacy resume budget', paused: true });
  for (const used of [1000, 2000]) {
    ordinary.status = 'paused'; ordinary.usage = { calls: 1, tokens: used }; team.save(ordinary); team.event(ordinary.id, 'codex-2', 'controller', 'USAGE', 'Actual usage', { total_tokens: 1000 });
    const resumed = await team.control(ordinary.id, 'resume'); assert.equal(resumed.tokenBudget, used + 1000); Object.assign(ordinary, resumed);
  }
});

test('preview configuration validates defaults and only permits minimal environment', { timeout: 60_000 }, () => {
  assert.equal(validatePreview(null), null); assert.equal(validatePreview(undefined), null);
  assert.deepEqual(validatePreview({ command: 'npx serve --port {port}' }), { command: 'npx serve --port {port}', readyPath: '/', routes: [{ name: 'home', path: '/' }], timeoutSec: 120, ttlMin: 30, portRange: [4100, 4199], requireAcceptance: true });
  for (const config of [[], {}, { command: 'node server.js' }, { command: 'x {port}', readyPath: 'x' }, { command: 'x {port}', readyPath: '//other' }, { command: 'x {port}', routes: [] }, { command: 'x {port}', routes: [{ name: 'x', path: 'x' }] }, { command: 'x {port}', timeoutSec: 4 }, { command: 'x {port}', ttlMin: 241 }, { command: 'x {port}', portRange: [5, 4] }, { command: 'x {port}', requireAcceptance: 'true' }]) assert.throws(() => validatePreview(config), new RegExp(msg('srv.preview.invalid_config', { 0: '' }).split(':')[0]));
  const env = previewEnv(4321);
  assert.equal(env.PORT, '4321'); assert.equal(env.BROWSER, 'none');
  assert(Object.keys(env).every(k => /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|programfiles|programfiles\(x86\)|port|browser)$/i.test(k)));
  assert.equal(env.NODE_OPTIONS, undefined);
});

test('preview screenshot captures desktop and mobile PNG through CDP', { timeout: 60_000, skip: !findChrome() && 'Chrome not installed' }, async t => {
  const f = await fixture(), port = await freePort([4200, 4299]), file = join(f.data, 'desktop.png');
  writeFileSync(join(f.path, 'shot.cjs'), `const http=require('node:http'); setInterval(()=>{try{process.kill(${process.pid},0)}catch{process.exit()}},200); setTimeout(()=>process.exit(),45000).unref(); http.createServer((req,res)=>res.end('<h1>Screenshot</h1>')).listen(process.argv[2]);`);
  const server = startServer({ command: 'node shot.cjs {port}', cwd: f.path, port });
  t.after(async () => { await stopTree(server.pid); rmSync(f.data, { recursive: true, force: true }); rmSync(f.path, { recursive: true, force: true }); });
  await waitReady(`http://localhost:${port}/`, 5, server.child);
  for (const [name, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
    await screenshot({ chrome: findChrome(), url: `http://localhost:${port}/`, width, height, file });
    const png = readFileSync(file); assert.equal(png.readUInt32BE(16), width); assert.equal(png.readUInt32BE(20), height);
    mkdirSync('.ai-team/evidence', { recursive: true }); writeFileSync(join('.ai-team/evidence', `preview-fixture-${name}.png`), png);
  }
});

for (const mode of ['ff', 'merge']) test(`accept is revision-bound, filters evidence, gates merge and merged preview is stopped (${mode})`, { timeout: 60_000 }, async t => {
  const { f, team, job } = await previewFixture(t);
  const target = mode === 'merge' ? { type: 'existing', branch: 'release' } : undefined;
  let tip;
  if (target) { await run(['git'], ['-C', f.path, 'branch', target.branch]); tip = await branchCommit(f, target.branch); }
  const check = await team.mergeCheck(job.id, target);
  assert.equal(check.target.mode, mode);
  assert.deepEqual(check.acceptance, { required: true, ok: false, revision: null });
  assert.deepEqual(check.paths, [{ path: 'hello.txt', added: 1, removed: 1 }]);
  await assert.rejects(team.control(job.id, 'accept', { revision: job.base }), new RegExp(msg('srv.preview.accept_invalid')));
  await assert.rejects(team.merge(job.id, { target }), new RegExp(msg('srv.preview.accept_required', { 0: job.revision.slice(0, 8) })));
  assert.equal(team.get(job.id).status, 'ready');
  await team.runPreview(team.get(job.id));
  const fresh = team.get(job.id), entry = fresh.evidence.at(-1), valid = entry.files.map(f => `${entry.dir}/${f.path}`);
  // A synthetic archived file also covers filtering when Chrome is unavailable.
  entry.files.push({ path: 'owner.png', bytes: 0, type: 'image' }); team.save(fresh); valid.push(`${entry.dir}/owner.png`);
  const accepted = await team.control(job.id, 'accept', { revision: job.revision, evidence: [...valid, '../outside', 'wrong-revision.png', 42] });
  assert.deepEqual(accepted.acceptance.evidence, valid); assert.equal(accepted.acceptance.by, 'user');
  assert(team.events(job.id).some(e => e.type === 'ACCEPTED'));
  assert.equal((await team.mergeCheck(job.id, target)).acceptance.ok, true);
  const prepared = await team.merge(job.id, { target });
  if (target) {
    const pending = prepared.pendingMerge;
    assert.equal(prepared.status, 'ready'); assert(pending.passed); assert.equal(await branchTip(f, target.branch), tip);
    assert.equal(team.get(job.id).preview.status, 'running');
    await assert.rejects(team.merge(job.id, { target, approveMerge: job.revision }), /exact pending/);
    await team.merge(job.id, { target, approveMerge: pending.commit });
    assert.equal(await branchTip(f, target.branch), pending.commit);
  }
  assert.equal(team.get(job.id).status, 'merged'); assert.equal(team.get(job.id).preview.stoppedReason, 'merged');
  await assert.rejects(team.control(job.id, 'accept', { revision: job.revision }));
});

test('preview restart cleans persisted server and baseline PIDs without restoring preview', { timeout: 60_000 }, async t => {
  const { f, team, job, pids } = await previewFixture(t);
  await team.runPreview(job); const fresh = team.get(job.id), pid = fresh.preview.pid; pids.add(pid);
  const base = startServer({ command: 'node server.js {port}', cwd: job.worktree, port: await freePort([4200, 4299], [fresh.preview.port]) }); pids.add(base.pid);
  fresh.preview.basePid = base.pid; team.save(fresh);
  // Simulate a crash by closing only SQLite; close() deliberately stops previews.
  team.previews.clear(); team.db.close(); team.dbClosed = true;
  const reopened = new Team(f.config, f.data); reopened.closed = true; t.after(() => reopened.close());
  await reopened.previewRecovery;
  assert(!processAlive(pid)); assert(!processAlive(base.pid)); assert.equal(reopened.previews.size, 0);
  assert.equal(reopened.get(job.id).preview.status, 'stopped'); assert.equal(reopened.get(job.id).preview.stoppedReason, 'restart');
  assert.equal(reopened.get(job.id).preview.pid, undefined); assert.equal(reopened.get(job.id).preview.basePid, undefined);
  await reopened.close();
});

test('preview failure archives redacted logs and finish still leaves the job ready with changes', { timeout: 60_000 }, async t => {
  const { team, job } = await previewFixture(t, { command: 'node -e "console.error(\'access_token=example\');process.exit(1)" {port}' });
  job.fast = true; job.status = 'running'; team.save(job);
  await team.finish(job, team.config.pipeline); team.save(job);
  const fresh = team.get(job.id), entry = fresh.evidence.at(-1);
  assert.equal(fresh.status, 'ready'); assert.equal(fresh.preview.status, 'failed'); assert.equal(team.previews.size, 0);
  assert.deepEqual(fresh.changes, { revision: job.revision, added: 1, removed: 1, files: [{ path: 'hello.txt', added: 1, removed: 1 }] });
  assert(entry.files.some(f => f.path === 'preview.log'));
  const log = readFileSync(team.evidenceFile(job.id, `${entry.dir}/preview.log`).file, 'utf8');
  assert(!log.includes('access_token=example')); assert(log.includes('[REDACTED]'));
  assert(team.events(job.id).some(e => e.type === 'PREVIEW_WARNING'));
});

test('preview finish preserves incoming guidance for runJob to replan', { timeout: 60_000 }, async t => {
  const { team, job } = await previewFixture(t, { command: 'node server.js {port} 1500' });
  job.stage = 'final'; job.fast = true; team.save(job);
  const finishing = team.runJob(job), until = Date.now() + 5000;
  while (!team.get(job.id).preview?.basePid && Date.now() < until) await new Promise(r => setTimeout(r, 30));
  assert(team.get(job.id).preview?.basePid);
  await team.control(job.id, 'message', { message: 'New guidance during preview' }); await finishing;
  const fresh = team.get(job.id);
  assert.equal(fresh.status, 'queued'); assert.equal(fresh.stage, 'plan'); assert.equal(fresh.tested, null);
  assert.equal(fresh.messages.at(-1).text, 'New guidance during preview');
});

test('preview without Chrome keeps the server running and feedback revokes acceptance', { timeout: 60_000 }, async t => {
  const { team, job } = await previewFixture(t);
  await team.runPreview(job);
  const fresh = team.get(job.id);
  assert.equal(fresh.preview.status, 'running'); assert.equal(fresh.preview.screenshots, false); assert.equal(fresh.preview.error, undefined);
  assert(team.events(job.id).some(e => e.type === 'PREVIEW_WARNING' && e.summary === msg('srv.preview.no_chrome')));
  await team.control(job.id, 'accept', { revision: job.revision });
  await team.control(job.id, 'message', { message: 'Please revise' }); assert.equal(team.get(job.id).acceptance, null);
});

test('preview enforces two concurrent slots and project proposals remain drafts', { timeout: 60_000 }, async t => {
  const { f, team, job } = await previewFixture(t);
  team.previews.set('reserved-1', {}); team.previews.set('reserved-2', {});
  try { await team.runPreview(job); assert.equal(team.get(job.id).preview, undefined); assert(team.events(job.id).some(e => e.type === 'PREVIEW_WARNING')); }
  finally { team.previews.clear(); }
  team.agentRun = async (agent, task, prompt) => { assert.match(prompt, /package\.json/); assert.equal(task.network, false); return { summary: 'Draft preview', draft: { command: 'node server.js {port}' }, notes: ['Review routes'] }; };
  const original = structuredClone(team.config.projects[0].preview), proposal = await team.proposePreview('test');
  assert.equal(proposal.draft.command, 'node server.js {port}'); assert.deepEqual(team.config.projects[0].preview, original); assert.equal(team.runs.size, 0);
  const { Accounts } = await import('../src/accounts.js'), file = join(f.data, 'cfg.json'); writeFileSync(file, '{}');
  const accounts = new Accounts(team, file, process.cwd(), { commandAvailable: () => true });
  try {
    accounts.updateProject('test', { preview: proposal.draft }); assert.equal(team.state().projects[0].preview.requireAcceptance, true);
    accounts.updateProject('test', { preview: null }); assert.equal(team.state().projects[0].preview, null);
    assert.throws(() => accounts.updateProject('test', { preview: { command: 'invalid' } }));
  } finally { await accounts.close(); }
});

test('local branches, alternate job base and non-checkout base merge leave main unchanged', async t => {
  const f = await fixture(); await run(['git'], ['-C', f.path, 'branch', 'release']);
  const release = await branchCommit(f, 'release'), main = await branchTip(f);
  const { team, job } = await branchReady(t, f, 'release');
  assert.deepEqual(await team.branches('test'), { current: 'main', branches: [job.branch, 'main', 'release'] });
  assert.equal(job.base, release); assert.equal(job.baseBranch, 'release');
  assert.equal((await team.mergeCheck(job.id)).target.mode, 'update-ref');
  await team.merge(job.id);
  assert.equal(await branchTip(f, 'release'), job.revision); assert.equal(await branchTip(f), main);
  assert.equal(readFileSync(join(f.path, 'hello.txt'), 'utf8'), 'Hello!\n');
  await run(['git'], ['-C', f.path, 'checkout', '--detach']); assert.equal((await team.branches('test')).current, null);
});

test('pre-aborted process and mock provider preserve the cancellation reason', async () => {
  const abort = new AbortController(), reason = new DOMException('Cancelled by test', 'AbortError');
  abort.abort(reason);
  await assert.rejects(run([process.execPath], [], { signal: abort.signal }), error => error === reason);
  await assert.rejects(runAgent({ provider: 'mock' }, { stage: 'plan' }, '', { signal: abort.signal, onEvent() {} }), error => error === reason);
});

test('lead can pick research (no merge, ends with a conclusion) or a light code process (no verify)', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const research = await team.create({ project: 'test', goal: 'nghiên cứu: so sánh hai cách làm' });
  const done = await settle(team, research.id, 'done');
  assert.equal(done.kind, 'research'); assert(done.conclusion?.conclusion);
  assert.equal(done.revision, done.base); // không sửa code
  assert(team.events(research.id).some(e => e.type === 'CONCLUSION'));
  await assert.rejects(team.merge(research.id));
  const light = await team.create({ project: 'test', goal: 'light: Update hello' });
  const ready = await settle(team, light.id, 'ready');
  assert.equal(ready.rigor, 'light'); assert.equal(ready.verified, null);
  assert(!team.events(light.id).some(e => e.details?.stage === 'verify'));
  await team.merge(light.id);
});

test('attachments land in the worktree for agents but never in commits', async t => {
  const f = await fixture(), team = new Team(f.config, f.data); t.after(() => team.close());
  const shot = join(f.data, 'shot.png'); writeFileSync(shot, 'PNG');
  const job = await team.create({ project: 'test', goal: 'Update hello', files: [{ name: 'log.txt', data: Buffer.from('err').toString('base64') }, { path: shot }] });
  const ready = await settle(team, job.id, 'ready');
  assert.deepEqual(ready.attachments, ['.ai-team/attachments/log.txt', '.ai-team/attachments/shot.png']);
  assert.equal(readFileSync(join(ready.worktree, '.ai-team/attachments/log.txt'), 'utf8'), 'err');
  const files = (await run(['git'], ['-C', ready.worktree, 'ls-tree', '-r', '--name-only', 'HEAD'])).stdout;
  assert(!files.includes('.ai-team'));
  assert(team.events(job.id).some(e => e.details?.prompt?.includes('.ai-team/attachments/shot.png')));
  await assert.rejects(team.create({ project: 'test', goal: 'x', files: Array(11).fill({ name: 'a', data: 'YQ==' }) }), /10/);
});

test('agy quota counts only the bucket group of the member model', async t => {
  const f = await fixture(); f.config.demo = false;
  f.config.agents = f.config.agents.map(a => a.id === 'gemini' ? { ...a, provider: 'antigravity', model: 'gemini-3.8-flash-high' } : { ...a, provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) });
  const w = remaining => [{ name: 'quota', remaining, minutes: null, resetsAt: null }];
  const team = new Team(f.config, f.data, { readQuota: async a => ({ buckets: a.provider === 'antigravity' ? [{ id: 'gemini-5h', windows: w(98) }, { id: '3p-5h', windows: w(0) }] : [] }) });
  t.after(() => team.close());
  await team.refreshQuota();
  assert.equal(team.remaining('gemini'), 98); assert.equal(team.lowQuota('gemini'), false);
  team.config.agents.find(a => a.id === 'gemini').model = 'claude-opus';
  assert.equal(team.remaining('gemini'), 0);
});

test('maxJobsPerAccount lets one account run several jobs at once, each in its own slot', async t => {
  const f = await fixture(); f.config.demo = false; f.config.maxJobsPerAccount = 2; f.config.resources = { reserveGB: 0, ramPerAgentGB: 0.01, maxAgents: 4, hardStopRamPercent: 100 };
  f.config.agents = f.config.agents.map(a => ({ ...a, provider: 'codex', home: mkdtempSync(join(tmpdir(), 'h-')) }));
  f.config.pipeline.builders = ['codex-2'];
  let now = 0, peak = 0, release; const slots = new Set(), held = new Set(), plans = [], together = new Promise(r => { release = r; });
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
    if (task.stage === 'plan') plans.push(prompt);
    if (task.stage === 'implement') {
      assert(!held.has(task.slot), 'hai việc cùng giữ một slot'); held.add(task.slot); slots.add(task.slot);
      peak = Math.max(peak, ++now); if (now === 2) release();
      const timeout = setTimeout(release, 10000); await together; clearTimeout(timeout); now--; held.delete(task.slot);
    }
    return runAgent({ ...agent, provider: 'mock' }, task, prompt, opts);
  }, readQuota: async () => ({ buckets: [] }) });
  t.after(() => team.close());
  const jobs = [await team.create({ project: 'test', goal: 'Update hello' }), await team.create({ project: 'test', goal: 'Update hello' }), await team.create({ project: 'test', goal: 'Update hello' })];
  for (const j of jobs) await settle(team, j.id, 'ready');
  assert.equal(peak, 2); assert.deepEqual([...slots].sort(), [1, 2]); // việc thứ 3 chờ, không nhận trùng slot
  assert(plans.some(p => p.includes('"otherJobs"')), 'Lead của việc sau phải thấy các việc đang chạy cùng project');
  // slot 1 không kế thừa CODEX_SQLITE_HOME của tiến trình cha; slot ≥ 2 nhận thư mục riêng
  process.env.CODEX_SQLITE_HOME = '/parent/state'; t.after(() => delete process.env.CODEX_SQLITE_HOME);
  const home = team.agent('codex-2').home;
  assert.equal(childEnv({ provider: 'codex', home }).CODEX_SQLITE_HOME, undefined);
  assert.equal(childEnv({ provider: 'codex', home, sqliteHome: join(home, 'sqlite-2') }).CODEX_SQLITE_HOME, join(home, 'sqlite-2'));
  // sqlite_home trong config.toml ghi đè biến môi trường → tắt song song cho tài khoản đó
  writeFileSync(join(home, 'config.toml'), 'sqlite_home = "C:/shared"\n'); assert.equal(team.maxJobs('codex-2'), 1);
  writeFileSync(join(home, 'config.toml'), '');
  assert.equal(team.maxJobs('codex-2'), 2); team.config.maxJobsPerAccount = undefined; assert.equal(team.maxJobs('codex-2'), 1);
});

test('Manager-proposed flow: chosen reviewer, skipped verify forced back by the risk gate, invalid id falls back, absent steps keep the old default', async t => {
  const run = async (flow, cfg = c => c) => {
    const f = await fixture(); cfg(f.config); const calls = [];
    const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => {
      calls.push({ stage: task.stage, agent: agent.id });
      const r = await runAgent(agent, task, prompt, opts);
      if (task.stage === 'plan' && flow) r.flow = flow;
      return r;
    } });
    t.after(() => team.close());
    const job = await team.create({ project: 'test', goal: 'Update hello' });
    return { job: await settle(team, job.id, 'ready'), calls, ev: team.events(job.id) };
  };
  // (a) Manager chọn reviewer khác roster (roster.reviewer = gemini)
  const a = await run({ reviewer: 'codex-1', steps: ['review'] });
  assert.equal(a.calls.find(c => c.stage === 'review').agent, 'codex-1'); assert.equal(a.job.checkers.reviewer, 'codex-1');
  assert(!a.calls.some(c => c.stage === 'verify')); assert(a.job.skipped.includes('final'));
  // (b) Manager bỏ verify nhưng cổng rủi ro ép lại (file nhạy cảm) → ghi override
  const b = await run({ steps: ['review'] }, c => { c.sensitivePaths = 'hello'; });
  assert(b.calls.some(c => c.stage === 'verify')); assert.equal(b.job.verified, b.job.revision);
  assert(b.job.flow.overrides.some(o => o.step === 'verify')); assert(b.ev.some(e => e.type === 'OVERRIDE'));
  // (c) id không hợp lệ → fallback roster + WARNING
  const c = await run({ reviewer: 'khong-ton-tai' });
  assert.equal(c.job.flow.reviewer, null); assert.equal(c.calls.find(x => x.stage === 'review').agent, 'gemini');
  assert(c.ev.some(e => e.type === 'WARNING' && /khong-ton-tai/.test(e.summary)));
  // (d) không gửi steps → giữ mặc định cũ: standard không có cổng rủi ro thì KHÔNG verify (tránh lỗi wants() mặc định = true)
  const d = await run({ reviewer: 'codex-1' });
  assert(d.calls.some(x => x.stage === 'review')); assert(!d.calls.some(x => x.stage === 'verify'));
  // (e) steps: [] khác với không gửi: Manager bỏ hết, test vẫn chạy, không có review/verify/final
  const e = await run({ steps: [] });
  assert(!e.calls.some(x => ['review', 'verify', 'final'].includes(x.stage))); assert.equal(e.job.tested, e.job.revision);
});

test('per-member speed and token use are measured and shown to the lead', async t => {
  const f = await fixture();
  const { runAgent } = await import('../src/providers.js');
  const team = new Team(f.config, f.data, { runAgent: async (agent, task, prompt, opts) => { opts.onEvent('USAGE', { summary: 'u', details: { input_tokens: 1000, output_tokens: 200 } }); return runAgent(agent, task, prompt, opts); } });
  t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  await settle(team, job.id, 'ready');
  const sp = team.members(['codex-2'])[0].speed;
  assert(sp.samples >= 1); assert.equal(sp.avgTokensPerCall, 1200);
  const plan = team.events(job.id).find(e => e.details?.stage === 'plan');
  assert.match(plan.details.prompt, /avgTokensPerCall/);
});

test('fast path escalates to the Manager when tests fail; risk gate forces a review', async t => {
  const f = await fixture(); f.config.projects[0].tests = [[process.execPath, '-e', "process.exit(require('fs').existsSync('ok.flag')?0:1)"]];
  const team = new Team(f.config, f.data); t.after(() => team.close());
  const job = await team.create({ project: 'test', goal: 'Update hello text', mode: 'fast' });
  await settle(team, job.id, 'blocked', 60000);
  const ev = team.events(job.id);
  assert(ev.some(e => e.type === 'ESCALATE')); assert(ev.some(e => e.details?.stage === 'plan'));
  const f2 = await fixture(); f2.config.sensitivePaths = 'hello';
  const team2 = new Team(f2.config, f2.data); t.after(() => team2.close());
  const j2 = await team2.create({ project: 'test', goal: 'Update hello text', mode: 'fast' });
  const r2 = await settle(team2, j2.id, 'ready', 60000);
  assert.equal(r2.reviewed, r2.revision); assert(!r2.skipped.includes('review'));
});

test('read-only reference folders map to Claude permission paths', async () => {
  const { claudePath } = await import('../src/providers.js');
  assert.equal(claudePath('D:\\docs\\spec\\'), '//d/docs/spec');
  assert.equal(claudePath('/srv/docs'), '//srv/docs');
});

test('RAM slots use absolute GB; percent is only the hard stop', () => {
  assert.deepEqual(computeSlots({ freeGB: 10, totalGB: 32, reserveGB: 4, ramPerAgentGB: 1.5, maxAgents: 3, maxAgentsHard: true }), { start: 3, hardStop: false });
  assert.equal(computeSlots({ freeGB: 4.5, totalGB: 32, reserveGB: 4, ramPerAgentGB: 1.5 }).start, 1); // idle → at least one agent
  assert.equal(computeSlots({ freeGB: 4.5, totalGB: 32, running: 1, reserveGB: 4, ramPerAgentGB: 1.5 }).start, 0);
  assert.equal(computeSlots({ freeGB: 20, totalGB: 32, running: 2, maxAgents: 3, maxAgentsHard: true }).start, 1);
  assert.deepEqual(computeSlots({ freeGB: 3, totalGB: 32, hardStopRamPercent: 90 }), { start: 0, hardStop: true });
  assert.deepEqual(testList('node --test "a b.js"\n\n'), [['node', '--test', 'a b.js']]);
  assert.throws(() => testList([['node', 1]])); assert.throws(() => testList([[]]));
});

// Lead trả plan song song; builder giả ghi file riêng và ghi lại thời gian chạy.
test('parallel child evidence is archived before task worktrees are removed', async t => {
  const { team } = await parallelTeam(t, [
    { agent: 'codex-2', difficulty: 2, instruction: 'T1 edit', files: ['t1.txt'], dependsOn: [] },
    { agent: 'codex-4', difficulty: 2, instruction: 'T2 edit', files: ['t2.txt'], dependsOn: [] },
  ]);
  const agentRun = team.agentRun, worktrees = [];
  team.agentRun = async (agent, task, prompt, opts) => {
    const report = await agentRun(agent, task, prompt, opts);
    if (task.stage === 'implement') {
      worktrees.push(task.worktree); mkdirSync(join(task.worktree, '.ai-team/evidence'), { recursive: true });
      writeFileSync(join(task.worktree, '.ai-team/evidence/check.log'), agent.id);
    }
    return report;
  };
  team.start();
  const job = await team.create({ project: 'test', goal: 'Parallel evidence' }), ready = await settle(team, job.id, 'ready');
  assert.equal(worktrees.length, 2); assert(worktrees.every(w => !existsSync(w)));
  const entries = ready.evidence.filter(e => e.stage === 'implement'); assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.revision, ready.revision);
    assert.equal(readFileSync(team.evidenceFile(job.id, `${entry.dir}/.ai-team/evidence/check.log`).file, 'utf8'), entry.agent);
  }
});

test('token budget per job: a job over maxTokensPerJob stops before the next AI call', async t => {
  const f = await fixture();
  const config = { demo: true, maxRamPercent: 100, maxCpuPercent: 100, maxTokensPerJob: 1000,
    agents: [{ id: 'solo', label: 'solo', provider: 'mock' }],
    pipeline: { manager: 'solo', builders: ['solo'], reviewer: 'solo', verifier: 'solo' },
    projects: [{ id: 'test', path: f.path, tests: [] }] };
  let calls = 0;
  const team = new Team(config, f.data, { runAgent: (...a) => { calls++; return runAgent(...a); } });
  t.after(async () => { await team.close(); rmSync(f.data, { recursive: true, force: true }); rmSync(f.path, { recursive: true, force: true }); });
  team.save({ id: 'budget', project: 'test', goal: 'x', status: 'queued', stage: 'plan', worktree: f.path, tasks: [], taskIndex: 0, reports: [], messages: [], round: 0, usage: { calls: 7, tokens: 5000 } });
  await team.tick();
  const job = team.get('budget');
  assert.equal(job.status, 'blocked'); assert.match(job.error, /5000.*1000/); assert.equal(calls, 0);
  assert.equal(team.state().limits.tokens, 1000);
  // Tiếp tục: tính lại từ sự kiện USAGE (Codex: trừ phần cache); vẫn vượt thì cấp thêm một lượt ngân sách.
  team.event('budget', 'solo', 'controller', 'USAGE', 'u', { input_tokens: 900000, cached_input_tokens: 899500, output_tokens: 100 });
  await team.control('budget', 'resume'); let j = team.get('budget');
  assert.equal(j.usage.tokens, 600); assert.equal(j.tokenBudget, undefined); assert.equal(j.status, 'queued');
  team.save({ ...j, status: 'blocked', usage: { calls: 9, tokens: 5000 } }); team.event('budget', 'solo', 'controller', 'USAGE', 'u', { input_tokens: 2000, output_tokens: 0 });
  await team.control('budget', 'resume'); j = team.get('budget');
  assert.equal(j.usage.tokens, 2600); assert.equal(j.tokenBudget, 3600);
});

test('legacy memory migration preserves ids and isolates notes from unmerged jobs', async () => {
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE memory(id INTEGER PRIMARY KEY,project TEXT,session TEXT,kind TEXT,text TEXT,job TEXT,at TEXT);`);
    db.prepare('INSERT INTO jobs VALUES(?,?)').run('old-job', JSON.stringify({ kind: 'code', status: 'ready' }));
    db.prepare('INSERT INTO memory(id,project,kind,text,job,at) VALUES(1,?,?,?,?,?)').run('old-project', 'fact', 'legacy shared convention', 'user', new Date().toISOString());
    db.prepare('INSERT INTO memory(id,project,kind,text,job,at) VALUES(2,?,?,?,?,?)').run('old-project', 'fact', 'unmerged branch observation', 'old-job', new Date().toISOString());
    const store = new MemoryStore(db, redact), before = store.rows('old-project');
    assert.equal(before.length, 2); assert.equal(before[0].id, 1); assert.equal(before[1].scope, 'job');
    assert.equal(store.candidates('old-project', null, '').length, 1);
    assert.equal(store.candidates('old-project', 'old-job', '').length, 2);
    assert.deepEqual(new MemoryStore(db, redact).rows('old-project').map(r => r.uid), before.map(r => r.uid));
  } finally { db.close(); }
});

test('peer dialogue limit preserves parallel partial work and resumes the same stage with human guidance', async t => {
  const f = await fixture(); let consults = 0, plans = 0;
  const agentRun = async (agent, task, prompt, opts) => {
    const d = task.discussions?.findLast(d => d.stage === 'implement' && d.task === 0);
    if (task.stage === 'plan') { plans++; return { summary: 'Two independent tasks', kind: 'code', rigor: 'standard', risk: 'low', tasks: [{ agent: 'codex-2', difficulty: 2, instruction: 'Uncertain greeting', files: ['hello.txt', 'partial.txt'], dependsOn: [] }, { agent: 'codex-4', difficulty: 2, instruction: 'Independent file', files: ['other.txt'], dependsOn: [] }] }; }
    if (task.stage === 'consult') { consults++; return { summary: 'Still uncertain', status: 'completed', stance: 'disagree', answer: 'The assumption remains unsupported', evidence: ['hello.txt:1'] }; }
    if (task.stage === 'implement' && task.tasks[task.running.find(r => r.agent === agent.id && r.stage === 'implement').task].instruction === 'Independent file') { writeFileSync(join(task.worktree, 'other.txt'), 'completed parallel work\n'); return { summary: 'Independent task complete', status: 'completed' }; }
    if (task.stage === 'implement') {
      if (task.messages.some(m => m.text === 'Use the configured greeting')) {
        assert.equal(readFileSync(join(task.worktree, 'partial.txt'), 'utf8'), 'keep partial work\n'); assert(prompt.includes('The assumption remains unsupported'));
        writeFileSync(join(task.worktree, 'hello.txt'), 'Hello from AI Team demo!\n');
        return { summary: 'Followed human guidance', status: 'completed', dialogueDecision: { thread: d.id, outcome: 'accepted', reason: 'Human chose the configured contract', evidence: ['human message'] } };
      }
      writeFileSync(join(task.worktree, 'partial.txt'), 'keep partial work\n'); writeFileSync(join(task.worktree, 'hello.txt'), 'partial greeting\n');
      return { summary: 'Need a decision', status: 'waiting_for_reply', peerRequest: { to: 'codex-3', ...(d ? { thread: d.id } : {}), topic: 'Uncertain greeting', claim: 'Current draft is sufficient', question: 'Can you confirm the contract?', evidence: ['hello.txt:1'] }, checkpoint: { done: 'Partial greeting saved', remaining: 'Contract decision', next: 'Resolve uncertainty' } };
    }
    return runAgent(agent, task, prompt, opts);
  };
  const team = new Team(f.config, f.data, { runAgent: agentRun }); t.after(() => team.close());
  team.capacity = () => ({ start: Math.max(0, 2 - team.runs.size - team.extra), hardStop: false });
  const job = await team.create({ project: 'test', goal: 'Update greeting and another file' });
  const waiting = await settle(team, job.id, 'waiting', 40000);
  assert.equal(consults, 2); assert.equal(waiting.stage, 'implement'); assert.equal(waiting.tasks[0].done, false); assert.equal(waiting.tasks[1].done, true);
  assert.equal(waiting.discussions[0].rounds, 2); assert.equal(waiting.discussions[0].status, 'unresolved'); assert.equal(waiting.tested, null);
  assert.equal(readFileSync(join(waiting.worktree, 'hello.txt'), 'utf8'), 'partial greeting\n');
  assert.equal(readFileSync(join(waiting.worktree, 'other.txt'), 'utf8'), 'completed parallel work\n');
  assert.equal((await run(['git'], ['-C', waiting.worktree, 'status', '--porcelain'])).stdout.trim(), '');
  await assert.rejects(team.merge(job.id)); await team.close();
  const reopened = new Team(f.config, f.data, { runAgent: agentRun }); t.after(() => reopened.close());
  reopened.capacity = () => ({ start: reopened.runs.size ? 0 : 1, hardStop: false });
  await reopened.control(job.id, 'message', { message: 'Use the configured greeting' });
  assert.equal(reopened.get(job.id).stage, 'implement');
  const ready = await settle(reopened, job.id, 'ready', 40000);
  assert.equal(plans, 1); assert.equal(consults, 2); assert(ready.tasks.every(t => t.done)); assert.equal(ready.discussions[0].status, 'resolved');
  assert.equal(ready.tested, ready.revision); assert.equal(ready.reviewed, ready.revision);
});

test('work transfer preserves binary/new/deleted files and checkpoints but imports paused without approvals or credentials', async t => {
  const f = await fixture(), source = new Team(f.config, f.data); source.closed = true; t.after(() => source.close());
  writeFileSync(join(f.path, 'remove.txt'), 'Remove this file');
  await run(['git'], ['-C', f.path, 'add', '.']);
  await run(['git'], ['-C', f.path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'deletion fixture']);
  const job = await source.create({ project: 'test', goal: 'Continue imported hello', paused: true });
  job.tasks = [{ instruction: 'Finish hello', done: false, checkpoint: { done: 'Started hello', remaining: 'Verify the result', next: 'Run tests' } }]; source.save(job);
  job.discussions = [{ id: 'D-history', status: 'pending', from: 'old-member', to: 'old-peer', messages: [{ text: 'Old question is source data' }], rounds: 1 }]; source.save(job);
  source.editMemory({ project: 'test', add: 'Shared project convention' });
  await source.remember(job, { add: ['Pending job observation'] });
  writeFileSync(join(job.worktree, 'hello.txt'), 'unfinished hello');
  writeFileSync(join(job.worktree, 'binary.dat'), Buffer.from([0, 255, 1, 200]));
  rmSync(join(job.worktree, 'remove.txt'));
  const pack = await exportTransfer(source, job.id);
  assert.equal(pack.format, 'ai-team-transfer'); assert.equal(pack.work.tasks[0].checkpoint.remaining, 'Verify the result');
  const copy = mkdtempSync(join(tmpdir(), 'ai-team-import-'));
  await run(['git'], ['clone', f.path, copy]);
  const config = structuredClone(f.config); config.projects[0].path = copy;
  const target = new Team(config, mkdtempSync(join(tmpdir(), 'ai-team-import-state-'))); target.closed = true; t.after(() => target.close());
  const result = await importTransfer(target, 'test', pack), imported = result.job;
  assert.equal(imported.status, 'paused'); assert.equal(imported.stage, 'plan'); assert.equal(imported.tested, null); assert.equal(imported.reviewed, null); assert.equal(imported.verified, null);
  assert.equal(readFileSync(join(imported.worktree, 'hello.txt'), 'utf8'), 'unfinished hello');
  assert.deepEqual(readFileSync(join(imported.worktree, 'binary.dat')), Buffer.from([0, 255, 1, 200]));
  assert.throws(() => readFileSync(join(imported.worktree, 'remove.txt')), /ENOENT/);
  assert.equal(imported.transfer.tasks[0].checkpoint.next, 'Run tests'); assert.deepEqual(imported.tasks, []);
  assert.equal(imported.transfer.discussions[0].id, 'D-history'); assert.equal(imported.discussions, undefined);
  assert.equal(imported.obligations[0].id, 'D-history'); assert.equal(imported.obligations[0].status, 'unmapped');
  assert.equal(JSON.parse(readFileSync(join(imported.worktree, imported.transferFile), 'utf8')).tasks[0].checkpoint.next, 'Run tests');
  let planPrompt;
  target.agentRun = async (agent, task, prompt, opts) => { planPrompt = prompt; return runAgent(agent, task, prompt, opts); };
  await target.invoke(imported, 'codex-1', 'plan', 'Inspect imported work', undefined, [], {}, target.agent('codex-1'), new AbortController().signal);
  assert(planPrompt.includes(imported.transferFile)); assert(!planPrompt.includes('Run tests'));
  target.agentRun = async () => { writeFileSync(join(imported.worktree, 'binary.dat'), Buffer.from([0, 255, 2, 200])); return { summary: 'changed a pending file', status: 'planned' }; };
  await assert.rejects(target.invoke(imported, 'codex-1', 'plan', 'Read only', undefined, [], {}, target.agent('codex-1'), new AbortController().signal), /chỉ đọc/);
  writeFileSync(join(imported.worktree, 'binary.dat'), Buffer.from([0, 255, 1, 200]));
  assert.equal((await exportTransfer(target, imported.id)).work.tasks[0].checkpoint.next, 'Run tests');
  imported.tasks = [{ instruction: 'Recheck transferred issue', files: ['hello.txt'], agent: 'codex-2' }]; target.save(imported);
  await assert.rejects(target.control(imported.id, 'adopt-discussion', { thread: 'D-history', task: 0, recipient: 'old-peer' }), /current member/);
  const adopted = await target.control(imported.id, 'adopt-discussion', { thread: 'D-history', task: 0, recipient: 'gemini' });
  assert.equal(adopted.obligations[0].status, 'adopted'); assert.equal(adopted.discussions[0].to, 'gemini'); assert.equal(adopted.discussions[0].status, 'reopened'); assert.equal(adopted.discussions[0].requestReport, undefined);
  assert.equal(adopted.tested, null); assert.equal(adopted.discussions[0].source.thread, 'D-history');
  const reexported = await exportTransfer(target, imported.id);
  assert(reexported.work.obligations.every(o => o.id !== 'D-history'));
  const reimported = await importTransfer(target, 'test', reexported);
  assert.equal(reimported.job.obligations.length, 1); assert.equal(reimported.job.obligations[0].id, adopted.discussions[0].id);
  assert(target.memory('test').facts.some(r => r.scope === 'job' && r.job === imported.id));
  assert.equal(readFileSync(join(copy, 'hello.txt'), 'utf8').replace(/\r\n/g, '\n'), 'Hello!\n');
  const unsafe = structuredClone(pack); unsafe.code.files[0].path = '../escape';
  const count = target.jobs().length;
  await assert.rejects(importTransfer(target, 'test', unsafe), /Unsafe/); assert.equal(target.jobs().length, count);
  const corrupt = structuredClone(pack); corrupt.code.sha256 = '0'.repeat(64);
  await assert.rejects(importTransfer(target, 'test', corrupt), /checksum/); assert.equal(target.jobs().length, count);
  writeFileSync(join(job.worktree, '.env'), 'PRIVATE_KEY=must not transfer');
  await run(['git'], ['-C', job.worktree, 'add', '-f', '.env']);
  await assert.rejects(exportTransfer(source, job.id), /Unsafe/);
  assert.equal(source.runs.size, 0);
});
