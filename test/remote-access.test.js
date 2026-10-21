import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { runInNewContext } from 'node:vm';

function router() {
  const config = { port: 3334, ping: false, remote: { hosts: ['team.example.com'] } }, token = 'controller-token-xyz', key = 'remote-key-123456';
  let handler;
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  const team = { memoryReaders: new Map(), on() {}, statusSummary: () => ({ jobs: [] }) };
  runInNewContext(source, {
    URL, Buffer, console: { log() {}, error() {} }, join, resolve, extname, fileURLToPath, randomBytes, timingSafeEqual,
    msg: k => k, setLanguage() {}, getLanguage: () => 'en', languages: ['en'], process: { argv: [], on() {}, env: {} },
    existsSync: p => !p.endsWith('controller.lock'), mkdirSync() {}, openSync: () => 1, writeFileSync() {}, closeSync() {}, setInterval: () => 1, setTimeout: () => 1,
    readFileSync: p => p.endsWith('controller.token') ? token : p.endsWith('remote.key') ? key : p.endsWith('.html') ? `<html>${p.split(/[\\/]/).pop()}</html>` : JSON.stringify(config),
    Team: class { constructor() { return team; } }, Accounts: class {}, initializeUsage: () => ({}), createServer: cb => { handler = cb; return { listen() {} }; },
  });
  return async (url, { method = 'GET', host = 'team.example.com', cookie, body, origin } = {}) => {
    let status, out = '', headers = {};
    const chunks = body ? [JSON.stringify(body)] : [];
    const req = { method, url, headers: { host, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(method === 'POST' ? { 'x-team-request': '1' } : {}) }, [Symbol.asyncIterator]: async function* () { yield* chunks; } };
    const res = { setHeader(k, v) { headers[k.toLowerCase()] = v; }, writeHead(code, h = {}) { status = code; Object.assign(headers, Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))); }, end(b) { out = String(b); } };
    await handler(req, res);
    return { status, out, headers, token, key };
  };
}

test('remote host: login page instead of a free cookie, key unlocks a Secure session, unknown hosts stay blocked', async () => {
  const r = router();
  const page = await r('/');
  assert.equal(page.status, 200); assert.match(page.out, /remote-login\.html/); assert.equal(page.headers['set-cookie'], undefined);
  assert.equal((await r('/api/status')).status, 401);
  assert.equal((await r('/api/remote-login', { method: 'POST', body: { key: 'wrong' } })).status, 401);
  const ok = await r('/api/remote-login', { method: 'POST', body: { key: page.key }, origin: 'https://team.example.com' });
  assert.equal(ok.status, 200); assert.match(ok.headers['set-cookie'], /HttpOnly; Secure; SameSite=Strict/);
  const cookie = ok.headers['set-cookie'].split(';')[0];
  assert.equal((await r('/api/status', { cookie })).status, 200);
  assert.match((await r('/', { cookie })).out, /index\.html/);
  assert.equal((await r('/', { host: 'evil.example.com' })).status, 403);
  assert.equal((await r('/api/status', { cookie, origin: 'https://evil.example.com' })).status, 403);
  const local = await r('/', { host: '127.0.0.1:3334' }); assert.match(local.headers['set-cookie'], /^team_session_3334=/);
  for (let i = 0; i < 9; i++) await r('/api/remote-login', { method: 'POST', body: { key: 'x' + i } });
  assert.equal((await r('/api/remote-login', { method: 'POST', body: { key: page.key } })).status, 429, 'brute force is throttled');
});
