import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Team, reworkDigest, reworkSummaryText } from '../src/team.js';
import { run } from '../src/process.js';

test('reworkDigest separates owner scope additions from builder defects and truncates claims', () => {
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
  assert.deepEqual(d.rounds[0].findings.map(f => [f.origin, f.open]), [['builder', false]]);
  assert.deepEqual(d.rounds[1].findings.map(f => [f.id, f.origin, f.open]), [['F1', 'builder', true], ['F2', 'owner', true]]);
  assert.deepEqual(d.open, ['F1', 'F2']);
  const text = reworkSummaryText(d);
  assert.match(text, /Vòng 1/); assert.match(text, /Vòng 2/); assert.match(text, /\[F2\] Owner wants dark mode/);
  assert(text.length <= 7000);
  // Vòng cuối là test fail thì không còn finding mở.
  job.reports.push({ stage: 'test', summary: 'Test failed: npm test' });
  const t = reworkDigest(job, 2);
  assert.equal(t.rounds.at(-1).verdict, 'failed'); assert.deepEqual(t.open, []);
});

test('rework limit explains rounds, owner scope adds +1 round, extraRound resume runs exactly one more', async t => {
  const path = mkdtempSync(join(tmpdir(), 'ai-team-rework-')), data = mkdtempSync(join(tmpdir(), 'ai-team-rework-state-'));
  t.after(() => { rmSync(path, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); });
  await run(['git'], ['init', '-b', 'main', path]);
  await run(['git'], ['-C', path, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, planApproval: false, maxRamPercent: 100, maxCpuPercent: 100, maxReworkRounds: 0,
    agents: ['codex-1', 'codex-2', 'codex-3', 'codex-4', 'gemini'].map(id => ({ id, label: id, role: id, provider: 'mock' })),
    pipeline: { manager: 'codex-1', builders: ['codex-2', 'codex-4'], reviewer: 'gemini', verifier: 'codex-3' },
    projects: [{ id: 'test', path, tests: [[process.execPath, '-e', 'process.exit(7)']] }] };
  const team = new Team(config, data); t.after(() => team.close());
  const settle = async (id, timeoutMs = 60000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { const job = team.get(id); if (job.status === 'blocked' && !team.active) return job; await new Promise(r => setTimeout(r, 30)); }
    assert.fail(`Timeout: ${JSON.stringify(team.get(id))}`);
  };
  const job = await team.create({ project: 'test', goal: 'Fail test' });
  let blocked = await settle(job.id);
  assert.match(blocked.error, /giới hạn/); assert.match(blocked.error, /Vòng 1 · .* · failed/);
  assert.equal(blocked.round, 0); assert.equal(blocked.reworkDigest.limit, 0);

  await team.control(job.id, 'message', { message: 'Also add a footer' });
  assert.equal(team.get(job.id).scopeAdds.length, 1);
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
