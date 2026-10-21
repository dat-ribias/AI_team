import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { Team } from '../src/team.js';
import { run } from '../src/process.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-team-summary-api-'));
  const project = join(root, 'project'), linked = join(root, 'linked'), data = join(root, 'state');
  for (const path of [project, linked]) {
    mkdirSync(path); writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
    await run(['git'], ['init', '-b', 'main', path]);
    await run(['git'], ['-C', path, 'add', '.']);
    await run(['git'], ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial']);
  }
  const config = { demo: true, backup: false, ping: false, port: 3334,
    agents: [{ id: 'codex-1', provider: 'mock' }],
    pipeline: { manager: 'codex-1', builders: ['codex-1'], reviewer: 'codex-1', verifier: 'codex-1' },
    projects: [{ id: 'test', path: project, tests: [] }, { id: 'linked', path: linked, tests: [] }] };
  const team = new Team(config, data), token = 'summary-api-test-token';
  let handler;
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  runInNewContext(source, {
    URL, Buffer, console, join, resolve, extname, fileURLToPath, randomBytes, timingSafeEqual,
    msg: key => key, setLanguage() {}, getLanguage: () => 'en', languages: ['en'],
    process: { argv: [], env: { NODE_TEST_CONTEXT: '1' }, on() {} },
    existsSync: path => !String(path).endsWith('controller.lock'),
    readFileSync: path => String(path).endsWith('controller.token') ? token : JSON.stringify(config),
    mkdirSync() {}, openSync: () => 1, writeFileSync() {}, closeSync() {},
    setInterval: () => 1, setTimeout: () => 1,
    Team: class { constructor() { return team; } }, Accounts: class {},
    initializeUsage: () => ({ report() { return {}; } }),
    createServer: callback => { handler = callback; return { listen() {} }; },
  });
  t.after(async () => { await team.close(); rmSync(root, { recursive: true, force: true }); });

  async function request(path, { method = 'GET', body } = {}) {
    let status, result;
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = { method, url: path, headers: { host: '127.0.0.1:3334', authorization: `Bearer ${token}`, 'x-team-request': '1' },
      async *[Symbol.asyncIterator]() { yield* payload; } };
    const res = { setHeader() {}, writeHead(code) { status = code; }, end(value) { result = JSON.parse(value); } };
    await handler(req, res); return { status, result };
  }
  return { team, request };
}

test('memory API exposes summary revision and rejects the second owner write from one snapshot', async t => {
  const { team, request } = await fixture(t), session = team.createSession({ project: 'test', name: 'Owners' });
  let response = await request(`/api/memory?project=test&session=${session.id}`);
  assert.equal(response.status, 200); assert.equal(response.result.summary, ''); assert.equal(response.result.summaryRevision, 0);

  response = await request('/api/memory', { method: 'POST', body: { project: 'test', session: session.id, summary: 'First owner', revision: 0 } });
  assert.equal(response.status, 200); assert.equal(response.result.summary, 'First owner'); assert.equal(response.result.summaryRevision, 1);
  response = await request('/api/memory', { method: 'POST', body: { project: 'test', session: session.id, summary: 'Second owner', revision: 0 } });
  assert.equal(response.status, 409); assert.equal(response.result.details.code, 'SESSION_SUMMARY_CONFLICT');
  assert.equal(team.memory('test', session.id).summary, 'First owner');
});

test('memory API conflicts are atomic for missing revisions and project/session mismatches', async t => {
  const { team, request } = await fixture(t);
  const session = team.createSession({ project: 'test', name: 'Test' });
  const linked = team.createSession({ project: 'linked', name: 'Linked' });
  for (const body of [
    { project: 'test', session: session.id, summary: 'No revision', add: 'Missing-revision fact' },
    { project: 'test', session: linked.id, summary: 'Wrong project', revision: 0, add: 'Wrong-project fact' },
    { project: 'linked', session: session.id, summary: 'Wrong session', revision: 0, add: 'Wrong-session fact' },
  ]) {
    const response = await request('/api/memory', { method: 'POST', body });
    assert.equal(response.status, 409); assert.equal(response.result.details.code, 'SESSION_SUMMARY_CONFLICT');
  }
  assert.equal(team.memory('test', session.id).summary, '');
  assert.equal(team.memory('linked', linked.id).summary, '');
  assert.deepEqual(team.memory('test').facts, []); assert.deepEqual(team.memory('linked').facts, []);
});
