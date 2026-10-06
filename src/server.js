import { createServer } from 'node:http';
import { msg, setLanguage, getLanguage, languages } from './i18n.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Team } from './team.js';
import { Accounts } from './accounts.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const flag = process.argv.indexOf('--config');
const file = resolve(flag >= 0 ? process.argv[flag + 1] : join(root, 'team.config.json'));
if (!existsSync(file)) { console.error(msg("srv.server.chay_npm_run_setup_truoc")); process.exit(1); }
const config = JSON.parse(readFileSync(file, 'utf8'));
setLanguage(config.language || 'vi');
const startedAt = Date.now();
// Code trên đĩa mới hơn lúc server khởi động → giao diện báo cần khởi động lại.
const stale = () => { try { return readdirSync(join(root, 'src')).some(f => f.endsWith('.js') && statSync(join(root, 'src', f)).mtimeMs > startedAt); } catch { return false; } };
const dataDir = resolve(config.dataDir || join(root, '.team/state'));
mkdirSync(dataDir, { recursive: true });
const lockFile = join(dataDir, 'controller.lock');
if (existsSync(lockFile)) {
  const pid = Number(readFileSync(lockFile, 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
  if (alive) throw new Error(msg("srv.server.controller_pid_dang_giu_state_nay", { 0: pid }));
  unlinkSync(lockFile);
}
const lock = openSync(lockFile, 'wx'); writeFileSync(lock, String(process.pid)); closeSync(lock);
process.on('exit', () => { try { unlinkSync(lockFile); } catch {} });
const tokenFile = join(dataDir, 'controller.token');
const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8') : randomBytes(32).toString('hex');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, token, { mode: 0o600 });
const team = new Team(config, dataDir);
const accounts = new Accounts(team, file, root);
const port = config.port || 3333, origin = `http://127.0.0.1:${port}`;
const cookieName = `team_session_${port}`;
const clients = new Set();
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const equal = value => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
async function body(req, limit = 100_000) {
  let text = ''; for await (const chunk of req) { text += chunk; if (text.length > limit) throw new Error(msg("srv.server.body_qua_lon")); }
  return text ? JSON.parse(text) : {};
}
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, { error: msg("srv.server.host_khong_hop_le_dung_127") });
    if (req.headers.origin && req.headers.origin !== origin) return send(res, 403, { error: msg("srv.server.origin_khong_hop_le") });
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Cross-site request denied' });
    const url = new URL(req.url, origin);
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const locale = /^\/locales\/(vi|en|ja)\.json$/.exec(url.pathname);
    if (req.method === 'GET' && locale) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(readFileSync(join(root, 'locales', `${locale[1]}.json`))); return; }
    if (req.method === 'GET' && assets[url.pathname]) {
      if (url.pathname === '/') res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
      const [name, type] = assets[url.pathname]; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(readFileSync(join(root, 'public', name))); return;
    }
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!equal(bearer) && !equal(cookie)) return send(res, 401, { error: msg("srv.server.mo_dashboard_de_tao_phien_dang") });
    if (req.method === 'POST' && req.headers['x-team-request'] !== '1') return send(res, 403, { error: msg("srv.server.thieu_csrf_header") });
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const state = team.state();
      state.agents = state.agents.map(a => ({ ...a, auth: accounts.snapshot(team.agent(a.id)) }));
      state.providers = accounts.providers();
      Object.assign(state, { language: getLanguage(), languages, stale: stale() });
      return send(res, 200, state);
    }
    if (req.method === 'GET' && url.pathname === '/api/skills') return send(res, 200, team.skills(url.searchParams.has('refresh')).map(({ name, description, source }) => ({ name, description, source })));
    if (req.method === 'GET' && url.pathname === '/api/mcp/claude') return send(res, 200, accounts.claudeMcp());
    if (req.method === 'POST' && url.pathname === '/api/projects') return send(res, 201, await accounts.addProject(await body(req)));
    if (req.method === 'POST' && url.pathname === '/api/projects/pick') return send(res, 200, await accounts.pickFolder());
    const projectRemove = /^\/api\/projects\/([a-z0-9-]+)\/remove$/.exec(url.pathname);
    if (req.method === 'POST' && projectRemove) return send(res, 200, await accounts.removeProject(projectRemove[1], await body(req)));
    const projectUpdate = /^\/api\/projects\/([a-z0-9-]+)\/update$/.exec(url.pathname);
    if (req.method === 'POST' && projectUpdate) return send(res, 200, accounts.updateProject(projectUpdate[1], await body(req)));
    const projectDirs = /^\/api\/projects\/([a-z0-9-]+)\/read-dirs$/.exec(url.pathname);
    if (req.method === 'POST' && projectDirs) return send(res, 200, accounts.setReadDirs(projectDirs[1], (await body(req)).readDirs));
    const projectAccess = /^\/api\/projects\/([a-z0-9-]+)\/access(\/propose)?$/.exec(url.pathname);
    if (req.method === 'POST' && projectAccess) { const input = await body(req); return send(res, 200, projectAccess[2] ? await team.proposeAccess(projectAccess[1], Array.isArray(input.candidates) ? input.candidates.slice(0, 20) : []) : accounts.setAccess(projectAccess[1], input)); }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const input = await body(req);
      if (!languages.includes(input.language)) throw new Error('language: vi | en | ja');
      const next = structuredClone(team.config); next.language = input.language; accounts.persist(next); setLanguage(input.language);
      return send(res, 200, { language: getLanguage() });
    }
    if (req.method === 'POST' && url.pathname === '/api/members') return send(res, 201, accounts.add(await body(req)));
    const memberMatch = /^\/api\/members\/([a-z0-9-]+)\/(login|cancel-login|refresh|role|profile|models|usage|terminal)$/.exec(url.pathname);
    if (req.method === 'POST' && memberMatch) {
      const [, id, action] = memberMatch;
      if (action === 'login') return send(res, 200, await accounts.login(id));
      if (action === 'cancel-login') return send(res, 200, await accounts.cancel(id));
      if (action === 'refresh') return send(res, 200, await accounts.refresh(id));
      if (action === 'profile') return send(res, 200, accounts.profile(id, await body(req)));
      if (action === 'models') return send(res, 200, await accounts.models(id));
      if (action === 'usage') return send(res, 200, await accounts.usage(id));
      if (action === 'terminal') return send(res, 200, accounts.openTerminal(id));
      const input = await body(req); return send(res, 200, accounts.role(id, input.kind, input.on));
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); res.write('data: {}\n\n'); clients.add(res);
      req.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sessions') return send(res, 201, team.createSession(await body(req)));
    const sessionRename = /^\/api\/sessions\/([a-z0-9-]+)\/rename$/.exec(url.pathname);
    const sessionDelete = /^\/api\/sessions\/([a-z0-9-]+)\/delete$/.exec(url.pathname);
    if (req.method === 'POST' && sessionDelete) return send(res, 200, await team.deleteSession(sessionDelete[1]));
    if (req.method === 'POST' && sessionRename) return send(res, 200, team.renameSession(sessionRename[1], (await body(req)).name));
    if (req.method === 'POST' && url.pathname === '/api/jobs') return send(res, 201, await team.create(await body(req, 160e6)));
    if (req.method === 'POST' && url.pathname === '/api/quota') { team.refreshQuota().catch(e => console.error(e.message)); return send(res, 202, { refreshing: true }); }
    if (req.method === 'GET' && url.pathname === '/api/quota-history') return send(res, 200, team.db.prepare('SELECT agent,body FROM quota_history ORDER BY seq DESC LIMIT 400').all().map(r => ({ agent: r.agent, ...JSON.parse(r.body) })));
    const match = /^\/api\/jobs\/([a-z0-9-]+)(?:\/(events|diff|control|merge|merge-check))?$/.exec(url.pathname);
    if (match) {
      const [, id, action] = match;
      if (req.method === 'GET' && !action) return send(res, 200, team.get(id));
      if (req.method === 'GET' && action === 'events') return send(res, 200, team.events(id, Math.max(0, Number(url.searchParams.get('after')) || 0)));
      if (req.method === 'GET' && action === 'diff') return send(res, 200, await team.diff(id));
      if (req.method === 'POST' && action === 'control') { const input = await body(req, 160e6); return send(res, 200, await team.control(id, input.action, input)); }
      if (req.method === 'GET' && action === 'merge-check') return send(res, 200, await team.mergeCheck(id));
      if (req.method === 'POST' && action === 'merge') return send(res, 200, await team.merge(id, await body(req)));
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, e.code === 409 ? 409 : 400, { error: e.message, ...(e.jobs ? { jobs: e.jobs } : {}) }); }
});
let update;
function broadcast() {
  if (update) return;
  update = setTimeout(() => { update = null; for (const client of clients) { if (client.writableLength > 65536) { client.end(); clients.delete(client); } else client.write('data: {}\n\n'); } }, 200);
}
team.on('event', broadcast); team.on('change', broadcast); team.on('fault', e => console.error(e));
const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 15000);
const quotaTimer = setInterval(() => team.refreshQuota().catch(e => console.error(e)), 5 * 60_000);
server.listen(port, '127.0.0.1', () => {
  console.log(`AI Team ${config.demo ? 'DEMO' : 'LIVE'}: ${origin}`); team.start();
  (async () => { for (const a of team.config.agents) await accounts.refresh(a.id); await team.refreshQuota(); })().catch(e => console.error(e));
});
async function shutdown() { clearInterval(heartbeat); clearInterval(quotaTimer); for (const c of clients) c.end(); server.close(); await accounts.close(); await team.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
