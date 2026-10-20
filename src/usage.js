import { randomUUID } from 'node:crypto';

export const DEFAULT_USAGE_TIMEZONE = 'Asia/Tokyo';
export const DEFAULT_USAGE_RETENTION_DAYS = 365;
const GROUPS = new Set(['day', 'project', 'session', 'job', 'agent', 'stage', 'model']);
const RESULTS = new Set(['ok', 'timeout', 'aborted', 'error', 'blocked']);
const WASTE = new Set(['timeout', 'aborted', 'error', 'blocked']);
const DAY = 86400000;
const nullableNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const firstNumber = (...values) => values.map(nullableNumber).find(v => v !== null) ?? null;
const sumKnown = values => values.some(v => v !== null) ? values.reduce((n, v) => n + (v ?? 0), 0) : null;
const json = body => { try { return JSON.parse(body); } catch { return null; } };
const text = value => value == null ? null : String(value);

function instant(value) {
  if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('Usage timestamp requires an ISO timezone');
  if (typeof value === 'string' && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error('Invalid usage timestamp date');
  const date = new Date(value);
  if (value == null || !Number.isFinite(date.getTime())) throw new Error('Invalid usage timestamp');
  return date.toISOString();
}

export function calendar(timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const parts = value => Object.fromEntries(formatter.formatToParts(new Date(value)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const day = value => { const p = parts(value); return `${p.year}-${p.month}-${p.day}`; };
  const midnight = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('Invalid usage date');
    const target = Date.parse(`${value}T00:00:00Z`);
    let result = target;
    for (let i = 0; i < 4; i++) {
      const p = parts(result), offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - result;
      const next = target - offset;
      if (next === result) return new Date(result).toISOString();
      result = next;
    }
    throw new Error('Usage date has no unambiguous midnight in this timezone');
  };
  return { day, midnight };
}

// Provider fields remain null when absent. Cached tokens are a subset of input
// for Codex/Gemini, but Claude reports cache reads/writes separately from input.
// Only the derived `tokens` count includes these Claude components; raw totals
// and input/output/cache columns are never fabricated.
export function normalizeUsage(usage, provider) {
  const list = Array.isArray(usage) ? usage : [usage];
  const rows = list.map(value => {
    const u = value && typeof value === 'object' ? value : {};
    const inputTokens = firstNumber(u.inputTokens, u.input_tokens, u.prompt_tokens, u.promptTokenCount);
    const outputTokens = firstNumber(u.outputTokens, u.output_tokens, u.completion_tokens, u.candidatesTokenCount);
    const cachedTokens = firstNumber(u.cachedTokens, u.cached_input_tokens, u.cache_read_input_tokens, u.cachedContentTokenCount, u.input_tokens_details?.cached_tokens, u.prompt_tokens_details?.cached_tokens);
    const cacheCreationTokens = firstNumber(u.cacheCreationTokens, u.cache_creation_input_tokens);
    const totalTokens = firstNumber(u.totalTokens, u.total_tokens, u.totalTokenCount);
    const separateCache = provider === 'claude' || u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null;
    const tokens = totalTokens ?? (inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens + (separateCache ? (cachedTokens ?? 0) + (cacheCreationTokens ?? 0) : 0) : null);
    return { inputTokens, outputTokens, cachedTokens, cacheCreationTokens, totalTokens, tokens };
  });
  return Object.fromEntries(['inputTokens', 'outputTokens', 'cachedTokens', 'cacheCreationTokens', 'totalTokens', 'tokens'].map(key => [key, sumKnown(rows.map(r => r[key]))]));
}

// Giá USD / 1 triệu token theo model (config.pricing): { input, output, cached?, cacheWrite? }.
// Khớp đúng tên model, rồi tiền tố dài nhất. Không có giá hoặc thiếu số token → null (không đoán).
export function callCost(row, pricing = {}) {
  const key = row.model && (pricing[row.model] ? row.model : Object.keys(pricing).filter(k => row.model.startsWith(k)).sort((a, b) => b.length - a.length)[0]);
  const p = key && pricing[key];
  if (!p || !Number.isFinite(p.input) || !Number.isFinite(p.output) || row.inputTokens == null || row.outputTokens == null) return null;
  const cached = row.cachedTokens ?? 0, write = row.cacheCreationTokens ?? 0;
  const input = row.provider === 'claude' ? row.inputTokens : Math.max(0, row.inputTokens - cached); // Codex/Gemini: cached nằm trong input
  return (input * p.input + row.outputTokens * p.output + cached * (p.cached ?? p.input) + write * (p.cacheWrite ?? p.input)) / 1e6;
}
function metrics() {
  return { cost: 0, unpricedCalls: 0, tokens: 0, calls: 0, durationMs: 0, tokensPerMinute: 0, wastedTokens: 0, wastedCalls: 0, wasteRatio: 0, unknownTokenCalls: 0, unknownDurationCalls: 0 };
}
function add(total, row, pricing, agentModels = {}) {
  total.calls++;
  // Dòng cũ (backfill) có thể thiếu model: ước tính theo model hiện tại của thành viên.
  const cost = callCost(row.model || !agentModels[row.agent] ? row : { ...row, model: agentModels[row.agent] }, pricing); if (cost === null) total.unpricedCalls++; else total.cost += cost;
  total.tokens += row.tokens ?? 0;
  total.durationMs += row.durationMs ?? 0;
  if (row.tokens === null) total.unknownTokenCalls++;
  if (row.durationMs === null) total.unknownDurationCalls++;
  if (WASTE.has(row.result) || row.reworked) { total.wastedCalls++; total.wastedTokens += row.tokens ?? 0; }
}
function finish(total) {
  total.tokensPerMinute = total.durationMs > 0 ? total.tokens * 60000 / total.durationMs : 0;
  total.wasteRatio = total.tokens > 0 ? total.wastedTokens / total.tokens : 0;
  return total;
}

/** Independent SQLite ledger. Call initializeUsage(db) at startup, then
 * recordCall once in the agent-call finalizer (including failures). The caller
 * owns the database; this module never closes it or touches event retention.
 * `at` is the completion time. `sourceKey` identifies the invocation and makes
 * retries idempotent. `redoOf` references a prior sourceKey proven to be redone.
 * Reports use [from, to); date-only filters mean midnight in the report zone.
 * wasteRatio is a fraction, based on known tokens; unknown counts are exposed.
 * Retention is separate from events: initialize/prune removes only usage rows
 * older than retentionDays (365 by default). The backfill marker survives it.
 */
export class UsageStore {
  constructor(db, { timezone = DEFAULT_USAGE_TIMEZONE, retentionDays = DEFAULT_USAGE_RETENTION_DAYS, now = () => new Date(), backfill = true, pricing = {}, agentModels = {} } = {}) {
    this.pricing = pricing || {}; this.agentModels = agentModels;
    calendar(timezone);
    if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new Error('Invalid usage retention days');
    this.db = db; this.timezone = timezone; this.retentionDays = retentionDays; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sourceKey TEXT NOT NULL UNIQUE,
      at TEXT NOT NULL, job TEXT, project TEXT, session TEXT, agent TEXT,
      provider TEXT, model TEXT, stage TEXT, taskIndex INTEGER,
      inputTokens INTEGER, outputTokens INTEGER, cachedTokens INTEGER, cacheCreationTokens INTEGER,
      totalTokens INTEGER, tokens INTEGER, durationMs REAL,
      result TEXT CHECK (result IS NULL OR result IN ('ok','timeout','aborted','error','blocked')),
      redoOf TEXT, reworked INTEGER NOT NULL DEFAULT 0,
      sourceSeq INTEGER, sourceEndSeq INTEGER
    );
    CREATE INDEX IF NOT EXISTS usage_log_at ON usage_log(at);
    CREATE INDEX IF NOT EXISTS usage_log_project_session_at ON usage_log(project, session, at);
    CREATE INDEX IF NOT EXISTS usage_log_job_at ON usage_log(job, at);
    CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.initialization = { backfilled: backfill ? this.backfill() : 0, pruned: this.prune() };
  }

  recordCall(call) {
    if (call.result != null && !RESULTS.has(call.result)) throw new Error('Invalid usage result');
    if (call.taskIndex != null && (!Number.isInteger(call.taskIndex) || call.taskIndex < 0)) throw new Error('Invalid usage task index');
    if (call.durationMs != null && nullableNumber(call.durationMs) === null) throw new Error('Invalid usage duration');
    const at = instant(call.at ?? this.now());
    const sourceKey = text(call.sourceKey ?? call.callId ?? `call:${randomUUID()}`);
    if (!sourceKey) throw new Error('Usage sourceKey must not be empty');
    const existing = this.db.prepare('SELECT * FROM usage_log WHERE sourceKey=?').get(sourceKey);
    if (existing) return existing;
    const redoOf = text(call.redoOf);
    const prior = redoOf ? this.db.prepare('SELECT * FROM usage_log WHERE sourceKey=?').get(redoOf) : null;
    if (redoOf && (!prior || prior.job !== text(call.job))) throw new Error('Usage redoOf must reference an existing call in the same job');
    const usage = normalizeUsage(call.usage ?? call, call.provider);
    const values = { sourceKey, at, job: text(call.job), project: text(call.project), session: text(call.session ?? call.sessionId), agent: text(call.agent), provider: text(call.provider), model: text(call.model), stage: text(call.stage), taskIndex: call.taskIndex ?? null, ...usage, durationMs: call.durationMs ?? null, result: call.result ?? null, redoOf, sourceSeq: call.sourceSeq ?? null, sourceEndSeq: call.sourceEndSeq ?? null };
    const keys = Object.keys(values);
    // A savepoint also works inside the startup backfill transaction.
    this.db.exec('SAVEPOINT usage_record');
    try {
      this.db.prepare(`INSERT INTO usage_log (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(values));
      if (redoOf) this.db.prepare('UPDATE usage_log SET reworked=1 WHERE sourceKey=?').run(redoOf);
      this.db.exec('RELEASE usage_record');
    } catch (error) { this.db.exec('ROLLBACK TO usage_record; RELEASE usage_record'); throw error; }
    return this.db.prepare('SELECT * FROM usage_log WHERE sourceKey=?').get(sourceKey);
  }

  markReworked(job) {
    return Number(this.db.prepare(`UPDATE usage_log SET reworked=1
      WHERE job=? AND result='ok' AND reworked=0 AND stage IN ('implement','research','fix')`).run(text(job)).changes);
  }

  backfill() {
    if (this.db.prepare("SELECT value FROM usage_meta WHERE key='events-backfill-v1'").get()) return 0;
    const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (!tables.has('events')) return 0;
    const jobs = new Map(tables.has('jobs') ? this.db.prepare('SELECT id, body FROM jobs').all().map(r => [r.id, json(r.body) || {}]) : []);
    const pending = new Map();
    let count = 0;
    const save = (call, end = null) => {
      const event = end?.event, details = event?.details || {}, job = jobs.get(call.job) || {};
      const outcome = RESULTS.has(details.result) ? details.result : RESULTS.has(details.status) ? details.status : null;
      const result = outcome ?? (event?.type === 'BLOCKER' ? 'blocked' : event ? 'ok' : null);
      // Never use the job's current task/model/agent as historical metadata.
      const metadata = { ...call.details, ...details };
      const at = event?.timestamp ?? call.lastAt;
      if (!at) return;
      try { instant(at); } catch { return; }
      let durationMs = nullableNumber(metadata.durationMs);
      if (durationMs === null && call.startedAt && event?.timestamp) {
        const elapsed = Date.parse(event.timestamp) - Date.parse(call.startedAt);
        durationMs = nullableNumber(elapsed);
      }
      const sourceKey = `event:${call.seq}`;
      if (this.db.prepare('SELECT id FROM usage_log WHERE sourceKey=? OR sourceSeq=? OR sourceEndSeq=?').get(sourceKey, call.seq, end?.seq ?? call.seq)) return;
      const taskIndex = metadata.taskIndex ?? metadata.task;
      this.recordCall({ sourceKey, sourceSeq: call.seq, sourceEndSeq: end?.seq, at, job: call.job, project: job.project, session: job.sessionId,
        agent: call.agent, provider: metadata.provider, model: metadata.model, stage: metadata.stage ?? (event?.type === 'REVIEW_RESULT' ? 'review' : null),
        taskIndex: Number.isInteger(taskIndex) && taskIndex >= 0 ? taskIndex : null, usage: call.usage, result, durationMs });
      count++;
    };
    this.db.exec('SAVEPOINT usage_backfill');
    try {
      for (const row of this.db.prepare('SELECT seq, job, body FROM events ORDER BY seq').iterate()) {
        const event = json(row.body);
        if (!event || !['TASK_ASSIGNMENT', 'REVIEW_REQUEST', 'USAGE', 'RESULT', 'REVIEW_RESULT', 'BLOCKER'].includes(event.type)) continue;
        const request = ['TASK_ASSIGNMENT', 'REVIEW_REQUEST'].includes(event.type);
        const agent = request ? event.to : event.from;
        if (!agent || agent === 'controller' || agent === 'user') continue;
        const key = JSON.stringify([row.job, agent]);
        if (request) {
          // Legacy events have no invocation id. Overlapping calls to the same
          // member cannot be safely attributed: discard the request boundary
          // and preserve only subsequent observations with unknown timing.
          const previous = pending.get(key);
          if (previous) {
            if (previous.usage.length) save(previous);
            pending.set(key, { job: row.job, agent, seq: row.seq, details: {}, usage: [], lastAt: null });
          } else pending.set(key, { job: row.job, agent, seq: row.seq, details: event.details || {}, usage: [], startedAt: event.timestamp, lastAt: null });
        } else if (event.type === 'USAGE') {
          let call = pending.get(key);
          if (!call) { call = { job: row.job, agent, seq: row.seq, details: {}, usage: [] }; pending.set(key, call); }
          call.usage.push(event.details); call.lastAt = event.timestamp;
        } else {
          const call = pending.get(key) || { job: row.job, agent, seq: row.seq, details: {}, usage: [] };
          save(call, { seq: row.seq, event }); pending.delete(key);
          if (event.type === 'REVIEW_RESULT' && event.details?.verdict === 'changes_requested') this.markReworked(row.job);
        }
      }
      for (const call of pending.values()) if (call.usage.length) save(call);
      this.db.prepare("INSERT INTO usage_meta (key,value) VALUES ('events-backfill-v1',?)").run(instant(this.now()));
      this.db.exec('RELEASE usage_backfill');
    } catch (error) { this.db.exec('ROLLBACK TO usage_backfill; RELEASE usage_backfill'); throw error; }
    return count;
  }

  prune(at = this.now()) {
    const cutoff = new Date(Date.parse(instant(at)) - this.retentionDays * DAY).toISOString();
    return Number(this.db.prepare('DELETE FROM usage_log WHERE at < ?').run(cutoff).changes);
  }

  report(options = {}) {
    const { groupBy = 'day', timezone = this.timezone, period = 'today' } = options;
    if (!GROUPS.has(groupBy)) throw new Error('Invalid usage groupBy');
    if (!['today', 'week', 'month'].includes(period)) throw new Error('Invalid usage period');
    const zone = calendar(timezone), today = zone.day(instant(this.now()));
    const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
    let start = today, end = shift(today, 1), previousStart = shift(today, -1);
    if (period === 'week') {
      start = shift(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
      end = shift(start, 7); previousStart = shift(start, -7);
    } else if (period === 'month') {
      start = `${today.slice(0, 7)}-01`;
      const date = new Date(`${start}T00:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() + 1); end = date.toISOString().slice(0, 10);
      date.setUTCMonth(date.getUTCMonth() - 2); previousStart = date.toISOString().slice(0, 10);
    }
    const boundary = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? zone.midnight(value) : instant(value);
    const from = options.from != null ? boundary(options.from) : zone.midnight(start);
    const to = options.to != null ? boundary(options.to) : zone.midnight(end);
    if (from >= to) throw new Error('Usage from must precede to');
    const custom = options.from != null || options.to != null;
    const previousFrom = custom ? new Date(Date.parse(from) - (Date.parse(to) - Date.parse(from))).toISOString() : zone.midnight(previousStart);
    const filters = ['at >= ?', 'at < ?'], values = [];
    for (const key of ['project', 'session', 'job']) if (options[key] != null && options[key] !== '') { filters.push(`${key}=?`); values.push(text(options[key])); }
    const query = this.db.prepare(`SELECT * FROM usage_log WHERE ${filters.join(' AND ')} ORDER BY at, id`);
    const totals = metrics(), groups = new Map(), previousTotals = metrics();
    for (const row of query.iterate(from, to, ...values)) {
      add(totals, row, this.pricing, this.agentModels);
      const key = groupBy === 'day' ? zone.day(row.at) : row[groupBy];
      if (!groups.has(key)) groups.set(key, { key, ...metrics() });
      add(groups.get(key), row, this.pricing, this.agentModels);
    }
    for (const row of query.iterate(previousFrom, from, ...values)) add(previousTotals, row, this.pricing, this.agentModels);
    finish(totals); finish(previousTotals);
    const percent = key => previousTotals[key] ? (totals[key] - previousTotals[key]) / previousTotals[key] * 100 : totals[key] ? null : 0;
    return { from, to, timezone, groupBy, totals, groups: [...groups.values()].map(finish),
      previous: { from: previousFrom, to: from, totals: previousTotals },
      change: { costPercent: percent('cost'), tokensPercent: percent('tokens'), callsPercent: percent('calls'), durationPercent: percent('durationMs'), wasteRatioPoints: (totals.wasteRatio - previousTotals.wasteRatio) * 100 } };
  }
}

export const initializeUsage = (db, options) => new UsageStore(db, options);
