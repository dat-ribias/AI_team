import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { rm as rmAsync } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { killTree } from './process.js';
import { msg } from './i18n.js';
import { DEMO } from './capabilities.js';

const delay = ms => new Promise(r => setTimeout(r, ms));
export async function removeTempDir(dir, { rm = rmAsync, retries = 20, delayMs = 100, log = console.warn } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); return true; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      if (attempt >= retries) { log(`[preview] could not remove temp dir ${dir}: ${error.code}`); return false; }
      await delay(delayMs);
    }
  }
}
export function validatePreview(p) {
  if (p == null) return null;
  const invalid = reason => { throw new Error(msg('srv.preview.invalid_config', { 0: reason })); };
  if (typeof p !== 'object' || Array.isArray(p)) invalid('preview');
  if (typeof p.command !== 'string' || !p.command.trim() || !p.command.includes('{port}')) invalid('command: {port}');
  const localPath = path => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\\\r\n]/.test(path);
  const readyPath = p.readyPath ?? '/', routes = p.routes ?? [{ name: 'home', path: '/' }];
  if (!localPath(readyPath)) invalid('readyPath');
  if (!Array.isArray(routes) || routes.length < 1 || routes.length > 10 || routes.some(r => !r || typeof r.name !== 'string' || !r.name.trim() || !localPath(r.path))) invalid('routes');
  const number = (key, min, max, fallback) => { const n = p[key] ?? fallback; if (!Number.isInteger(n) || n < min || n > max) invalid(key); return n; };
  const portRange = p.portRange ?? [4100, 4199];
  if (!Array.isArray(portRange) || portRange.length !== 2 || portRange.some(n => !Number.isInteger(n) || n < 1 || n > 65535) || portRange[0] > portRange[1]) invalid('portRange');
  if (p.requireAcceptance !== undefined && typeof p.requireAcceptance !== 'boolean') invalid('requireAcceptance');
  return { command: p.command.trim(), readyPath, routes: routes.map(r => ({ name: r.name.trim(), path: r.path })), timeoutSec: number('timeoutSec', 5, 600, 120), ttlMin: number('ttlMin', 1, 240, 30), portRange: [...portRange], requireAcceptance: p.requireAcceptance ?? true };
}
export function previewEnv(port) {
  const env = {}, allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'home', 'userprofile', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)']);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value;
  return { ...env, PORT: String(port), BROWSER: 'none' };
}
export function startServer({ command, cwd, port, env: extraEnv }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(msg('srv.preview.invalid_config', { 0: 'port' }));
  const cmd = command.replaceAll('{port}', String(port)), env = { ...previewEnv(port), ...extraEnv };
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
    : spawn('/bin/sh', ['-c', cmd], { cwd, env, detached: true });
  const lines = [], buffers = { stdout: '', stderr: '' }, decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const chunk = (stream, text) => {
    buffers[stream] = (buffers[stream] + text).slice(-64_000);
    const parts = buffers[stream].split(/\r?\n/); buffers[stream] = parts.pop();
    lines.push(...parts); if (lines.length > 200) lines.splice(0, lines.length - 200);
  };
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', b => chunk(stream, decoders[stream].write(b)));
  child.on('error', error => { child.previewError = error; lines.push(error.message); });
  child.on('close', () => { for (const stream of ['stdout', 'stderr']) chunk(stream, decoders[stream].end()); });
  child.stdin.end();
  return { child, pid: child.pid, log: () => [...lines, ...Object.values(buffers).filter(Boolean)].slice(-200).join('\n') };
}
export async function waitReady(url, timeoutSec, child) {
  const until = Date.now() + timeoutSec * 1000;
  while (Date.now() < until) {
    if (child.previewError || child.exitCode !== null || child.signalCode) throw child.previewError || new Error('Preview process exited');
    try { const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, until - Date.now()))), redirect: 'manual' }); await res.body?.cancel(); if (res.ok) return; } catch {}
    await delay(Math.min(500, Math.max(0, until - Date.now())));
  }
  throw new Error('Preview readiness timed out');
}
export async function freePort([from, to], exclude = []) {
  for (let port = from; port <= to; port++) {
    if (exclude.includes(port)) continue;
    const free = await new Promise(resolve => {
      const server = createServer(); server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('No free preview port');
}
export async function stopTree(pid) {
  if (!pid) return;
  try { await killTree({ pid, exitCode: null }); }
  catch (error) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return; } if (error.code !== 'ESRCH') throw error; }
}
export async function startDemoServer({ command, cwd, portRange, exclude = [], maxMinutes = DEMO.maxMinutes, readyPath = '/', timeoutSec = 120 }) {
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('Invalid demo server lifetime');
  const port = await freePort(portRange, [...DEMO.reservedPorts, ...exclude]);
  const dataDir = mkdtempSync(join(tmpdir(), 'ai-team-demo-'));
  let server, timer, stopping;
  const stop = () => stopping ||= (async () => {
    clearTimeout(timer);
    try { await stopTree(server?.pid); }
    finally {
      await removeTempDir(dataDir);
    }
  })();
  const url = `http://127.0.0.1:${port}`, lifetime = Math.min(maxMinutes, DEMO.maxMinutes) * 60_000;
  const stopsAt = new Date(Date.now() + lifetime).toISOString();
  try {
    server = startServer({ command: command.replaceAll('{dataDir}', dataDir), cwd, port, env: { DATA_DIR: dataDir } });
    timer = setTimeout(() => { stop().catch(error => { server.child.previewError = error; }); }, lifetime); timer.unref();
    await waitReady(url + readyPath, timeoutSec, server.child);
    return { url, port, dataDir, pid: server.pid, stopsAt, stop };
  } catch (error) { await stop(); throw error; }
}
export function findChrome() {
  const candidates = [process.env.CHROME_PATH];
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)) candidates.push(join(root, 'Google/Chrome/Application/chrome.exe'), join(root, 'Microsoft/Edge/Application/msedge.exe'));
  } else candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  return candidates.find(p => p && existsSync(p)) || null;
}
export async function screenshot({ chrome, url, width, height, file }) {
  const profile = mkdtempSync(join(tmpdir(), 'ai-team-preview-chrome-'));
  let child, socket, timer;
  const pending = new Map();
  try {
    child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { env: previewEnv(0), windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' });
    child.on('error', error => { child.previewError = error; });
    const active = join(profile, 'DevToolsActivePort'), until = Date.now() + 20_000;
    while (!existsSync(active)) { if (child.previewError || child.exitCode !== null || Date.now() > until) throw child.previewError || new Error('Chrome startup timed out'); await delay(100); }
    const port = Number(readFileSync(active, 'utf8').split('\n')[0]), endpoint = `http://127.0.0.1:${port}/json/new?about:blank`;
    let res = await fetch(endpoint, { method: 'PUT', signal: AbortSignal.timeout(5000) });
    if (!res.ok) res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('Chrome target unavailable');
    socket = new WebSocket((await res.json()).webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('CDP connection timed out')), 5000); socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true }); socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP connection failed')); }, { once: true }); });
    let seq = 0, loaded;
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data), request = pending.get(data.id);
      if (request) { pending.delete(data.id); clearTimeout(request.timer); data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result); }
      if (data.method === 'Page.loadEventFired') loaded?.();
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000) }); socket.send(JSON.stringify({ id, method, params })); });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await send('Page.enable');
    const load = new Promise(resolve => { loaded = resolve; });
    const navigation = await send('Page.navigate', { url }); if (navigation.errorText) throw new Error(navigation.errorText);
    await Promise.race([load, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Page load timed out')), 20_000); })]); clearTimeout(timer);
    await delay(500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(shot.data, 'base64'));
  } finally {
    clearTimeout(timer); for (const request of pending.values()) clearTimeout(request.timer);
    socket?.close();
    try { await stopTree(child?.pid); }
    finally {
      if (child && child.exitCode === null && !child.signalCode) await new Promise(resolve => { const timeout = setTimeout(resolve, 3000); child.once('close', () => { clearTimeout(timeout); resolve(); }); });
      // Windows may release Chromium's profile handles shortly after taskkill finishes.
      await removeTempDir(profile);
    }
  }
}
