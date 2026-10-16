import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { Team, jobTitle } from '../src/team.js';

// Match the isolated MCP harness in usage-mcp.test.js, including numeric bounds.
function schema(parse) {
  const checks = [];
  return {
    parse(value) { const result = parse(value); for (const check of checks) if (!check(result)) throw new TypeError('Invalid value'); return result; },
    optional() { return schema(value => value === undefined ? undefined : this.parse(value)); },
    default(fallback) { return schema(value => this.parse(value === undefined ? fallback : value)); },
    describe() { return this; },
    min(minimum) { checks.push(value => (typeof value === 'number' ? value : value.length) >= minimum); return this; },
    max(maximum) { checks.push(value => (typeof value === 'number' ? value : value.length) <= maximum); return this; },
    int() { checks.push(Number.isInteger); return this; },
  };
}
const typedSchema = type => schema(value => {
  if (typeof value !== type) throw new TypeError(`Expected ${type}`);
  return value;
});
const z = {
  string: () => typedSchema('string'), number: () => typedSchema('number'), boolean: () => typedSchema('boolean'),
  enum: values => schema(value => { if (!values.includes(value)) throw new TypeError('Invalid enum'); return value; }),
  array: item => schema(value => { if (!Array.isArray(value)) throw new TypeError('Expected array'); return value.map(entry => item.parse(entry)); }),
  object: shape => schema(value => Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, field.parse(value[key])]).filter(([, field]) => field !== undefined))),
};

function fixture(t, jobs = []) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, body TEXT)');
  for (const job of jobs) db.prepare('INSERT INTO jobs VALUES (?, ?)').run(job.id, JSON.stringify(job));
  // Skip controller startup, quota polling and disk access; exercise real job reads.
  const team = Object.assign(Object.create(Team.prototype), {
    db, config: { agents: [{ id: 'a1' }, { id: 'a2' }], resources: { maxAgents: 4 }, maxConcurrentTests: 2 },
    busyAgents: () => new Set(['a1']), remaining: id => id === 'a1' ? 75 : 40,
    runningSlots: () => 1, waitingReason: 'resource queue',
  });
  return team;
}

const sample = (id, extra = {}) => ({ id, project: 'p1', goal: 'Sample job', status: 'queued', ...extra });
const summaryKeys = ['id', 'project', 'sessionId', 'kind', 'title', 'status', 'stage', 'round', 'reason', 'lastProgressAt', 'revision', 'base', 'baseBranch', 'branch', 'next'];

test('statusSummary keeps one compact row per job despite large reports and tasks', t => {
  const job = sample('j1', {
    sessionId: 's1', kind: 'code', title: 'Owner title', stage: 'review', round: 2,
    updatedAt: '2026-10-16T03:00:00Z', revision: 'rev', base: 'base', baseBranch: 'dev', branch: 'ai-team/j1',
    reports: [{ summary: 'x'.repeat(150000), findings: [{ claim: 'y'.repeat(100000) }] }],
    tasks: [{ instruction: 'z'.repeat(100000) }], error: 'e'.repeat(1000),
  });
  const team = fixture(t, [job, sample('legacy')]), result = team.statusSummary();
  assert.equal(result.total, 2); assert.equal(result.cursor, 0); assert.equal(result.nextCursor, null);
  for (const row of result.jobs) {
    assert.deepEqual(Object.keys(row), summaryKeys);
    assert.ok(Buffer.byteLength(JSON.stringify(row), 'utf8') < 2048);
  }
  assert.deepEqual(result.jobs[1], {
    id: 'j1', project: 'p1', sessionId: 's1', kind: 'code', title: jobTitle(job), status: 'queued', stage: 'review', round: 2,
    reason: 'e'.repeat(200), lastProgressAt: job.updatedAt, revision: 'rev', base: 'base', baseBranch: 'dev', branch: 'ai-team/j1', next: 'none',
  });
  assert.equal(result.jobs[0].lastProgressAt, null); assert.equal(result.jobs[0].reason, null);
  assert.equal(result.jobs[0].title, 'Sample job');
  assert.deepEqual(result.agents, [{ id: 'a1', state: 'working', quotaPct: 75 }, { id: 'a2', state: 'idle', quotaPct: 40 }]);
  assert.deepEqual(result.resources, { active: 1, maxAgents: 4, maxConcurrentTests: 2, waitingReason: 'resource queue' });
});

test('statusSummary paginates in job order, filters before paging and clamps offsets and limits', t => {
  const team = fixture(t, Array.from({ length: 205 }, (_, i) => sample(`j${i}`, { project: i % 2 ? 'p2' : 'p1', status: i % 3 ? 'ready' : 'waiting' })));
  const first = team.statusSummary();
  assert.equal(first.jobs.length, 50); assert.equal(first.total, 205); assert.equal(first.nextCursor, 50);
  const second = team.statusSummary({ limit: '100', cursor: '50' });
  assert.equal(second.jobs[0].id, 'j154'); assert.equal(second.nextCursor, 150);
  const last = team.statusSummary({ limit: 100, cursor: 150 });
  assert.equal(last.jobs.length, 55); assert.equal(last.nextCursor, null);
  assert.equal(team.statusSummary({ limit: 999 }).jobs.length, 200);
  assert.equal(team.statusSummary({ limit: 0, cursor: -5 }).jobs.length, 1);
  assert.equal(team.statusSummary({ limit: 2.9, cursor: 1.9 }).jobs[0].id, 'j203');
  assert.equal(team.statusSummary({ cursor: 'invalid' }).cursor, 0);
  assert.deepEqual(team.statusSummary({ cursor: 1000 }).jobs, []);
  const filtered = team.statusSummary({ project: 'p1', status: 'ready, waiting', limit: 1, cursor: 1 });
  assert.equal(filtered.total, 103); assert.equal(filtered.jobs[0].id, 'j202'); assert.equal(filtered.nextCursor, 2);
  assert.ok(team.statusSummary({ status: 'ready' }).jobs.every(j => j.status === 'ready'));
  assert.equal(team.statusSummary({ project: 'missing' }).total, 0);
});

test('statusSummary maps next actions and uses the specified reason priority', t => {
  const jobs = [
    sample('questions', { status: 'waiting', questions: ['Question?', 'Other'], error: 'error' }),
    sample('plan', { status: 'waiting', planGate: { version: 1 }, questions: ['Question?'], waiting: 'Approve plan' }),
    sample('quota', { status: 'blocked', blockedReason: { kind: 'quota', resetsAt: 'tomorrow' }, waiting: 'ignored' }),
    sample('transient', { status: 'blocked', blockedReason: { kind: 'transient' } }),
    sample('blocked', { status: 'blocked', error: 'broken' }),
    sample('ready', { status: 'ready' }), sample('paused', { status: 'paused' }),
    sample('waiting', { status: 'waiting' }), sample('running', { status: 'running' }),
  ];
  const rows = new Map(fixture(t, jobs).statusSummary().jobs.map(j => [j.id, j]));
  for (const [id, next] of Object.entries({ questions: 'answer_questions', plan: 'approve_plan', quota: 'wait_quota', transient: 'wait_quota', blocked: 'diagnose', ready: 'review_merge', paused: 'resume', waiting: 'none', running: 'none' })) assert.equal(rows.get(id).next, next, id);
  for (const [id, reason] of Object.entries({ questions: 'Question?', plan: 'Approve plan', quota: 'quota tomorrow', transient: 'transient', blocked: 'broken', ready: null })) assert.equal(rows.get(id).reason, reason, id);
});

test('jobDetail returns only the requested part, truncates text and supports legacy jobs', t => {
  const job = sample('j1', {
    reports: [{ stage: 'review', agent: 'a1', task: 't1', verdict: 'approved', summary: 's'.repeat(3000), findings: [{ id: 'F1' }], privateField: 'omit' }],
    tasks: [{ agent: 'a1', instruction: 'i'.repeat(1000), done: false, dependsOn: ['t0'], privateField: 'omit' }],
  });
  const team = fixture(t, [job, sample('legacy')]);
  assert.deepEqual(team.jobDetail('j1', 'summary'), team.statusSummary().jobs.find(j => j.id === 'j1'));
  assert.deepEqual(team.jobDetail('j1', 'reports'), [{ stage: 'review', agent: 'a1', task: 't1', verdict: 'approved', summary: 's'.repeat(2000), findings: [{ id: 'F1' }] }]);
  assert.deepEqual(team.jobDetail('j1', 'tasks'), [{ agent: 'a1', instruction: 'i'.repeat(500), done: false, dependsOn: ['t0'] }]);
  assert.deepEqual(team.jobDetail('j1', 'job'), job);
  assert.deepEqual(team.jobDetail('legacy', 'reports'), []); assert.deepEqual(team.jobDetail('legacy', 'tasks'), []);
  for (const part of ['events', 'invalid', undefined, null]) assert.throws(() => team.jobDetail('j1', part), /Invalid job detail part/);
  assert.throws(() => team.jobDetail('missing', 'summary'));
});

function routerFixture(team) {
  const config = { port: 3334 }, token = 'test-only-token';
  let handler;
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  team.memoryReaders = new Map(); team.on = () => {};
  runInNewContext(source, {
    URL, Buffer, console, join, resolve, extname, fileURLToPath, randomBytes, timingSafeEqual,
    msg: key => key, setLanguage() {}, getLanguage: () => 'en', languages: ['en'],
    process: { argv: [], on() {} }, existsSync: path => !path.endsWith('controller.lock'),
    readFileSync: path => path.endsWith('controller.token') ? token : JSON.stringify(config),
    mkdirSync() {}, openSync: () => 1, writeFileSync() {}, closeSync() {},
    setInterval: () => 1, setTimeout: () => 1,
    Team: class { constructor() { return team; } }, Accounts: class {}, initializeUsage: () => ({}),
    createServer: callback => { handler = callback; return { listen() {} }; },
  });
  return async (url, { method = 'GET', authenticated = true } = {}) => {
    let status, result;
    const res = { setHeader() {}, writeHead(code) { status = code; }, end(body) { result = JSON.parse(body); } };
    await handler({ method, url, headers: { host: '127.0.0.1:3334', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) } }, res);
    return { status, result };
  };
}

test('status and detail routes forward query parameters and return Team results without opening sockets', async t => {
  const team = fixture(t, [sample('j1', { reports: [{ summary: 'report' }] })]);
  const options = [], statusSummary = team.statusSummary.bind(team);
  team.statusSummary = input => { options.push(input); return statusSummary(input); };
  const request = routerFixture(team);
  const response = await request('/api/status?project=p1&status=queued%2Cready&limit=1&cursor=0');
  assert.equal(response.status, 200); assert.equal(response.result.jobs[0].id, 'j1');
  assert.deepEqual({ ...options[0] }, { project: 'p1', status: 'queued,ready', limit: '1', cursor: '0' });
  for (const part of ['summary', 'reports', 'tasks', 'job']) {
    const detail = await request(`/api/jobs/j1/detail?part=${part}`);
    assert.equal(detail.status, 200); assert.deepEqual(detail.result, JSON.parse(JSON.stringify(team.jobDetail('j1', part))));
  }
  assert.deepEqual((await request('/api/jobs/j1')).result, team.get('j1'));
  for (const url of ['/api/jobs/j1/detail?part=invalid', '/api/jobs/j1/detail', '/api/jobs/missing/detail?part=summary']) assert.equal((await request(url)).status, 400);
  for (const url of ['/api/status', '/api/jobs/j1/detail?part=job']) {
    assert.equal((await request(url, { authenticated: false })).status, 401);
    assert.equal((await request(url, { method: 'POST' })).status, 403);
  }
});

async function mcpFixture() {
  const registered = new Map(), requests = [];
  let ok = true;
  const source = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  await runInNewContext(`(async () => { ${source}\n })()`, {
    URL, URLSearchParams, AbortSignal, join, resolve, fileURLToPath, z,
    process: { env: {} }, readFileSync: path => path.endsWith('controller.token') ? 'test-only-token' : JSON.stringify({ port: 3334 }),
    McpServer: class { registerTool(name, config, callback) { registered.set(name, { config, callback }); } async connect() {} },
    StdioServerTransport: class {},
    fetch: async (url, options) => { requests.push({ url: new URL(url), options }); return { ok, json: async () => ok ? { jobs: [] } : { error: 'Missing job' } }; },
  });
  return { registered, requests, fail: () => { ok = false; }, call: (name, input) => {
    const tool = registered.get(name);
    return tool.callback(z.object(tool.config.inputSchema).parse(input));
  } };
}

test('team_status MCP exposes validated pagination and requests compact status with encoded filters', async () => {
  const { registered, requests, call } = await mcpFixture();
  assert.match(registered.get('team_status').config.description, /compact.*paginated.*job_detail/);
  await call('team_status', {});
  assert.equal(requests[0].url.pathname, '/api/status'); assert.equal(requests[0].url.search, '');
  const input = { project: 'p & /日本', status: 'ready,waiting', limit: 200, cursor: 50 };
  await call('team_status', input);
  assert.deepEqual(Object.fromEntries(requests[1].url.searchParams), { ...input, limit: '200', cursor: '50' });
  for (const input of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { cursor: -1 }, { cursor: 0.5 }, { status: [] }]) assert.throws(() => call('team_status', input));
  assert.equal(requests.length, 2);
  for (const request of requests) { assert.equal(request.options.method, 'GET'); assert.equal('body' in request.options, false); }
});

test('job_detail MCP maps every part on demand and preserves get_agent_status compatibility', async () => {
  const { requests, call, fail } = await mcpFixture();
  for (const part of ['summary', 'reports', 'tasks', 'job', 'events', 'diff', 'evidence']) {
    const result = await call('job_detail', { task_id: 'job/id', part, after: 12 });
    const { url, options } = requests.at(-1);
    assert.equal(url.pathname, `/api/jobs/job%2Fid/${['events', 'diff', 'evidence'].includes(part) ? part : 'detail'}`);
    assert.equal(url.search, part === 'events' ? '?after=12' : ['diff', 'evidence'].includes(part) ? '' : `?part=${part}`);
    assert.equal(options.method, 'GET'); assert.equal(result.isError, false);
  }
  await call('job_detail', { task_id: 'j1', part: 'events' }); assert.equal(requests.at(-1).url.search, '?after=0');
  for (const input of [{ task_id: 'j1', part: 'invalid' }, { task_id: 'j1' }, { task_id: 'j1', part: 'events', after: -1 }]) assert.throws(() => call('job_detail', input));
  await call('get_agent_status', { task_id: 'job/id' }); assert.equal(requests.at(-1).url.pathname, '/api/jobs/job%2Fid');
  fail();
  const result = await call('job_detail', { task_id: 'missing', part: 'summary' });
  assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0].text).error, 'Missing job');
});
