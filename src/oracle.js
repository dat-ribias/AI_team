import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { run, childEnv } from './process.js';

// Verified against @steipete/oracle 0.21.5 --help/--debug-help and docs:
// -p is the prompt; --followup takes a saved session id; --write-output is answer-only.
// Accounts use --browser-manual-login --browser-manual-login-profile-dir <dir>.
// --wait stays attached; ORACLE_NO_DETACH=1 keeps timeout/cancellation owning the worker.
// Session: <id> / "oracle session <id>" identify the run. On timeout, inspect that
// existing session with `oracle session <id>`; never resend the question automatically.
// https://github.com/steipete/oracle/blob/main/docs/sessions.md
export async function runOracle({ command, args = [], prompt, followup, timeoutMs = 600_000, signal }) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-team-oracle-')), output = join(dir, 'answer.md');
  let session;
  const readSession = line => {
    const text = stripVTControlCharacters(line);
    const match = text.match(/^Session:\s*([\w-]+)/m) || text.match(/\boracle session\s+([\w-]+)/);
    if (!session && match) session = match[1];
  };
  try {
    const result = await run(command, ['--engine', 'browser', ...args, '-p', prompt,
      ...(followup ? ['--followup', followup] : []), '--wait', '--browser-archive', 'never',
      '--browser-timeout', `${timeoutMs}ms`, '--write-output', output], {
      timeoutMs, signal, env: { ...childEnv(), ORACLE_NO_DETACH: '1' }, onLine: readSession, allowFailure: true,
    });
    const log = stripVTControlCharacters(result.stdout + '\n' + result.stderr);
    if (/too many requests/i.test(log)) throw new Error('Too many requests');
    if (/captcha|verify (?:that )?you are human|cloudflare challenge/i.test(log)) throw new Error('captcha challenge');
    if (/session (?:has )?expired|log ?in again/i.test(log)) throw new Error('session expired');
    if (/not (?:logged|signed) in|please (?:log|sign) in|login required|sign.in required|unauthenticated|authentication required/i.test(log)) throw new Error('not logged in');
    if (/timed? out|timeout/i.test(log) && result.code !== 0) throw new Error('timeout');
    if (result.code !== 0) throw new Error(`exit ${result.code}`);
    let answer;
    try { answer = readFileSync(output, 'utf8').trim(); } catch { throw new Error('no answer output'); }
    if (!answer) throw new Error('empty answer');
    if (!session) throw new Error('missing session id');
    return { answer, session };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    const reason = error.timeout || /timed? out|timeout/i.test(error.message) ? 'timeout' : error.message;
    throw Object.assign(new Error(`ChatGPT web: ${String(reason).slice(0, 140)}`), session ? { session } : {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
