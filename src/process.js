import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, delimiter, isAbsolute, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Invoke npm's JS entry point directly on Windows; never put prompts through cmd.exe.
const cliNames = { codex: 'codex', claude: 'claude', gemini: 'gemini', antigravity: 'agy' };
// npm tạo shim .cmd trỏ tới file JS; đọc shim để gọi thẳng node + JS (không qua cmd.exe).
function shimEntry(file) {
  try {
    const match = readFileSync(file, 'utf8').match(/node_modules[\\/][^"%\r\n*?]+?\.[cm]?js/i);
    const path = match && join(dirname(file), ...match[0].split(/[\\/]/));
    return path && existsSync(path) ? path : null;
  } catch { return null; }
}
export function commandFromPath(path) {
  if (!path || !existsSync(path)) return null;
  const ext = extname(path).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(ext)) return [process.execPath, path];
  if (['.cmd', '.bat'].includes(ext)) { const js = shimEntry(path); return js ? [process.execPath, js] : null; }
  if (ext === '.ps1') return commandFromPath(path.slice(0, -4) + '.cmd');
  return process.platform === 'win32' && ext !== '.exe' ? null : [path];
}
function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) for (const ext of exts) {
    const command = commandFromPath(join(dir, name + ext)); if (command) return command;
  }
  return null;
}
export function executable(name) {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '', home = process.env.USERPROFILE || '', npm = join(process.env.APPDATA || '', 'npm');
    const candidates = {
      agy: [join(local, 'agy/bin/agy.exe'), join(local, 'Programs/agy/agy.exe'), join(local, 'Programs/agy/bin/agy.exe'), join(home, '.local/bin/agy.exe')],
      claude: [join(home, '.local/bin/claude.exe'), join(npm, 'node_modules/@anthropic-ai/claude-code/cli.js'), join(npm, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe')],
      codex: [join(npm, 'node_modules/@openai/codex/bin/codex.js')],
      gemini: [join(npm, 'node_modules/@google/gemini-cli/bundle/gemini.js'), join(npm, 'node_modules/@google/gemini-cli/dist/index.js')],
    }[name] || [];
    for (const path of candidates) { const command = commandFromPath(path); if (command) return command; }
  }
  return onPath(name) || [name];
}
// Lệnh đã lưu trong config còn dùng được thì giữ; không thì dò lại (cài CLI sau khi tạo member vẫn nhận).
export function resolveCommand(agent) {
  if (Array.isArray(agent.command) && commandAvailable(agent.command)) return agent.command;
  return executable(cliNames[agent.provider] || agent.provider);
}

export function commandAvailable(command) {
  if (!Array.isArray(command) || !command.length) return false;
  const [program, entry] = command;
  if (entry && extname(entry) === '.js' && !existsSync(entry)) return false;
  if (isAbsolute(program)) return existsSync(program);
  return !!onPath(program.replace(/\.exe$/i, ''));
}

export function childEnv(agent) {
  const env = { ...process.env };
  // A worker must not inherit the controller's or desktop's account/API credentials.
  for (const key of Object.keys(env)) if (/^(CODEX_|OPENAI_|CLAUDE_|ANTHROPIC_|GEMINI_CLI_HOME$|GEMINI_API_KEY$|GOOGLE_API_KEY$|TEAM_)/i.test(key)) delete env[key];
  // Bí mật khác trong môi trường (token, mật khẩu, khóa cloud) cũng không chuyển cho agent.
  for (const key of Object.keys(env)) if (/(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|CREDENTIAL)|^(AWS_|AZURE_|GCP_|GOOGLE_APPLICATION_CREDENTIALS$|KINTONE_|SSH_AUTH_SOCK$|NPM_CONFIG__AUTH)/i.test(key)) delete env[key];
  if (agent?.home && (agent.provider === 'codex' || !agent.provider)) env.CODEX_HOME = agent.home;
  if (agent?.home && agent.provider === 'claude') env.CLAUDE_CONFIG_DIR = agent.home;
  if (agent?.home && agent.provider === 'gemini') env.GEMINI_CLI_HOME = agent.home;
  return env;
}

export async function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', reject); killer.on('close', code => code === 0 ? resolve() : reject(new Error(`taskkill failed (${code})`)));
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function launch(command, args = [], options = {}) {
  if (!Array.isArray(command) || !command.length || command.some(v => typeof v !== 'string')) throw new Error('Command must be an argv array');
  if (['.cmd', '.bat', '.ps1'].includes(extname(command[0]).toLowerCase())) throw new Error('Use an .exe or node + JS entry point, not a shell shim');
  return spawn(command[0], [...command.slice(1), ...args], {
    cwd: options.cwd, env: options.env || childEnv(), windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
}

export function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('Run interrupted'));
    let child;
    try { child = launch(command, args, options); } catch (error) { return reject(error); }
    let stdout = '', stderr = '', failure, stopping = false;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const buffers = { stdout: '', stderr: '' };
    const stop = message => {
      if (stopping) return;
      stopping = true; failure = new Error(message);
      killTree(child).catch(error => {
        // taskkill can be restricted by a Windows job/sandbox; the owned child handle may still be terminable.
        try { if (!child.kill('SIGKILL') && child.exitCode === null) failure = error; }
        catch (killError) { failure = killError; }
      });
    };
    const aborted = () => stop('Run interrupted');
    options.signal?.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(() => stop('Process timed out'), options.timeoutMs || 30 * 60_000);
    function chunk(stream, value) {
      if (stream === 'stdout') stdout = (stdout + value).slice(-2_000_000);
      else stderr = (stderr + value).slice(-32_000);
      buffers[stream] += value;
      if (buffers[stream].length > 2_000_000) return stop('Output line exceeds 2 MB');
      let index;
      while ((index = buffers[stream].indexOf('\n')) >= 0) {
        const line = buffers[stream].slice(0, index).replace(/\r$/, '');
        buffers[stream] = buffers[stream].slice(index + 1);
        try { options.onLine?.(line, stream); } catch (error) { stop(error.message); }
      }
    }
    child.stdout.on('data', b => chunk('stdout', decoders.stdout.write(b)));
    child.stderr.on('data', b => chunk('stderr', decoders.stderr.write(b)));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error.message); });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', aborted);
      for (const stream of ['stdout', 'stderr']) {
        chunk(stream, decoders[stream].end());
        if (buffers[stream]) { try { options.onLine?.(buffers[stream], stream); } catch (e) { failure = e; } }
      }
      if (failure) reject(failure);
      else if (code !== 0 && !options.allowFailure) reject(new Error(`Exit ${code}: ${stderr || stdout}`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input || '');
  });
}
