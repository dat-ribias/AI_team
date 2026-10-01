import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { msg } from './i18n.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { executable, commandAvailable, childEnv, run, killTree, resolveCommand, commandFromPath } from './process.js';
import { codexClient, codexRpc, listModels } from './providers.js';
import { roster, validateConfig, redact, tiers } from './team.js';

export const providerInfo = {
  codex: { label: 'Codex', cli: 'codex', installUrl: 'https://learn.chatgpt.com/docs/cli' },
  antigravity: { label: 'Gemini · Google AI Pro / Ultra', cli: 'agy', installUrl: 'https://antigravity.google/docs/cli/install' },
  gemini: { label: 'Gemini · Code Assist', cli: 'gemini', installUrl: 'https://geminicli.com/docs/get-started/installation/' },
  claude: { label: 'Claude Code', cli: 'claude', installUrl: 'https://code.claude.com/docs/en/setup' },
};
export const roleLabels = { manager: 'Manager', builder: 'Builder', reviewer: 'Reviewer', verifier: 'Verifier', none: msg("srv.accounts.du_bi") };
// Một member có thể giữ nhiều vai trò (kể cả một mình làm hết). Bật vai trò đơn (manager/reviewer/verifier) sẽ thay người đang giữ.
const ROLE_KEYS = ['manager', 'builder', 'reviewer', 'verifier'];
function assign(config, id, kind, on = true) {
  const p = config.pipeline = roster(config), member = config.agents.find(a => a.id === id);
  if (kind === 'none') { p.builders = p.builders.filter(b => b !== id); for (const k of ['manager', 'reviewer', 'verifier']) if (p[k] === id) p[k] = null; }
  else if (kind === 'builder') {
    p.builders = p.builders.filter(b => b !== id);
    if (on) { if (member.provider === 'antigravity') throw new Error(msg("srv.accounts.gemini_antigravity_o_che_do_headless")); p.builders.push(id); }
  } else if (on) p[kind] = id;
  else if (p[kind] === id) p[kind] = null;
  for (const a of config.agents) {
    const kinds = ROLE_KEYS.filter(k => k === 'builder' ? p.builders.includes(a.id) : p[k] === a.id);
    Object.assign(a, { kind: kinds[0] || 'none', role: kinds.length ? kinds.map(k => roleLabels[k]).join(' / ') : roleLabels.none });
  }
}

export function safeAuthUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname) || url.username || url.password) throw new Error(msg("srv.accounts.cli_tra_url_dang_nhap_khong"));
  return url.href;
}

export class Accounts {
  constructor(team, configFile, root, adapters = {}) {
    this.team = team; this.file = configFile; this.root = root;
    this.states = new Map(); this.sessions = new Map(); this.loginBusy = null;
    this.client = adapters.codexClient || codexClient;
    this.startTerminal = adapters.startTerminal || ((agent, resultFile, mode = 'login') => {
      if (process.platform !== 'win32') throw new Error(msg("srv.accounts.dang_nhap_cli_tuong_tac_hien"));
      // detached trên Windows = không có console nên cửa sổ không hiện; dùng Start-Process để mở cửa sổ PowerShell thật.
      const q = value => `'${String(value).replace(/'/g, "''")}'`, arg = value => q(`"${value}"`);
      const script = `Start-Process -FilePath powershell.exe -WorkingDirectory ${q(root)} -ArgumentList @('-NoProfile','-ExecutionPolicy','RemoteSigned','-File',${arg(join(root, 'scripts', 'member-login.ps1'))},'-ConfigFile',${arg(configFile)},'-Member',${q(agent.id)},'-ResultFile',${arg(resultFile)},'-Mode',${q(mode)})`;
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        env: process.env, stdio: 'ignore', windowsHide: true, shell: false,
      });
      return child;
    });
    this.available = adapters.commandAvailable || commandAvailable;
    this.interval = setInterval(() => this.pollTerminals(), 2000);
  }
  providers() { return Object.entries(providerInfo).map(([id, info]) => ({ id, ...info, installed: this.available(executable(info.cli)) })); }
  command(agent) { return resolveCommand(agent); }
  snapshot(agent) {
    if (agent.provider === 'mock') return { status: 'demo', message: msg("srv.accounts.thanh_vien_mo_phong_mo_doi") };
    const command = this.command(agent), installed = this.available(command);
    return { ...(this.states.get(agent.id) || { status: 'unknown', message: msg("srv.accounts.chua_kiem_tra_dang_nhap") }), installed,
      installUrl: providerInfo[agent.provider].installUrl, sharedProfile: agent.provider === 'antigravity', cli: installed ? command.at(-1) : null };
  }
  set(id, state) { this.states.set(id, state); this.team.emit('change'); return state; }
  persist(config) {
    validateConfig(config);
    const temp = this.file + '.tmp'; writeFileSync(temp, JSON.stringify(config, null, 2)); renameSync(temp, this.file);
    this.team.config = config; this.team.emit('change');
  }
  add(input) {
    if (this.team.config.demo) throw new Error(msg("srv.accounts.them_tai_khoan_that_o_http"));
    const { provider, label, kind = 'builder' } = input;
    if (!providerInfo[provider]) throw new Error(msg("srv.accounts.chon_codex_gemini_hoac_claude"));
    if (!roleLabels[kind]) throw new Error(msg("srv.accounts.vai_tro_khong_hop_le"));
    if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new Error(msg("srv.accounts.ten_thanh_vien_can_1_80"));
    const id = `${provider}-${randomUUID().slice(0, 8)}`;
    const agent = { id, label: label.trim(), kind: 'none', role: roleLabels.none, provider, enabled: true };
    if (provider !== 'antigravity') agent.home = join(homedir(), '.ai-team', 'accounts', id);
    const config = structuredClone(this.team.config); config.agents.push(agent); assign(config, id, kind, true);
    this.persist(config);
    return { ...agent, auth: this.snapshot(agent) };
  }
  role(id, kind, on = true) {
    if (this.team.config.demo) throw new Error(msg("srv.accounts.doi_vai_tro_that_o_doi"));
    if (!roleLabels[kind]) throw new Error(msg("srv.accounts.vai_tro_khong_hop_le"));
    const config = structuredClone(this.team.config), member = config.agents.find(a => a.id === id);
    if (!member) throw new Error(msg("srv.accounts.thanh_vien_khong_ton_tai"));
    assign(config, id, kind, on !== false); this.persist(config); this.team.syncRoster();
    return this.snapshot(member);
  }
  profile(id, input = {}) {
    if (this.team.config.demo) throw new Error(msg("srv.accounts.sua_ho_so_o_doi_live"));
    const config = structuredClone(this.team.config), member = config.agents.find(a => a.id === id);
    if (!member) throw new Error(msg("srv.accounts.thanh_vien_khong_ton_tai"));
    if ('label' in input) { if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80) throw new Error(msg("srv.accounts.ten_thanh_vien_can_1_80")); member.label = input.label.trim(); }
    if ('model' in input) {
      const model = String(input.model ?? '').trim();
      if (model && !/^[\w.:/\[\]-]{1,100}$/.test(model)) throw new Error(msg("srv.accounts.ten_model_khong_hop_le"));
      if (model) member.model = model; else delete member.model;
    }
    if ('cliPath' in input) {
      const path = String(input.cliPath ?? '').trim().replace(/^"|"$/g, '');
      if (!path) delete member.command;
      else { const command = commandFromPath(path); if (!command) throw new Error(msg("srv.accounts.duong_dan_cli_khong_ton_tai")); member.command = command; }
    }
    if ('effort' in input) {
      const effort = String(input.effort ?? '').trim();
      if (effort && !/^[a-z]{2,12}$/.test(effort)) throw new Error('effort');
      if (effort && !['codex', 'claude'].includes(member.provider)) throw new Error('effort: Codex / Claude');
      if (effort) member.effort = effort; else delete member.effort;
    }
    if ('tier' in input) { if (!tiers[input.tier]) throw new Error(msg("srv.accounts.nang_luc_phai_la_strong_normal")); member.tier = input.tier; }
    if ('enabled' in input) member.enabled = input.enabled === true;
    if ('systemPrompt' in input) {
      if (typeof input.systemPrompt !== 'string' || input.systemPrompt.length > 8000) throw new Error(msg("srv.accounts.system_prompt_toi_da_8_000"));
      if (input.systemPrompt.trim()) member.systemPrompt = input.systemPrompt.trim(); else delete member.systemPrompt;
    }
    this.persist(config);
    return member;
  }
  // Đăng ký dự án từ giao diện. Thư mục chưa có git thì có thể khởi tạo kèm một commit rỗng.
  async addProject(input = {}) {
    if (this.team.config.demo) throw new Error(msg("srv.accounts.sua_ho_so_o_doi_live"));
    const path = String(input.path ?? '').trim().replace(/^"|"$/g, '');
    if (!path || !existsSync(path)) throw new Error(msg("srv.team.duong_dan_repo_khong_ton_tai"));
    const id = String(input.id || path.split(/[\\/]/).filter(Boolean).pop() || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!id) throw new Error(msg("srv.accounts.project_id"));
    if (this.team.config.projects.some(p => p.id === id)) throw new Error(msg("srv.team.project_id_bi_trung"));
    const top = await run(['git'], ['-C', path, 'rev-parse', '--show-toplevel'], { allowFailure: true });
    if (top.code !== 0) {
      if (!input.init) throw new Error(msg("srv.accounts.not_git"));
      await run(['git'], ['init', '-b', 'main', path]);
    }
    if ((await run(['git'], ['-C', path, 'rev-parse', '--verify', 'HEAD'], { allowFailure: true })).code !== 0) {
      if (!input.init) throw new Error(msg("srv.accounts.no_commit"));
      await run(['git'], ['-C', path, '-c', 'user.name=AI Team', '-c', 'user.email=ai-team@localhost', 'commit', '--allow-empty', '-m', 'AI Team: initial commit']);
    }
    const tests = String(input.tests ?? '').split(/\r?\n/).map(l => (l.match(/"[^"]*"|\S+/g) || []).map(w => w.replace(/^"|"$/g, ''))).filter(a => a.length);
    const config = structuredClone(this.team.config);
    config.projects.push({ id, path, tests, ...(input.network ? { network: true } : {}) });
    this.persist(config);
    return { id };
  }
  removeProject(id) {
    if (this.team.jobs().some(j => j.project === id && !['merged', 'cancelled', 'done'].includes(j.status))) throw new Error(msg("srv.accounts.project_busy"));
    const config = structuredClone(this.team.config); config.projects = config.projects.filter(p => p.id !== id); this.persist(config);
    return { removed: id };
  }
  // Hộp chọn thư mục của Windows (server chạy trên chính máy này).
  async pickFolder() {
    if (process.platform !== 'win32') throw new Error(msg("srv.accounts.dang_nhap_cli_tuong_tac_hien"));
    const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.ShowNewFolderButton = $true; if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }";
    const r = await run(['powershell.exe'], ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { allowFailure: true, timeoutMs: 10 * 60_000 });
    return { path: r.stdout.trim() || null };
  }
  async models(id) { return listModels(this.team.agent(id)); }
  // Nút "Kiểm tra quota": gửi /usage như gõ tay rồi đọc phần trăm. Có thể tốn một lượt nhỏ nếu CLI coi đó là prompt.
  async usage(id) {
    const agent = this.team.agent(id);
    if (agent.provider !== 'claude') throw new Error(msg("srv.accounts.chi_dung_cho_thanh_vien_claude"));
    if (this.team.active?.agent === id) throw new Error(msg("srv.accounts.thanh_vien_dang_chay_viec_thu"));
    const result = await run(this.command(agent), ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--no-session-persistence'],
      { env: childEnv(agent), cwd: agent.home, input: '/usage', allowFailure: true, timeoutMs: 120_000 });
    let resultText = '', assistantText = '';
    for (const line of result.stdout.split(/\r?\n/)) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'rate_limit_event') this.team.observeQuota(id, event.rate_limit_info);
      const collectInto = (target, value) => {
        if (typeof value === 'string') return target + value + '\n';
        if (value && typeof value === 'object') {
          for (const v of Object.values(value)) target = collectInto(target, v);
        }
        return target;
      };
      if (event.type === 'result') resultText = collectInto(resultText, event.result);
      else if (event.type === 'assistant') assistantText = collectInto(assistantText, event.message ?? event);
    }
    let text = (resultText.trim() || assistantText.trim() || result.stdout).replace(/\x1b\[[0-9;]*m/g, '');
    const buckets = [];
    const seen = new Set();
    // Đọc theo dòng: dòng nhãn ("Current session") → dòng "N% used" → dòng "Resets …".
    let label = null, last = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/[│|█▌▏▎▍▋▊▉░▒▓]/gu, ' ').trim();
      const used = /(\d{1,3}(?:\.\d+)?)\s*%\s*used/i.exec(line), reset = /^Resets?\s+(.+)/i.exec(line);
      if (used) {
        const rawName = (line.slice(0, used.index).trim() || label || 'Claude').replace(/[:\s]+$/, '').trim();
        const idKey = 'usage:' + rawName.toLowerCase();
        if (!seen.has(idKey)) {
          seen.add(idKey);
          const isSession = /session/i.test(rawName);
          const remainingVal = Math.max(0, Math.min(100, 100 - Number(used[1])));
          last = {
            id: idKey,
            name: rawName,
            windows: [{
              name: isSession ? '5h' : 'week',
              remaining: remainingVal,
              minutes: isSession ? 300 : (/week/i.test(rawName) ? 10080 : null),
              resetsAt: null,
              resetText: null
            }]
          };
          buckets.push(last);
        } else {
          last = buckets.find(b => b.id === idKey);
        }
        label = null;
      } else if (reset && last) last.windows[0].resetText = reset[1].slice(0, 80);
      else if (/[A-Za-z]/.test(line) && line.length < 80) label = line;
    }
    if (buckets.length) this.team.saveObserved(id, buckets);
    const quota = this.team.quota(id);
    return { parsed: buckets.length > 0 || !!quota.observed, buckets, text: redact(text || result.stderr || result.stdout).trim().slice(0, 3000) };
  }
  openTerminal(id) {
    const agent = this.team.agent(id); this.assertLoginAllowed(agent);
    const resultFile = join(this.team.dataDir, 'login', randomUUID() + '.json');
    mkdirSync(join(this.team.dataDir, 'login'), { recursive: true });
    this.startTerminal(agent, resultFile, 'shell');
    return { opened: true };
  }
  prepare(agent) {
    if (!agent.home) return;
    mkdirSync(agent.home, { recursive: true, mode: 0o700 });
    if (agent.provider === 'codex' && !existsSync(join(agent.home, 'config.toml'))) writeFileSync(join(agent.home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  }
  assertLoginAllowed(agent) {
    if (agent.provider === 'mock') throw new Error(msg("srv.accounts.day_la_member_mo_phong_mo"));
    if (!this.available(this.command(agent))) throw new Error(msg("srv.accounts.khong_tim_thay_cli_neu_da", { 0: providerInfo[agent.provider].cli }));
    if (this.team.active || this.team.refreshing) throw new Error(msg("srv.accounts.doi_dang_lam_viec_doc_quota"));
    if (this.loginBusy) throw new Error(msg("srv.accounts.co_mot_phien_dang_nhap_dang"));
  }
  async login(id) {
    const agent = this.team.agent(id); this.assertLoginAllowed(agent);
    this.loginBusy = id; this.team.accountLoginBusy = true;
    const session = { id: randomUUID(), status: 'starting', agent: id, provider: agent.provider };
    this.sessions.set(id, session); this.set(id, { status: 'starting', message: msg("srv.accounts.dang_chuan_bi_dang_nhap") });
    try {
      this.prepare(agent);
      if (agent.provider === 'codex') {
        session.client = await this.client(agent, event => {
          if (event.method === 'account/login/completed') this.completeCodex(id, session, event.params).catch(e => this.fail(id, session, e));
          if (event.method === 'transport/closed' && ['starting', 'pending'].includes(session.status)) this.fail(id, session, new Error(msg("srv.accounts.cli_da_dong_phien_dang_nhap")));
        });
        const result = await session.client.request('account/login/start', { type: 'chatgpt' });
        if (session.status !== 'starting') return this.snapshot(agent);
        session.loginId = result.loginId; session.status = 'pending';
        session.timer = setTimeout(() => this.cancel(id, msg("srv.accounts.phien_dang_nhap_da_het_han")).catch(() => {}), 10 * 60_000);
        return this.set(id, { status: 'pending', message: msg("srv.accounts.mo_trang_dang_nhap_va_chon"), authUrl: safeAuthUrl(result.authUrl) });
      }
      session.resultFile = join(this.team.dataDir, 'login', session.id + '.json');
      mkdirSync(join(this.team.dataDir, 'login'), { recursive: true });
      session.child = this.startTerminal(agent, session.resultFile);
      session.child.on?.('error', error => this.fail(id, session, error));
      session.status = 'terminal';
      return this.set(id, { status: 'terminal', message: msg("srv.accounts.da_mo_cua_so_dang_nhap") });
    } catch (error) { await this.fail(id, session, error); throw error; }
  }
  release(id, session) {
    clearTimeout(session.timer);
    if (this.loginBusy === id) { this.loginBusy = null; this.team.accountLoginBusy = false; this.team.kick(); }
  }
  async fail(id, session, error) {
    if (this.sessions.get(id) !== session || ['failed', 'cancelled', 'connected'].includes(session.status)) return;
    session.status = 'failed'; this.release(id, session);
    this.set(id, { status: 'error', message: redact(error.message).slice(0, 2000) });
    if (session.client) await session.client.close().catch(() => {});
  }
  async completeCodex(id, session, result) {
    if (this.sessions.get(id) !== session || !['starting', 'pending'].includes(session.status)) return;
    if (!result?.success) return this.fail(id, session, new Error(result?.error || msg("srv.accounts.dang_nhap_khong_thanh_cong")));
    session.status = 'checking';
    const account = (await session.client.request('account/read', { refreshToken: false })).account;
    if (session.status === 'cancelled') return;
    if (!account) throw new Error(msg("srv.accounts.cli_chua_xac_nhan_tai_khoan"));
    session.status = 'connected'; this.release(id, session);
    this.set(id, { status: 'connected', message: msg("srv.accounts.da_dang_nhap"), account });
    await session.client.close();
    this.team.refreshQuota().catch(() => {});
  }
  async cancel(id, message = msg("srv.accounts.da_huy_dang_nhap")) {
    const session = this.sessions.get(id);
    if (!session || !['starting', 'pending', 'terminal', 'checking'].includes(session.status)) return this.snapshot(this.team.agent(id));
    session.status = 'cancelled';
    try {
      if (session.client && session.loginId) await session.client.request('account/login/cancel', { loginId: session.loginId });
    } finally {
      if (session.client) await session.client.close().catch(() => {});
      if (session.child) await killTree(session.child).catch(() => {});
      this.release(id, session); this.set(id, { status: 'cancelled', message });
    }
    return this.snapshot(this.team.agent(id));
  }
  async refresh(id) {
    const agent = this.team.agent(id), active = this.sessions.get(id);
    if (agent.provider === 'mock' || this.team.active?.agent === id) return this.snapshot(agent);
    if (!this.available(this.command(agent))) return this.set(id, { status: 'missing_cli', message: msg("srv.accounts.khong_tim_thay_cli_neu_da_2", { 0: providerInfo[agent.provider].cli }) });
    if (active && ['starting', 'pending', 'checking'].includes(active.status)) return this.snapshot(agent);
    let state;
    try {
      if (agent.provider === 'codex') {
        if (!existsSync(join(agent.home, 'auth.json'))) state = { status: 'signed_out', message: msg("srv.accounts.chua_dang_nhap") };
        else {
          const [account] = await codexRpc(agent, ['account/read']);
          state = account.account ? { status: 'connected', message: msg("srv.accounts.da_dang_nhap"), account: account.account } : { status: 'signed_out', message: msg("srv.accounts.chua_dang_nhap") };
        }
      } else if (agent.provider === 'claude') {
        // `claude auth status`: JSON, exit 0 nếu đã đăng nhập, 1 nếu chưa.
        const result = await run(this.command(agent), ['auth', 'status'], { env: childEnv(agent), allowFailure: true, timeoutMs: 20000 });
        let account = {}; try { account = JSON.parse(result.stdout); } catch {}
        state = result.code === 0 ? { status: 'connected', message: msg("srv.accounts.da_dang_nhap"), account: { email: account.email || account.account?.email || null, type: account.authMethod || account.subscriptionType || 'claude' } }
          : { status: 'signed_out', message: msg("srv.accounts.chua_dang_nhap_ho_so", { 0: agent.home, 1: redact(result.stderr || result.stdout).trim().slice(0, 300) }) };
      } else if (agent.provider === 'gemini') {
        const cache = join(agent.home, '.gemini', 'oauth_creds.json');
        state = existsSync(cache) ? { status: 'cached', message: msg("srv.accounts.da_luu_phien_google_quota_hieu") } : { status: 'signed_out', message: msg("srv.accounts.chua_dang_nhap") };
      } else {
        // `agy models` cần phiên đã đăng nhập và không gọi model, nên dùng để kiểm tra kết nối.
        const result = await run(this.command(agent), ['models'], { env: childEnv(agent), allowFailure: true, timeoutMs: 30000 });
        state = result.code === 0 ? { status: 'connected', message: msg("srv.accounts.da_dang_nhap_google_phien_antigravity") }
          : { status: 'signed_out', message: msg("srv.accounts.chua_dang_nhap_2") + redact(result.stderr || result.stdout).trim().slice(0, 300) };
      }
      if (active?.status === 'terminal' && ['connected', 'cached'].includes(state.status)) { active.status = 'connected'; this.release(id, active); }
      return this.set(id, state);
    } catch (error) { return this.set(id, { status: 'error', message: redact(error.message).slice(0, 2000) }); }
  }
  pollTerminals() {
    for (const [id, session] of this.sessions) if (session.status === 'terminal' && existsSync(session.resultFile)) {
      try {
        const result = JSON.parse(readFileSync(session.resultFile, 'utf8'));
        session.status = 'checking'; this.release(id, session);
        if (result.code !== 0) { session.status = 'failed'; this.set(id, { status: 'error', message: result.message || msg("srv.accounts.cli_ket_thuc_voi_ma", { 0: result.code }) }); }
        else { session.status = 'finished'; this.refresh(id).catch(() => {}); }
      } catch (e) { this.fail(id, session, e).catch(() => {}); }
    }
  }
  async close() {
    clearInterval(this.interval);
    for (const [id, session] of this.sessions) if (['starting', 'pending', 'terminal', 'checking'].includes(session.status)) await this.cancel(id);
  }
}
