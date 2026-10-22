import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Team, redact } from '../src/team.js';
import { fileHash, hash } from '../src/memory.js';
import { run } from '../src/process.js';

async function fixture(t, prepare) {
  const root = mkdtempSync(join(tmpdir(), 'ai-team-memory-')), path = join(root, 'project'), data = join(root, 'state');
  mkdirSync(path); writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  await run(['git'], ['init', '-b', 'main', path]);
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, backup: false, agents: [{ id: 'codex-1', provider: 'mock' }],
    pipeline: { manager: 'codex-1', builders: ['codex-1'], reviewer: 'codex-1', verifier: 'codex-1' },
    projects: [{ id: 'test', path, tests: [] }, { id: 'linked', path: join(root, 'linked'), tests: [] }] };
  if (prepare) { mkdirSync(data); await prepare({ root, path, data, config }); }
  let team = new Team(config, data, { runAgent: async () => { throw new Error('Unexpected agent call'); } });
  t.after(async () => { await team.close(); rmSync(root, { recursive: true, force: true }); });
  return { path, data, config, get team() { return team; }, async restart() { await team.close(); team = new Team(config, data); return team; } };
}

function conflict(action) {
  assert.throws(action, error => {
    assert.equal(error.code, 409);
    assert.equal(error.details?.code, 'SESSION_SUMMARY_CONFLICT');
    return true;
  });
}

test('memory redacts every supported secret in text and parseable JSON', () => {
  const secrets = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'].map(prefix => prefix + 'A1_b'.repeat(5));
  secrets.push('AKIA1234567890ABCDEF', 'ASIA1234567890ABCDEF', 'sk-12345678901234567890');
  for (const secret of secrets) {
    assert.equal(redact(`before ${secret} after`), 'before [REDACTED] after');
    assert.deepEqual(JSON.parse(redact(JSON.stringify({ value: secret, keep: 'ok' }))), { value: '[REDACTED]', keep: 'ok' });
  }
  for (const prefix of ['Authorization:', 'Authorization=', 'authorization:']) {
    for (const scheme of ['', 'Bearer ', 'Basic ', 'token ', 'Digest ']) {
      for (const value of [`${prefix}${scheme}private-value`, `${prefix}"${scheme}private-value"`]) {
        assert(!redact(value).includes('private-value'));
        assert(!JSON.parse(redact(JSON.stringify(value))).includes('private-value'));
      }
    }
  }
  assert.equal(redact('prefix Bearer private-value suffix'), 'prefix Bearer [REDACTED] suffix');
  assert.deepEqual(JSON.parse(redact(JSON.stringify({ Authorization: 'Bearer private-value', keep: 'ok' }))), { Authorization: '[REDACTED]', keep: 'ok' });
  // Keep the original system regression assertion intact, including its escaped quotes.
  for (const v of ['api_key="k1"', "get('Authorization:\"x\"')"]) { const out = JSON.parse(redact(JSON.stringify(v))); assert(!out.includes('k1') && !out.includes(':"x')); }
});

test('memory ignores evidence fingerprints when remembering and searching, but checks source files', async t => {
  const f = await fixture(t), team = f.team;
  const job = { id: 'research', project: 'test', kind: 'research', status: 'done', goal: 'Research this project', worktree: f.path,
    tasks: [{ files: ['hello.txt', '.ai-team/evidence/missing.png', '.ai-team\\evidence\\missing.png'] }] };
  await team.remember(job, { add: ['Fresh fact'] });
  assert.deepEqual(team.memoryStore.rows('test')[0].files, { 'hello.txt': fileHash(f.path, 'hello.txt') });
  team.memoryStore.add({ project: 'test', text: 'Legacy fact', files: { 'hello.txt': fileHash(f.path, 'hello.txt'), '.ai-team/evidence/missing.png': hash('gone') } });
  assert.equal((await team.searchMemory({ project: 'test' })).results.length, 2);
  writeFileSync(join(f.path, 'hello.txt'), 'Changed\n');
  assert.equal((await team.searchMemory({ project: 'test' })).results.length, 0);
});

test('promoteMerged and startup promotion are idempotent and only promote matching merged facts', async t => {
  const f = await fixture(t), store = f.team.memoryStore;
  const merged = { id: 'merged', project: 'test', status: 'merged', revision: 'a'.repeat(40) };
  f.team.db.prepare('INSERT INTO jobs(id,body) VALUES(?,?)').run(merged.id, JSON.stringify(merged));
  store.add({ project: 'test', text: 'Merged fact', job: merged.id, scope: 'job', commitSha: merged.revision });
  store.add({ project: 'test', text: 'Old revision', job: merged.id, scope: 'job', commitSha: 'b'.repeat(40) });
  store.add({ project: 'test', text: 'Ready fact', job: 'ready', scope: 'job' });
  store.promoteMerged([merged, { id: 'ready', status: 'ready' }]);
  const rows = store.rows('test', true);
  assert.equal(rows[0].scope, 'project'); assert.equal(rows[0].revision, 2);
  assert.equal(rows[1].status, 'superseded'); assert.equal(rows[2].scope, 'job');
  store.promoteMerged([merged]); assert.deepEqual(store.rows('test', true), rows);
  store.add({ project: 'test', text: 'Leftover fact', job: merged.id, scope: 'job', commitSha: merged.revision });
  await f.restart();
  assert.equal(f.team.memoryStore.rows('test').find(r => r.text === 'Leftover fact').scope, 'project');
  const promoted = f.team.memoryStore.rows('test', true); await f.restart();
  assert.deepEqual(f.team.memoryStore.rows('test', true), promoted);
});

test('outside research stays job scoped and legacy facts become stale once on startup', async t => {
  const f = await fixture(t), team = f.team;
  const job = { id: 'external', project: 'test', kind: 'research', status: 'done', goal: String.raw`Read D:\w\FE_NEW\docs`, worktree: f.path, tasks: [] };
  assert(team.outsideProject(job));
  assert(!team.outsideProject({ ...job, kind: 'code' }));
  assert(!team.outsideProject({ ...job, goal: 'No absolute paths' }));
  assert(!team.outsideProject({ ...job, goal: 'Read docs/guide and https://example.com/docs' }));
  for (const path of [f.path, f.data, homedir()]) assert(!team.outsideProject({ ...job, goal: `${job.goal} and "${path}"` }));
  assert(!team.outsideProject({ ...job, goal: 'Read D:\\w\\FE_NEW\\docs and D:\\linked\\docs', linked: [{ path: 'D:\\linked' }] }));
  assert(team.outsideProject({ ...job, goal: 'Read "D:\\w\\FE_NEW\\docs with spaces"' }));
  f.config.projects[0].access = { repos: [{ project: 'linked', members: [] }] };
  assert(!team.outsideProject({ ...job, goal: `Read "${f.config.projects[1].path}"` }));
  team.db.prepare('INSERT INTO jobs(id,body) VALUES(?,?)').run(job.id, JSON.stringify(job));
  team.memoryStore.add({ project: 'test', text: 'Legacy external fact', job: job.id });
  await team.remember(job, { add: ['New external fact'] });
  assert.equal(team.memoryStore.rows('test').find(r => r.text === 'New external fact').scope, 'job');
  assert(!team.memoryStore.candidates('test', 'another').some(r => r.text === 'New external fact'));
  await f.restart();
  assert.equal(f.team.memoryStore.candidates('test', 'another').length, 0);
  assert.equal(f.team.memoryStore.candidates('test', job.id).length, 0);
  const rows = f.team.memoryStore.rows('test', true);
  assert(rows.every(r => r.status === 'stale' && r.revision === 2));
  await f.restart(); assert.deepEqual(f.team.memoryStore.rows('test', true), rows);
});

test('markStale enforces project and revision and editMemory accepts stale', async t => {
  const f = await fixture(t), team = f.team, store = team.memoryStore;
  const id = store.add({ project: 'test', text: 'Outdated fact' });
  assert.throws(() => store.markStale('linked', id, 1), /reload/);
  assert.throws(() => store.markStale('test', id, 2), /reload/);
  team.editMemory({ project: 'test', stale: `M${id}`, revision: 1 });
  assert.equal(store.rows('test').length, 0);
  assert.equal(store.rows('test', true)[0].status, 'stale');
  assert.equal(store.rows('test', true)[0].revision, 2);
  assert.throws(() => store.markStale('test', id, 1), /reload/);
});

test('session summary migration preserves legacy notes and access across repeated restarts', async t => {
  const f = await fixture(t, ({ data }) => {
    const db = new DatabaseSync(join(data, 'team.sqlite'));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, access TEXT)");
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run('legacy', 'test', 'Legacy', 'Kept notes', '2026-01-01T00:00:00.000Z', JSON.stringify({ network: true }));
    db.close();
  });
  const check = () => {
    const columns = f.team.db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name);
    assert(columns.includes('notesRevision'));
    assert.deepEqual(f.team.memory('test', 'legacy'), { facts: [], log: [], summary: 'Kept notes', summaryRevision: 0 });
    const session = f.team.sessions().find(row => row.id === 'legacy');
    assert.equal(session.notesRevision, 0); assert.equal(session.access.network, true);
  };
  check(); await f.restart(); check(); await f.restart(); check();
});

test('owner summary writes use revisions atomically and remain isolated by project and session', async t => {
  const f = await fixture(t), team = f.team;
  const first = team.createSession({ project: 'test', name: 'First' });
  const second = team.createSession({ project: 'test', name: 'Second' });
  const linked = team.createSession({ project: 'linked', name: 'Linked' });
  assert.equal(first.notesRevision, 0); assert.equal(team.memory('test', first.id).summaryRevision, 0);

  const saved = team.editMemory({ project: 'test', session: first.id, summary: 'Owner one', summaryRevision: 0 });
  assert.equal(saved.summary, 'Owner one'); assert.equal(saved.summaryRevision, 1);
  conflict(() => team.editMemory({ project: 'test', session: first.id, summary: 'Legacy alias', revision: 1, add: 'Must not be stored' }));
  conflict(() => team.editMemory({ project: 'test', session: first.id, summary: 'Owner two', summaryRevision: 0, add: 'Must not be stored' }));
  conflict(() => team.editMemory({ project: 'test', session: first.id, summary: 'Missing revision', add: 'Also not stored' }));
  conflict(() => team.editMemory({ project: 'test', session: linked.id, summary: 'Wrong project', summaryRevision: 0, add: 'Wrong-project fact' }));
  assert.deepEqual(team.memory('test').facts, []);
  assert.equal(team.memory('test', first.id).summary, 'Owner one');

  let memory = team.editMemory({ project: 'test', session: first.id, summary: '', summaryRevision: 1 });
  assert.equal(memory.summary, ''); assert.equal(memory.summaryRevision, 2);
  memory = team.editMemory({ project: 'test', session: first.id, summary: 'Context notes', summaryRevision: 2 });
  assert.equal(memory.summaryRevision, 3);
  assert.equal(team.editMemory({ project: 'test', session: second.id, summary: 'Second notes', summaryRevision: 0 }).summaryRevision, 1);
  assert.equal(team.editMemory({ project: 'linked', session: linked.id, summary: 'Linked notes', summaryRevision: 0 }).summaryRevision, 1);
  assert.equal(team.memory('test', first.id).summary, 'Context notes');
  assert.equal(team.memory('test', second.id).summary, 'Second notes');
  assert.equal(team.memory('linked', linked.id).summary, 'Linked notes');

  const contextJob = { id: 'context', project: 'test', goal: 'Read context', sessionId: first.id, worktree: f.path };
  team.db.prepare('INSERT INTO jobs(id,body) VALUES(?,?)').run(contextJob.id, JSON.stringify(contextJob));
  const context = await team.memoryContext(contextJob, false, null, f.path);
  assert.equal(context.session, 'Context notes'); assert.equal(context.summaryRevision, 3);
  await f.restart(); await f.restart();
  assert.equal(f.team.memory('test', first.id).summaryRevision, 3);
  assert.equal(f.team.memory('linked', linked.id).summary, 'Linked notes');
});

test('final summary snapshots prevent stale overwrite while preserving facts, retractions and logs', async t => {
  const f = await fixture(t), team = f.team, session = team.createSession({ project: 'test', name: 'Race' });
  const base = (id, status = 'ready') => ({ id, project: 'test', sessionId: session.id, kind: 'code', status, goal: id,
    worktree: f.path, base: 'HEAD', revision: 'HEAD', tasks: [] });

  team.editMemory({ project: 'test', session: session.id, summary: 'Before final', summaryRevision: 0 });
  await team.remember(base('clear'), { session: '' }, { project: 'test', session: session.id, summaryRevision: 1 });
  assert.equal(team.memory('test', session.id).summary, ''); assert.equal(team.memory('test', session.id).summaryRevision, 2);
  await team.remember(base('fresh'), { session: 'Fresh final' }, { project: 'test', session: session.id, summaryRevision: 2 });
  assert.equal(team.memory('test', session.id).summary, 'Fresh final'); assert.equal(team.memory('test', session.id).summaryRevision, 3);

  const ownerFact = team.memoryStore.add({ project: 'test', text: 'Fact to retract' });
  team.editMemory({ project: 'test', session: session.id, summary: 'Owner edit', summaryRevision: 3 });
  const stale = base('stale');
  await team.remember(stale, { add: ['Stale final fact'], remove: [`M${ownerFact}`], session: 'Authorization: Bearer private-value' },
    { project: 'test', session: session.id, summaryRevision: 3 });
  let memory = team.memory('test', session.id, true);
  assert.equal(memory.summary, 'Owner edit'); assert.equal(memory.summaryRevision, 4);
  assert(memory.facts.some(row => row.text === 'Stale final fact' && row.status === 'active'));
  const retracted = memory.facts.find(row => row.id === ownerFact);
  assert(retracted && memory.facts.some(row => row.kind === 'retraction' && row.text === retracted.uid && row.status === 'active'));
  assert.equal(memory.log.filter(row => row.job === stale.id).length, 1);
  const staleEvent = team.events(stale.id).find(event => event.type === 'SESSION_SUMMARY_CONFLICT');
  assert.equal(staleEvent.details.source, `job:${stale.id}/final`);
  assert.equal(staleEvent.details.proposedSummary, 'Authorization: [REDACTED]');

  const legacy = base('legacy-final', 'done');
  await team.remember(legacy, { add: ['Legacy final fact'], session: 'Legacy proposal' });
  memory = team.memory('test', session.id);
  assert.equal(legacy.status, 'done');
  assert.equal(memory.summary, 'Owner edit'); assert.equal(memory.summaryRevision, 4);
  assert(memory.facts.some(row => row.text === 'Legacy final fact'));
  assert.equal(memory.log.filter(row => row.job === legacy.id).length, 1);
  const legacyEvent = team.events(legacy.id).find(event => event.type === 'SESSION_SUMMARY_CONFLICT');
  assert.equal(legacyEvent.details.source, `job:${legacy.id}/final`);
  assert.equal(legacyEvent.details.proposedSummary, 'Legacy proposal');

  const legacySnapshot = base('legacy-snapshot');
  legacySnapshot.reports = [{ stage: 'final' }];
  await team.remember(legacySnapshot, { session: 'Legacy snapshot proposal' }, { project: 'test', session: session.id, revision: 4 });
  assert.equal(team.memory('test', session.id).summary, 'Owner edit');
  assert.equal(team.memory('test', session.id).summaryRevision, 4);
  const legacySnapshotEvent = team.events(legacySnapshot.id).find(event => event.type === 'SESSION_SUMMARY_CONFLICT');
  assert.equal(legacySnapshotEvent.details.expectedRevision, null);
  assert.equal(legacySnapshotEvent.details.proposedSummary, 'Legacy snapshot proposal');
  assert.equal(legacySnapshot.reports[0].warnings[0].code, 'SESSION_SUMMARY_CONFLICT');
});
