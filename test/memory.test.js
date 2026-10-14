import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Team, redact } from '../src/team.js';
import { fileHash, hash } from '../src/memory.js';
import { run } from '../src/process.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-team-memory-')), path = join(root, 'project'), data = join(root, 'state');
  mkdirSync(path); writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  await run(['git'], ['init', '-b', 'main', path]);
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  const config = { demo: true, backup: false, agents: [{ id: 'codex-1', provider: 'mock' }],
    pipeline: { manager: 'codex-1', builders: ['codex-1'], reviewer: 'codex-1', verifier: 'codex-1' },
    projects: [{ id: 'test', path, tests: [] }, { id: 'linked', path: join(root, 'linked'), tests: [] }] };
  let team = new Team(config, data, { runAgent: async () => { throw new Error('Unexpected agent call'); } });
  t.after(async () => { await team.close(); rmSync(root, { recursive: true, force: true }); });
  return { path, data, config, get team() { return team; }, async restart() { await team.close(); team = new Team(config, data); return team; } };
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
