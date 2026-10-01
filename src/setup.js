import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { executable, run } from './process.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const demo = process.argv.includes('--demo');
const configFile = join(root, demo ? '.team/demo.config.json' : 'team.config.json');
mkdirSync(join(root, '.team'), { recursive: true });
if (existsSync(configFile)) { console.log(`Cấu hình đã có: ${configFile}`); process.exit(0); }
const accounts = join(homedir(), '.ai-team', 'accounts');
const agents = [
  { id: 'codex-1', label: 'Codex 01', role: 'Manager' },
  { id: 'codex-2', label: 'Codex 02', role: 'Builder' },
  { id: 'codex-3', label: 'Codex 03', role: 'Verifier / Builder' },
].map(a => ({ ...a, provider: demo ? 'mock' : 'codex', home: join(accounts, a.id), command: executable('codex'), enabled: true }));
agents.push({ id: 'gemini', label: 'Gemini Pro', role: 'Independent reviewer', provider: demo ? 'mock' : 'antigravity', command: executable('agy'), enabled: true, quotaPrintSupported: false });
if (!demo) for (const a of agents.filter(a => a.provider === 'codex')) {
  mkdirSync(a.home, { recursive: true, mode: 0o700 });
  const config = join(a.home, 'config.toml');
  if (!existsSync(config)) writeFileSync(config, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
}
const projects = [];
if (demo) {
  const path = join(root, '.team', 'demo-repo'); mkdirSync(path, { recursive: true });
  await run(['git'], ['init', '-b', 'main', path]);
  writeFileSync(join(path, 'hello.txt'), 'Hello!\n');
  await run(['git'], ['-C', path, 'add', '.']);
  await run(['git'], ['-C', path, '-c', 'user.name=AI Team Demo', '-c', 'user.email=demo@localhost', 'commit', '-m', 'Demo initial state']);
  projects.push({ id: 'demo', path, tests: [[process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('hello.txt','utf8'),'Hello from AI Team demo!\\n')"]] });
}
writeFileSync(configFile, JSON.stringify({ demo, port: demo ? 3334 : 3333, dataDir: join(root, '.team', demo ? 'demo-state' : 'state'), maxRamPercent: 85, maxCpuPercent: 90, minRemainingPercent: 15, maxReworkRounds: 3, agents, projects }, null, 2));
console.log(`Đã tạo ${configFile}`);
console.log(demo ? 'Chạy: node src/server.js --config .team/demo.config.json' : 'Đăng nhập: .\\scripts\\login.ps1 codex-1 (lặp lại codex-2/codex-3). Thêm repo và lệnh tests vào team.config.json, rồi npm start.');
