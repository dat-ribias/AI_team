import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { startDemoServer, freePort } from '../src/preview.js';
import { DEMO } from '../src/capabilities.js';

const shellCommand = command => process.platform === 'win32' ? `"${command}"` : command;
const command = shellCommand(`"${process.execPath}" -e "const fs=require('node:fs');fs.writeFileSync(require('node:path').join(process.env.DATA_DIR,'proof.txt'),'demo');require('node:http').createServer((req,res)=>res.end(JSON.stringify({pid:process.pid,dataDir:process.env.DATA_DIR,argument:process.argv[1]}))).listen(Number(process.env.PORT),'127.0.0.1')" "{dataDir}"`);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const portOpen = port => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
const until = async predicate => {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) { assert(Date.now() < deadline, 'Demo cleanup timed out'); await new Promise(resolve => setTimeout(resolve, 50)); }
};

test('demo excludes port 3333, isolates data, caps lifetime and stops idempotently', { timeout: 20_000 }, async t => {
  const started = Date.now();
  const demo = await startDemoServer({ command, cwd: process.cwd(), portRange: [3333, 3334], maxMinutes: DEMO.maxMinutes + 1 });
  t.after(() => demo.stop());
  assert.equal(demo.port, 3334);
  assert.equal(demo.url, 'http://127.0.0.1:3334');
  assert(demo.dataDir.startsWith(join(tmpdir(), 'ai-team-demo-')));
  assert.equal(readFileSync(join(demo.dataDir, 'proof.txt'), 'utf8'), 'demo');
  const response = await (await fetch(demo.url)).json();
  assert.equal(response.dataDir, demo.dataDir);
  assert.equal(response.argument, demo.dataDir);
  assert(alive(demo.pid)); assert(alive(response.pid));
  assert(Date.parse(demo.stopsAt) >= started + DEMO.maxMinutes * 60_000);
  assert(Date.parse(demo.stopsAt) <= Date.now() + DEMO.maxMinutes * 60_000);
  const stop = demo.stop();
  assert.equal(demo.stop(), stop);
  await stop; await demo.stop();
  await until(async () => !alive(demo.pid) && !alive(response.pid) && !await portOpen(demo.port));
  assert.equal(existsSync(demo.dataDir), false);
});

test('demo expiry kills the process tree, closes the port and removes temporary data', { timeout: 20_000 }, async t => {
  const demo = await startDemoServer({ command, cwd: process.cwd(), portRange: [43000, 43020], exclude: [43000], maxMinutes: 0.02 });
  t.after(() => demo.stop());
  assert.notEqual(demo.port, 43000);
  const response = await (await fetch(demo.url)).json();
  assert(existsSync(demo.dataDir));
  await until(async () => !existsSync(demo.dataDir) && !alive(demo.pid) && !alive(response.pid) && !await portOpen(demo.port));
  assert(Date.now() >= Date.parse(demo.stopsAt));
  await demo.stop();
});

test('demo readiness failure stops the server before rejecting', { timeout: 20_000 }, async () => {
  const port = await freePort([43021, 43040]);
  const failing = shellCommand(`"${process.execPath}" -e "require('node:http').createServer((req,res)=>{res.writeHead(503);res.end()}).listen(Number(process.env.PORT),'127.0.0.1')"`);
  await assert.rejects(startDemoServer({ command: failing, cwd: process.cwd(), portRange: [port, port], timeoutSec: 1 }), /readiness timed out/);
  await until(async () => !await portOpen(port));
});
