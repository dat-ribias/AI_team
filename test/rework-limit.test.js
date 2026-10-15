import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team, reworkDigest, reworkSummaryText } from '../src/team.js';
import { run } from '../src/process.js';
import { runAgent } from '../src/providers.js';
import { msg } from '../src/i18n.js';

test('reworkDigest leaves legacy and new findings unknown without source evidence', () => {
  const long = 'x'.repeat(300);
  const job = { round: 2, scopeAdds: [{ reports: 2 }], reports: [
    { stage: 'implement' },
    { stage: 'review', agent: 'gemini', verdict: 'changes_requested', findings: [{ id: 'F1', claim: long, impact: 'medium' }] },
    { stage: 'implement' },
    { stage: 'review', agent: 'gemini', verdict: 'changes_requested', findings: [{ id: 'F1', claim: long, impact: 'medium' }, { id: 'F2', claim: 'Owner wants dark mode', impact: 'low' }] },
  ] };
  const d = reworkDigest(job, 2);
  assert.equal(d.limit, 2); assert.equal(d.scopeAdds, 1); assert.equal(d.rounds.length, 2);
  assert(d.rounds[0].findings[0].claim.length <= 121 && d.rounds[0].findings[0].claim.endsWith('…'));
  assert.deepEqual(d.rounds[0].findings.map(f => [f.origin, f.open]), [['unknown', false]]);
  assert.deepEqual(d.rounds[1].findings.map(f => [f.id, f.origin, f.open]), [['F1', 'unknown', true], ['F2', 'unknown', true]]);
  assert.deepEqual(d.open, ['F1', 'F2']);
  const text = reworkSummaryText(d);
  assert.match(text, /Vòng 1/); assert.match(text, /Vòng 2/); assert.match(text, /\[F2\] Owner wants dark mode/);
  assert(text.includes(msg('srv.team.rework_origin_unknown')));
  assert(!text.includes(msg('srv.team.rework_origin_builder')));
  assert(text.length <= 7000);
  // Vòng cuối là test fail thì không còn finding mở.
  job.reports.push({ stage: 'test', summary: 'Test failed: npm test' });
  const t = reworkDigest(job, 2);
  assert.equal(t.rounds.at(-1).verdict, 'failed'); assert.deepEqual(t.open, []);
});

test('reworkDigest validates owner references and reasons, preserving only the same finding source', () => {
  const review = findings => ({ stage: 'review', agent: 'reviewer', verdict: 'changes_requested', findings });
  const owner = { origin: 'owner', scopeAddId: 'S1', originReason: 'S1 requests the footer; the new footer is missing' };
  const builder = { origin: 'builder', originReason: 'The initial acceptance requires empty input support', evidence: 'src/input.js:10 rejects empty input' };
  const job = { round: 2, scopeAdds: [{ id: 'S1', reports: 1 }, { reports: 1 }], reports: [
    review([{ id: 'F1', claim: 'Empty input crashes', ...builder }, { id: 'F2', claim: 'Existing issue' }]),
    review([
      { id: 'F1', claim: 'Footer missing', ...owner }, // ID reused for a different claim.
      { id: 'F2', claim: 'Existing issue', ...owner }, // Present before S1.
      { id: 'F3', claim: 'Footer link missing', ...owner },
      { id: 'F4', claim: 'Unrecorded addition', ...owner, scopeAddId: 'missing' },
      { id: 'F5', claim: 'No source reason', ...owner, originReason: '' },
      { id: 'F6', claim: 'No builder evidence', origin: 'builder', originReason: 'Builder defect' },
      { id: 'F7', claim: 'Unsupported source', origin: 'other' },
      { id: 'F8', claim: 'Legacy owner attribution', origin: 'owner' },
    ]),
    { stage: 'verify', agent: 'verifier', verdict: 'changes_requested', findings: [
      { id: 'F1', claim: 'Footer missing' },
      { id: 'F3', claim: 'Footer link missing', ...builder }, // Proven prior source is retained.
      { id: 'F9', claim: 'Unrelated claim with evidence', ...builder },
      { id: 'F9', claim: 'Different claim sharing ID' },
    ] },
  ] };
  const d = reworkDigest(job, 3);
  assert.deepEqual(d.rounds[0].findings.map(f => f.origin), ['builder', 'unknown']);
  assert.deepEqual(d.rounds[1].findings.map(f => f.origin), ['owner', 'unknown', 'owner', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  assert.deepEqual(d.rounds[2].findings.map(f => f.origin), ['owner', 'owner', 'builder', 'unknown']);
  assert(d.rounds.slice(0, -1).every(r => r.findings.every(f => !f.open)));
  assert(d.rounds.at(-1).findings.every(f => f.open));
  assert.deepEqual(d.open, ['F1', 'F3', 'F9', 'F9']);
  const text = reworkSummaryText(d);
  assert(text.includes(msg('srv.team.rework_origin_owner')));
  assert(text.includes(msg('srv.team.rework_origin_builder')));
  assert(text.includes(msg('srv.team.rework_origin_unknown')));
  assert(text.includes(msg('srv.team.rework_still_open')));
});

test('reworkDigest compares claims before display truncation and keeps origins across intervening checks', () => {
  const claim = 'x'.repeat(120), owner = { origin: 'owner', scopeAddId: 'S1', originReason: 'This finding implements the recorded addition' };
  const findings = [
    [{ id: 'F1', claim: claim + 'first', ...owner }],
    [{ id: 'F1', claim: claim + 'second' }],
    [{ id: 'F1', claim: claim + 'first' }],
  ];
  const d = reworkDigest({ scopeAdds: [{ id: 'S1', reports: 0 }], reports: findings.map(f => ({ stage: 'review', findings: f })) }, 2);
  assert.deepEqual(d.rounds.map(r => r.findings[0].origin), ['owner', 'unknown', 'owner']);
});

test('long summaries retain every final-round open finding within the text limit', () => {
  const job = { reports: Array.from({ length: 12 }, (_, n) => ({ stage: 'review', agent: 'reviewer', verdict: 'changes_requested', findings: Array.from({ length: 10 }, (_, f) => ({ id: `F${f}`, claim: `Round ${n}: ` + 'x'.repeat(200) })) })) };
  const d = reworkDigest(job, 12), text = reworkSummaryText(d);
  assert(text.length <= 7000);
  assert.match(text, /Vòng 12/);
  for (const f of d.rounds.at(-1).findings) assert(text.includes(`[${f.id}] ${f.claim} (${msg('srv.team.rework_origin_unknown')}, ${msg('srv.team.rework_still_open')})`));
});

test('rework limit with high findings includes the round summary in job.error and the owner question', async t => {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-rework-')), data = mkdtempSync(join(tmpdir(), 'ai-team-rework-state-'));
  let team;
  t.after(async () => { await team?.close(); rmSync(path, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); });
  await run(['git'], ['init', '-b', 'main', path]);
  await run(['git'], ['-C', path, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, planApproval: false, maxRamPercent: 100, maxCpuPercent: 100, maxReworkRounds: 0,
    agents: ['codex-1', 'codex-2', 'codex-3', 'codex-4', 'gemini'].map(id => ({ id, label: id, role: id, provider: 'mock' })),
    pipeline: { manager: 'codex-1', builders: ['codex-2', 'codex-4'], reviewer: 'gemini', verifier: 'codex-3' },
    projects: [{ id: 'test', path, tests: [[process.execPath, '-e', 'process.exit(0)']] }] };
  team = new Team(config, data, { runAgent: async (agent, task, prompt, opts) => {
    const r = await runAgent(agent, task, prompt, opts);
    return task.stage === 'review' ? { ...r, verdict: 'changes_requested', findings: [{ id: 'F1', claim: 'Missing empty file handling', impact: 'high' }] } : r;
  } });
  const job = await team.create({ project: 'test', goal: 'Update hello' });
  const end = Date.now() + 60000;
  let waiting;
  while (Date.now() < end) {
    const current = team.get(job.id);
    if (current.status === 'waiting' && !team.active) { waiting = current; break; }
    await new Promise(r => setTimeout(r, 30));
  }
  assert(waiting, `Timeout: ${JSON.stringify(team.get(job.id))}`);
  assert.equal(waiting.status, 'waiting');
  assert.match(waiting.error, /giới hạn/); assert.match(waiting.error, /Vòng 1/);
  assert.match(waiting.error, /\[F1\] Missing empty file handling/);
  assert(waiting.error.includes(msg('srv.team.rework_origin_unknown')));
  assert(waiting.error.includes(msg('srv.team.rework_still_open')));
  assert.deepEqual(waiting.reworkDigest.open, ['F1']);
  assert.equal(waiting.reports.findLast(r => r.stage === 'review').findings[0].origin, 'unknown');
  assert(team.events(job.id).some(e => e.type === 'QUESTION' && /Vòng 1/.test(e.summary) && /\[F1\] Missing empty file handling/.test(e.summary)));
  assert(team.events(job.id).find(e => e.type === 'REVIEW_RESULT').details.findings.every(f => f.origin === 'unknown'));
});

test('rework limit explains rounds, owner scope adds +1 round, extraRound resume runs exactly one more', async t => {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-rework-')), data = mkdtempSync(join(tmpdir(), 'ai-team-rework-state-'));
  let team;
  t.after(async () => { await team?.close(); rmSync(path, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); });
  await run(['git'], ['init', '-b', 'main', path]);
  await run(['git'], ['-C', path, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, planApproval: false, maxRamPercent: 100, maxCpuPercent: 100, maxReworkRounds: 0,
    agents: ['codex-1', 'codex-2', 'codex-3', 'codex-4', 'gemini'].map(id => ({ id, label: id, role: id, provider: 'mock' })),
    pipeline: { manager: 'codex-1', builders: ['codex-2', 'codex-4'], reviewer: 'gemini', verifier: 'codex-3' },
    projects: [{ id: 'test', path, tests: [[process.execPath, '-e', 'process.exit(7)']] }] };
  team = new Team(config, data);
  const settle = async (id, timeoutMs = 60000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { const job = team.get(id); if (job.status === 'blocked' && !team.active) return job; await new Promise(r => setTimeout(r, 30)); }
    assert.fail(`Timeout: ${JSON.stringify(team.get(id))}`);
  };
  const job = await team.create({ project: 'test', goal: 'Fail test' });
  let blocked = await settle(job.id);
  assert.match(blocked.error, /giới hạn/); assert.match(blocked.error, /Vòng 1 · .* · failed/);
  assert.equal(blocked.round, 0); assert.equal(blocked.reworkDigest.limit, 0);
  assert(team.events(job.id).some(e => e.type === 'BLOCKER' && /Vòng 1/.test(e.summary)));

  await team.control(job.id, 'message', { message: 'Also add a footer' });
  assert.equal(team.get(job.id).scopeAdds.length, 1);
  const addition = team.get(job.id).scopeAdds[0];
  assert(addition.id); assert.equal(team.get(job.id).messages[addition.message].text, 'Also add a footer');
  blocked = await settle(job.id);
  assert.equal(blocked.reworkDigest.limit, 1); assert.equal(blocked.round, 1);

  await team.control(job.id, 'resume', { extraRound: true });
  assert(team.events(job.id).some(e => e.type === 'CONTROL' && /thêm 1 vòng/.test(e.summary)));
  blocked = await settle(job.id);
  assert.equal(blocked.extraRounds, 1); assert.equal(blocked.reworkDigest.limit, 2); assert.equal(blocked.round, 2);
  assert(team.events(job.id).filter(e => e.type === 'BLOCKER').every(e => /giới hạn/.test(e.summary)));

  await team.control(job.id, 'pause', { handoff: true });
  const paused = team.get(job.id);
  assert.equal(paused.status, 'paused'); assert(paused.handoff?.at);
});

test('scope additions survive stale saves while plan gate and peer wait replies grant no rounds', async () => {
  let saved = { id: 'job', status: 'waiting', messages: [], plans: [{}], tasks: [], reports: [], round: 0, planGate: { version: 1 }, roster: { manager: 'manager' } };
  const context = {
    runs: new Map(), get: () => structuredClone(saved), attach: async () => [], jobRoster: () => saved.roster,
    kick() {}, event() {}, save: job => { saved = structuredClone(job); },
  };
  await Team.prototype.control.call(context, 'job', 'message', { message: 'Please revise the plan' });
  assert.equal(saved.scopeAdds, undefined);
  Object.assign(saved, { status: 'waiting', peerWait: 'thread' });
  await Team.prototype.control.call(context, 'job', 'message', { message: 'Answer to teammate' });
  assert.equal(saved.scopeAdds, undefined);
  Object.assign(saved, { status: 'running' });
  const stale = structuredClone(saved);
  await Team.prototype.control.call(context, 'job', 'message', { message: 'Add footer scope' });
  assert.equal(saved.scopeAdds.length, 1);
  const db = { prepare: sql => sql.startsWith('SELECT') ? { get: () => ({ body: JSON.stringify(saved) }) } : { run: (id, body) => { saved = JSON.parse(body); } } };
  Team.prototype.save.call({ db, runs: new Map(), emit() {} }, stale);
  assert.equal(saved.scopeAdds.length, 1);
  assert.equal(saved.messages[saved.scopeAdds[0].message].text, 'Add footer scope');
});

test('a final failed test emits BLOCKER with job.error and does not reopen old high findings', async () => {
  const job = { id: 'job', status: 'queued', stage: 'rework', round: 0, messages: [], roster: { manager: 'manager' }, reports: [
    { stage: 'review', agent: 'reviewer', verdict: 'changes_requested', findings: [{ id: 'F1', claim: 'Old high finding', impact: 'high' }] },
    { stage: 'test', summary: 'Test failed: exit 7' },
  ] };
  const events = [], context = {
    config: { maxReworkRounds: 0 }, runs: new Map(), get: () => job, save() {}, emit() {}, kick() {},
    planBlocked: () => false, event: (...args) => events.push(args),
    step: current => Team.prototype.step.call(context, current),
  };
  await Team.prototype.runJob.call(context, job);
  assert.equal(job.status, 'blocked');
  assert.deepEqual(job.reworkDigest.open, []);
  assert.equal(job.reworkDigest.rounds[0].findings[0].open, false);
  assert.match(job.error, /\[F1\] Old high finding/); assert.match(job.error, /Vòng 2/);
  assert.equal(events.at(-1)[3], 'BLOCKER'); assert.equal(events.at(-1)[4], job.error);
});
