import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer, stopTree } from '../src/preview.js';

const processAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

async function waitGone(pid) {
  const until = Date.now() + 5000;
  while (processAlive(pid)) {
    assert(Date.now() < until, `Fixture PID ${pid} survived cleanup`);
    await delay(10);
  }
}

test('stopTree returns with the preview shell gone and can stop it again', { timeout: 20_000 }, async t => {
  // Exercise the preview shell wrapper without opening a server or a port.
  const leafCode = "process.send('ready'); setTimeout(() => process.exit(), 10000);";
  const code = `
    const { spawn } = require('node:child_process');
    setTimeout(() => process.exit(), 10000);
    const leaf = spawn(process.execPath, ['-e', ${JSON.stringify(leafCode)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    leaf.once('message', () => console.log(JSON.stringify({ pid: process.pid, leaf: leaf.pid })));
  `;
  const encoded = Buffer.from(code).toString('base64');
  const server = startServer({
    command: `node -e "eval(Buffer.from('${encoded}', 'base64').toString())"`,
    cwd: process.cwd(), port: 3334,
  });
  const closed = once(server.child, 'close');
  const output = createInterface({ input: server.child.stdout });
  let pids;
  t.after(async () => {
    output.close();
    try { await stopTree(server.pid); }
    finally {
      // Own every fixture PID even when an assertion or taskkill fails.
      for (const pid of [server.pid, pids?.pid, pids?.leaf].filter(Boolean)) {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      let timer;
      try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture close timed out')), 5000); })]); }
      finally { clearTimeout(timer); }
      for (const pid of [server.pid, pids?.pid, pids?.leaf].filter(Boolean)) await waitGone(pid);
    }
  });
  const [line] = await Promise.race([
    once(output, 'line', { signal: AbortSignal.timeout(5000) }),
    closed.then(() => { throw new Error(`Fixture exited before ready: ${server.log()}`); }),
  ]);
  pids = JSON.parse(line);
  assert(processAlive(server.pid));
  assert(processAlive(pids.pid));
  assert(processAlive(pids.leaf));
  await stopTree(server.pid);
  // No grace period here: the caller clears the PID immediately after stopTree.
  assert.equal(processAlive(server.pid), false);
  // Descendants can finish releasing handles asynchronously; use a deadline.
  await waitGone(pids.pid);
  await waitGone(pids.leaf);
  await stopTree(server.pid);
  assert.equal(processAlive(server.pid), false);
});

function failingKill(t, failure, probeError) {
  const probes = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal === 0) {
      probes.push(pid);
      if (probeError) throw probeError;
      return true;
    }
    throw failure;
  });
  if (process.platform === 'win32') {
    t.mock.method(childProcess.default, 'spawn', () => {
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit('error', failure));
      return killer;
    });
    syncBuiltinESMExports();
  }
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return probes;
}

test('stopTree preserves a real kill failure while the PID is alive', async t => {
  const failure = Object.assign(new Error('taskkill denied'), { code: 'EACCES' });
  const probes = failingKill(t, failure);
  await assert.rejects(stopTree(12345), error => error === failure);
  assert.deepEqual(probes, [12345]);
});

test('stopTree treats a PID that disappeared during taskkill failure as stopped', async t => {
  const failure = new Error('taskkill failed');
  const probes = failingKill(t, failure, Object.assign(new Error('gone'), { code: 'ESRCH' }));
  await stopTree(12345);
  assert.deepEqual(probes, [12345]);
});

test('stopTree preserves a kill failure when the liveness probe is denied', async t => {
  const failure = new Error('taskkill failed');
  const probes = failingKill(t, failure, Object.assign(new Error('denied'), { code: 'EPERM' }));
  await assert.rejects(stopTree(12345), error => error === failure);
  assert.deepEqual(probes, [12345]);
});

test('stopTree ignores a missing PID without attempting termination', async t => {
  const probes = failingKill(t, new Error('must not kill'));
  await stopTree();
  await stopTree(null);
  assert.deepEqual(probes, []);
});
