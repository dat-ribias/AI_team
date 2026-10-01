import { readFileSync, writeFileSync } from 'node:fs';
import { msg, setLanguage } from './i18n.js';
import { spawn } from 'node:child_process';
import { childEnv, resolveCommand, commandAvailable } from './process.js';

const [configFile, id, resultFile, mode = 'login'] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
setLanguage(config.language || 'vi');
const agent = config.agents.find(a => a.id === id);
if (!agent || !['claude', 'gemini', 'antigravity'].includes(agent.provider)) throw new Error(msg("srv.login-terminal.member_khong_ho_tro_dang_nhap"));
console.log(mode === 'shell' ? msg("srv.login-terminal.ai_team_go_usage_de_xem", { 0: agent.label }) : `AI Team · ${agent.label}\nComplete sign-in in the official CLI below. For Gemini, select Sign in with Google; use /quit after signing in.\n`);
const resolved = resolveCommand(agent);
if (!commandAvailable(resolved)) { console.error(msg("srv.login-terminal.khong_tim_thay_cli_cho_cai", { 0: agent.provider })); writeFileSync(resultFile, JSON.stringify({ code: -1, message: msg("srv.login-terminal.khong_tim_thay_cli") })); process.exit(1); }
const [command, ...prefix] = resolved;
const child = spawn(command, [...prefix, ...(agent.provider === 'claude' && mode === 'login' ? ['auth', 'login'] : [])], {
  env: childEnv(agent), cwd: agent.home || process.cwd(), stdio: 'inherit', shell: false, windowsHide: false,
});
child.on('error', error => { writeFileSync(resultFile, JSON.stringify({ code: -1, message: error.message })); process.exitCode = 1; });
child.on('exit', code => { writeFileSync(resultFile, JSON.stringify({ code, message: code === 0 ? msg("srv.login-terminal.cli_da_thoat_dashboard_se_kiem") : msg("srv.login-terminal.dang_nhap_cli_chua_hoan_tat") })); process.exitCode = code || 0; });
