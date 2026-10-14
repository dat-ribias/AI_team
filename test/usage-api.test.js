import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { initializeUsage } from '../src/usage.js';

const now = () => new Date('2026-10-14T03:00:00Z');
function fixture(t, timezone = 'Asia/Tokyo') {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, body TEXT); CREATE TABLE events (seq INTEGER PRIMARY KEY, job TEXT, body TEXT)');
  db.prepare('INSERT INTO jobs VALUES (?, ?)').run('j1', JSON.stringify({ goal: 'Sample job', project: 'p1', sessionId: 's1', round: 2 }));
  db.prepare('INSERT INTO events VALUES (1, ?, ?)').run('j1', JSON.stringify({ type: 'USAGE', from: 'a1', timestamp: '2026-10-13T14:59:00Z', details: { total_tokens: 50 } }));
  const config = { port: 3334, timezone }, token = 'test-only-token';
  let handler, store;
  const team = { db, memoryReaders: new Map(), on() {} };
  // Execute the actual startup and router with inert dependencies: no sockets,
  // account refreshes, real config/token reads or background timers.
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  runInNewContext(source, {
    URL, Buffer, console, join, resolve, extname, fileURLToPath, randomBytes, timingSafeEqual,
    msg: key => key, setLanguage() {}, getLanguage: () => 'en', languages: ['en'],
    process: { argv: [], on() {} }, existsSync: path => !path.endsWith('controller.lock'),
    readFileSync: path => path.endsWith('controller.token') ? token : JSON.stringify(config),
    mkdirSync() {}, openSync: () => 1, writeFileSync() {}, closeSync() {},
    setInterval: () => 1, setTimeout: () => 1,
    Team: class { constructor() { return team; } }, Accounts: class {},
    initializeUsage: (database, options) => (store = initializeUsage(database, { ...options, now })),
    createServer: callback => { handler = callback; return { listen() {} }; },
  });
  async function request(query = '', { method = 'GET', authenticated = true } = {}) {
    let status, result;
    const res = { setHeader() {}, writeHead(code) { status = code; }, end(body) { result = JSON.parse(body); } };
    await handler({ method, url: `/api/usage${query}`, headers: { host: '127.0.0.1:3334', ...(authenticated ? { authorization: `Bearer ${token}` } : {}), 'x-team-request': '1' } }, res);
    return { status, result };
  }
  return { db, store, request };
}

test('server startup initializes and backfills usage without changing Team lifecycle', async t => {
  const { store, db, request } = fixture(t);
  assert.equal(store.initialization.backfilled, 1);
  assert.equal(initializeUsage(db, { now }).initialization.backfilled, 0);
  const { status, result } = await request('?from=2026-10-13&to=2026-10-14');
  assert.equal(status, 200); assert.equal(result.totals.tokens, 50);
  assert.equal(result.records[0].sourceKey, 'event:1');
});

test('GET forwards all filters, exposes previous period, rankings and CSV records', async t => {
  const { store, request } = fixture(t);
  const call = { at: '2026-10-13T15:01:00Z', job: 'j1', project: 'p1', session: 's1', agent: 'a1', stage: 'implement', model: 'test-model', durationMs: 60000, usage: { total_tokens: 100 }, result: 'ok' };
  store.recordCall({ ...call, sourceKey: 'ok' });
  store.recordCall({ ...call, sourceKey: 'error', usage: { total_tokens: 20 }, result: 'error' });
  store.recordCall({ ...call, sourceKey: 'other-session', session: 's2', usage: { total_tokens: 999 } });
  store.recordCall({ ...call, sourceKey: 'other-project', project: 'p2', usage: { total_tokens: 999 } });
  store.recordCall({ ...call, sourceKey: 'other-job', job: 'j2', usage: { total_tokens: 999 } });
  const { status, result } = await request('?from=2026-10-14&to=2026-10-15&groupBy=stage&project=p1&session=s1&job=j1');
  assert.equal(status, 200); assert.equal(result.groupBy, 'stage');
  assert.equal(result.from, '2026-10-13T15:00:00.000Z');
  assert.equal(result.totals.tokens, 120); assert.equal(result.totals.calls, 2);
  assert.equal(result.totals.durationMs, 120000); assert.equal(result.totals.wasteRatio, 20 / 120);
  assert.equal(result.previous.totals.tokens, 50); assert.equal(result.change.tokensPercent, 140);
  assert.equal(result.groups[0].key, 'implement'); assert.equal(result.breakdown.day[0].key, '2026-10-14');
  assert.equal(result.rankings.job[0].title, 'Sample job'); assert.equal(result.rankings.job[0].fixRounds, 2);
  assert.equal(result.rankings.agent[0].key, 'a1'); assert.equal(result.rankings.model[0].tokens, 120);
  assert.equal(result.records.length, 2); assert.equal(result.records[0].inputTokens, null);
  for (const groupBy of ['day', 'project', 'session', 'job', 'agent', 'stage', 'model']) {
    const response = await request(`?from=2026-10-14&to=2026-10-15&groupBy=${groupBy}&project=p1&session=s1&job=j1`);
    assert.equal(response.status, 200); assert.equal(response.result.totals.tokens, 120);
  }
});

test('usage route rejects invalid groups/dates/ranges and non-GET, and preserves authentication', async t => {
  const { request } = fixture(t);
  for (const query of ['?groupBy=provider', '?groupBy=', '?from=bad', '?from=', '?from=2026-02-30', '?from=2026-10-15&to=2026-10-14', '?from=2026-10-14&to=2026-10-14', '?from=2026-10-14T00:00:00']) {
    const response = await request(query);
    assert.equal(response.status, 400, query); assert.ok(response.result.error);
  }
  assert.equal((await request('', { method: 'POST' })).status, 404);
  assert.equal((await request('', { authenticated: false })).status, 401);
});

test('usage route honors configured timezone and safely filters encoded values', async t => {
  const { store, request } = fixture(t, 'UTC');
  store.recordCall({ sourceKey: 'encoded', at: '2026-10-14T01:00:00Z', project: 'p & 日本', session: "s' OR 1=1", usage: { total_tokens: 12 } });
  const query = new URLSearchParams({ from: '2026-10-14', to: '2026-10-15', project: 'p & 日本', session: "s' OR 1=1" });
  const { status, result } = await request(`?${query}`);
  assert.equal(status, 200); assert.equal(result.timezone, 'UTC');
  assert.equal(result.from, '2026-10-14T00:00:00.000Z'); assert.equal(result.totals.tokens, 12);
});
