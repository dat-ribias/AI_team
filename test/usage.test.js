import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { UsageStore, initializeUsage, normalizeUsage } from '../src/usage.js';

const now = () => new Date('2026-10-14T03:00:00Z');
test('Vietnamese and Japanese usage labels preserve Unicode', () => {
  for (const language of ['vi', 'ja']) {
    const locale = JSON.parse(readFileSync(new URL(`../locales/${language}.json`, import.meta.url), 'utf8'));
    for (const [key, value] of Object.entries(locale)) {
      if (/^ui\.(token|usage)\./.test(key)) assert.doesNotMatch(value, /Ã|á»|Ä|�|\?/, `${language}: ${key}`);
    }
  }
});
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new UsageStore(db, { now, ...options });
  return { db, store };
}
function legacy(db) {
  db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT, body TEXT NOT NULL)');
  db.prepare('INSERT INTO jobs VALUES (?,?)').run('j1', JSON.stringify({ project: 'p1', sessionId: 's1', taskIndex: 99, stage: 'final' }));
  return (type, details = null, timestamp = '2026-10-14T01:00:00Z', from = 'a1', to = 'controller') => Number(db.prepare('INSERT INTO events (job,body) VALUES (?,?)').run('j1', JSON.stringify({ type, from, to, details, timestamp })).lastInsertRowid);
}
const call = (sourceKey, overrides = {}) => ({ sourceKey, at: '2026-10-14T01:00:00Z', job: 'j1', project: 'p1', session: 's1', agent: 'a1', provider: 'codex', stage: 'implement', durationMs: 60000, result: 'ok', usage: { input_tokens: 80, cached_input_tokens: 30, output_tokens: 20 }, ...overrides });

test('record successful and failed calls, preserve nullable breakdown and idempotency', t => {
  const { db, store } = fixture(t);
  const ok = store.recordCall(call('ok', { taskIndex: 0 }));
  assert.equal(ok.inputTokens, 80); assert.equal(ok.outputTokens, 20);
  assert.equal(ok.cachedTokens, 30); assert.equal(ok.totalTokens, null);
  assert.equal(ok.tokens, 100); assert.equal(ok.taskIndex, 0);
  assert.equal(store.recordCall(call('ok', { usage: { total_tokens: 999 } })).id, ok.id);
  const failed = store.recordCall(call('failed', { result: 'error', usage: undefined, durationMs: null }));
  for (const field of ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens', 'tokens', 'durationMs']) assert.equal(failed[field], null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage_log').get().n, 2);
  const report = store.report();
  assert.equal(report.totals.calls, 2); assert.equal(report.totals.wastedCalls, 1);
  assert.equal(report.totals.unknownTokenCalls, 1); assert.equal(report.totals.unknownDurationCalls, 1);
});

test('provider normalization uses observed totals, preserves missing fields, and counts caches correctly', () => {
  const totalOnly = normalizeUsage({ total_tokens: 0 });
  assert.equal(totalOnly.totalTokens, 0); assert.equal(totalOnly.tokens, 0); assert.equal(totalOnly.inputTokens, null);
  assert.equal(normalizeUsage({ input_tokens: 10 }).tokens, null);
  assert.equal(normalizeUsage({ input_tokens: '100', output_tokens: -1 }).inputTokens, null);
  assert.equal(normalizeUsage({ input_tokens: 10, output_tokens: 5, cached_input_tokens: 8 }, 'codex').tokens, 15);
  const claude = normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 }, 'claude');
  assert.equal(claude.tokens, 65); assert.equal(claude.cacheCreationTokens, 30); assert.equal(claude.totalTokens, null);
  assert.equal(normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 }).tokens, 35);
  assert.equal(normalizeUsage({ promptTokenCount: 10, candidatesTokenCount: 5, cachedContentTokenCount: 8, totalTokenCount: 19 }).tokens, 19);
  assert.equal(normalizeUsage([{ total_tokens: 20 }, { total_tokens: 30 }]).tokens, 50);
});

test('backfill combines multiple usage events into one call and runs once across reopen', t => {
  const { db } = fixture(t, { backfill: false });
  const event = legacy(db);
  const seq = event('TASK_ASSIGNMENT', { stage: 'implement', taskIndex: 0, provider: 'codex', model: 'test-model' }, '2026-10-14T00:59:00Z', 'manager', 'a1');
  event('USAGE', { input_tokens: 20, output_tokens: 10 });
  event('USAGE', { input_tokens: 30, output_tokens: 10 });
  const end = event('RESULT', { status: 'completed' });
  const store = initializeUsage(db, { now });
  assert.equal(store.initialization.backfilled, 1);
  const row = db.prepare('SELECT * FROM usage_log').get();
  assert.equal(row.sourceKey, `event:${seq}`); assert.equal(row.sourceEndSeq, end);
  assert.equal(row.tokens, 70); assert.equal(row.totalTokens, null); assert.equal(row.cachedTokens, null);
  assert.equal(row.project, 'p1'); assert.equal(row.session, 's1'); assert.equal(row.stage, 'implement');
  assert.equal(row.taskIndex, 0); assert.equal(row.model, 'test-model'); assert.equal(row.durationMs, 60000); assert.equal(row.result, 'ok');
  assert.equal(new UsageStore(db, { now }).initialization.backfilled, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage_log').get().n, 1);
  event('USAGE', { total_tokens: 999 });
  assert.equal(store.backfill(), 0);
});

test('backfill records review results, blockers, errors without tokens and incomplete observations truthfully', t => {
  const { db, store } = fixture(t, { backfill: false });
  const event = legacy(db);
  event('REVIEW_REQUEST', { stage: 'review' }, '2026-10-14T00:59:00Z', 'controller', 'a1');
  event('USAGE', { total_tokens: 20 }); event('REVIEW_RESULT', { status: 'completed', verdict: 'changes_requested' });
  event('TASK_ASSIGNMENT', { stage: 'verify' }, '2026-10-14T01:00:00Z', 'controller', 'a1');
  event('BLOCKER', { status: 'blocked' }, '2026-10-14T01:01:00Z');
  event('BLOCKER', { result: 'timeout' }, '2026-10-14T01:02:00Z');
  event('USAGE', { total_tokens: 7 }, '2026-10-14T01:03:00Z');
  event('BLOCKER', {}, '2026-10-14T01:04:00Z', 'controller', 'user');
  assert.equal(store.backfill(), 4);
  const rows = db.prepare('SELECT * FROM usage_log ORDER BY id').all();
  assert.deepEqual(rows.map(r => r.result), ['ok', 'blocked', 'timeout', null]);
  assert.equal(rows[1].tokens, null); assert.equal(rows[1].durationMs, 60000);
  assert.equal(rows[2].stage, null); assert.equal(rows[2].durationMs, null);
  assert.equal(rows[3].stage, null); assert.equal(rows[3].model, null); assert.equal(rows[3].taskIndex, null);
  assert.equal(rows[3].durationMs, null);
});

test('backfill ignores malformed JSON, uses all events beyond the public 2000 row limit', t => {
  const { db, store } = fixture(t, { backfill: false });
  const event = legacy(db);
  db.prepare('INSERT INTO events (job,body) VALUES (?,?)').run('j1', 'invalid json');
  for (let i = 0; i < 2001; i++) event('ACTIVITY');
  event('USAGE', { total_tokens: 3 }); event('RESULT', { status: 'completed' });
  assert.equal(store.backfill(), 1); assert.equal(store.report().totals.tokens, 3);
});

test('backfill separates interleaved members and deduplicates already recorded source calls', t => {
  const { db, store } = fixture(t, { backfill: false });
  const event = legacy(db);
  const first = event('TASK_ASSIGNMENT', { stage: 'implement', taskIndex: 0 }, '2026-10-14T00:59:00Z', 'manager', 'a1');
  event('REVIEW_REQUEST', { stage: 'review', taskIndex: 1 }, '2026-10-14T00:59:00Z', 'manager', 'a2');
  event('USAGE', { total_tokens: 10 });
  event('USAGE', { total_tokens: 20 }, '2026-10-14T01:00:00Z', 'a2');
  event('REVIEW_RESULT', { status: 'error' }, '2026-10-14T01:00:00Z', 'a2');
  const end = event('RESULT', { status: 'completed' });
  store.recordCall(call(`event:${first}`, { sourceSeq: first, sourceEndSeq: end, usage: { total_tokens: 10 } }));
  assert.equal(store.backfill(), 1);
  const report = store.report({ groupBy: 'agent' });
  assert.equal(report.totals.calls, 2); assert.equal(report.totals.tokens, 30); assert.equal(report.totals.wasteRatio, 20 / 30);
  assert.equal(report.groups.find(g => g.key === 'a2').tokens, 20);
});

test('backfill transaction rolls back records and marker when interrupted', t => {
  const { db, store } = fixture(t, { backfill: false });
  const event = legacy(db);
  event('USAGE', { total_tokens: 3 }); event('RESULT', { status: 'completed' });
  const record = store.recordCall.bind(store);
  store.recordCall = data => { record(data); throw new Error('mock interrupted startup'); };
  assert.throws(() => store.backfill(), /interrupted/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage_log').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage_meta').get().n, 0);
  store.recordCall = record;
  assert.equal(store.backfill(), 1);
});

test('Tokyo grouping and date-only filters cross UTC midnight with exclusive end', t => {
  const { store } = fixture(t);
  store.recordCall(call('before', { at: '2026-10-13T14:59:59Z' }));
  store.recordCall(call('midnight', { at: '2026-10-14T00:00:00+09:00' }));
  store.recordCall(call('after-utc', { at: '2026-10-14T00:00:00Z' }));
  store.recordCall(call('next', { at: '2026-10-14T15:00:00Z' }));
  const report = store.report({ from: '2026-10-14', to: '2026-10-15' });
  assert.equal(report.from, '2026-10-13T15:00:00.000Z'); assert.equal(report.to, '2026-10-14T15:00:00.000Z');
  assert.equal(report.totals.calls, 2); assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].key, '2026-10-14'); assert.equal(report.groups[0].tokens, 200);
  const days = store.report({ from: '2026-10-13', to: '2026-10-16' }).groups;
  assert.deepEqual(days.map(g => [g.key, g.calls]), [['2026-10-13', 1], ['2026-10-14', 2], ['2026-10-15', 1]]);
});

test('filters combine project, session and job with parameters, preserving previous-period filters', t => {
  const { store } = fixture(t);
  store.recordCall(call('wanted'));
  store.recordCall(call('other-session', { session: 's2' }));
  store.recordCall(call('other-project', { project: 'p2' }));
  store.recordCall(call('other-job', { job: 'j2' }));
  store.recordCall(call('previous', { at: '2026-10-13T01:00:00Z', usage: { total_tokens: 50 } }));
  const report = store.report({ project: 'p1', session: 's1', job: 'j1' });
  assert.equal(report.totals.calls, 1); assert.equal(report.totals.tokens, 100);
  assert.equal(report.previous.totals.tokens, 50); assert.equal(report.change.tokensPercent, 100);
  assert.equal(store.report({ project: "p1' OR 1=1 --" }).totals.calls, 0);
});

test('token-weighted waste covers all failed outcomes plus explicitly redone calls once', t => {
  const { store, db } = fixture(t);
  for (const result of ['ok', 'timeout', 'aborted', 'error', 'blocked']) store.recordCall(call(result, { result }));
  const replacement = call('replacement', { redoOf: 'ok' });
  store.recordCall(replacement); store.recordCall(replacement);
  store.recordCall(call('small', { usage: { total_tokens: 10 } }));
  const report = store.report();
  assert.equal(report.totals.calls, 7); assert.equal(report.totals.tokens, 610);
  assert.equal(report.totals.wastedTokens, 500); assert.equal(report.totals.wastedCalls, 5);
  assert.equal(report.totals.wasteRatio, 500 / 610); assert.equal(report.totals.tokensPerMinute, 610 / 7);
  assert.throws(() => store.recordCall(call('invalid-redo', { redoOf: 'missing' })), /existing call/);
  assert.throws(() => store.recordCall(call('other-job-redo', { job: 'j2', redoOf: 'ok' })), /same job/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage_log').get().n, 7);
});

test('every grouping is supported and empty reports have finite metrics', t => {
  const { store } = fixture(t);
  assert.equal(store.report().totals.tokensPerMinute, 0); assert.equal(store.report().totals.wasteRatio, 0);
  store.recordCall(call('one', { model: 'm1' }));
  for (const [groupBy, key] of Object.entries({ day: '2026-10-14', project: 'p1', session: 's1', job: 'j1', agent: 'a1', stage: 'implement', model: 'm1' })) {
    const report = store.report({ groupBy });
    assert.equal(report.groups[0].key, key); assert.equal(report.groups[0].calls, 1);
    assert.equal(report.change.tokensPercent, null);
  }
  assert.throws(() => store.report({ groupBy: 'at); DROP TABLE usage_log; --' }), /groupBy/);
});

test('today, Monday-based week and month use Tokyo calendar periods including previous month', t => {
  const { store } = fixture(t, { now: () => new Date('2026-03-31T16:00:00Z') });
  const today = store.report();
  assert.equal(today.from, '2026-03-31T15:00:00.000Z');
  const week = store.report({ period: 'week' });
  assert.equal(week.from, '2026-03-29T15:00:00.000Z'); assert.equal(week.to, '2026-04-05T15:00:00.000Z');
  const month = store.report({ period: 'month' });
  assert.equal(month.from, '2026-03-31T15:00:00.000Z'); assert.equal(month.to, '2026-04-30T15:00:00.000Z');
  assert.equal(month.previous.from, '2026-02-28T15:00:00.000Z');
});

test('configured timezone supports daylight saving boundaries', t => {
  const { store } = fixture(t, { timezone: 'America/New_York', now: () => new Date('2026-03-08T12:00:00Z') });
  const report = store.report();
  assert.equal(report.from, '2026-03-08T05:00:00.000Z'); assert.equal(report.to, '2026-03-09T04:00:00.000Z');
});

test('365-day usage retention is independent of event deletion and does not resurrect backfill', t => {
  const { db, store } = fixture(t, { backfill: false });
  const event = legacy(db);
  event('USAGE', { total_tokens: 10 }); event('RESULT', { status: 'completed' });
  assert.equal(store.backfill(), 1);
  db.exec('DELETE FROM events');
  assert.equal(store.report().totals.tokens, 10);
  store.recordCall(call('expired', { at: '2025-10-14T02:59:59Z' }));
  store.recordCall(call('boundary', { at: '2025-10-14T03:00:00Z' }));
  assert.equal(store.prune(), 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM usage_log WHERE sourceKey='boundary'").get().n, 1);
  event('USAGE', { total_tokens: 999 }); event('RESULT');
  assert.equal(store.backfill(), 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 2);
  assert.equal(store.prune('2027-10-15T03:00:00Z'), 2);
  assert.equal(store.backfill(), 0);
});

test('initialization prunes old backfilled calls using configurable independent retention', t => {
  const { db } = fixture(t, { backfill: false });
  const event = legacy(db);
  event('USAGE', { total_tokens: 10 }, '2026-10-01T01:00:00Z');
  event('RESULT', { status: 'completed' }, '2026-10-01T01:00:01Z');
  const store = new UsageStore(db, { now, retentionDays: 7 });
  assert.deepEqual(store.initialization, { backfilled: 1, pruned: 1 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 2);
});

test('validates timestamps, results, task indexes, retention and report ranges', t => {
  const { store, db } = fixture(t);
  assert.throws(() => store.recordCall(call('bad', { at: '2026-10-14T10:00:00' })), /timezone/);
  assert.throws(() => store.recordCall(call('bad', { at: '2026-02-30T10:00:00Z' })), /date/);
  assert.throws(() => store.recordCall(call('bad', { result: 'failed' })), /result/);
  assert.throws(() => store.recordCall(call('bad', { taskIndex: -1 })), /task index/);
  assert.throws(() => store.recordCall(call('bad', { durationMs: NaN })), /duration/);
  assert.throws(() => store.report({ from: '2026-10-15', to: '2026-10-14' }), /precede/);
  assert.throws(() => store.report({ from: '2026-02-30' }), /date/);
  assert.throws(() => store.report({ timezone: 'invalid' }), RangeError);
  assert.throws(() => new UsageStore(db, { retentionDays: -1 }), /retention/);
});
