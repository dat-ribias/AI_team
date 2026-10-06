import { existsSync, mkdirSync } from 'node:fs';
import { msg } from './i18n.js';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { executable, childEnv, launch, killTree, run, resolveCommand } from './process.js';
// Quy tắc quyền của Claude dùng dạng POSIX: D:\A\B → //d/A/B, /x/y → //x/y.
export const claudePath = p => '/' + String(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase()).replace(/\/+$/, '');
const SECRET_FILES = ['.env', '.env.*', '*.pem', '*.key', '*.pfx', '*credentials*', '*secret*', 'id_rsa*'];

export function parseReport(text) {
  let report;
  try { report = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
  catch {
    // Agent đôi khi viết thêm chữ quanh JSON: lấy object JSON cuối cùng có "summary"; không có thì báo kèm đoạn đầu câu trả lời.
    for (let i = text.lastIndexOf('{'); i >= 0 && !report; i = text.lastIndexOf('{', i - 1)) {
      for (let j = text.lastIndexOf('}'); j > i; j = text.lastIndexOf('}', j - 1)) { try { const r = JSON.parse(text.slice(i, j + 1)); if (r && typeof r.summary === 'string') { report = r; break; } } catch {} }
    }
    if (!report) throw new Error('Agent response must be JSON with a summary. Got: ' + text.trim().slice(0, 300));
  }
  if (!report || typeof report !== 'object' || Array.isArray(report) || typeof report.summary !== 'string') throw new Error('Agent response must be JSON with a summary');
  return report;
}

export function normalizeCodexQuota(result) {
  const buckets = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.entries(result.rateLimitsByLimitId) : [['codex', result.rateLimits]];
  return buckets.filter(([, b]) => b).map(([id, b]) => ({
    id, name: b.limitName || id, credits: b.credits || null,
    windows: ['primary', 'secondary'].filter(k => b[k]).map(k => ({
      name: k, remaining: Number.isFinite(b[k].usedPercent) ? Math.max(0, Math.min(100, 100 - b[k].usedPercent)) : null,
      minutes: b[k].windowDurationMins ?? null, resetsAt: b[k].resetsAt == null ? null : new Date(b[k].resetsAt * 1000).toISOString(),
    })),
  }));
}

export function normalizeGoogleQuota(result) {
  // Only named, numeric provider fields count. Unknown schemas remain UNKNOWN, never a guessed percentage.
  const buckets = [];
  function visit(value, name = 'Google') {
    if (!value || typeof value !== 'object') return;
    if (Number.isFinite(value.remaining_fraction)) buckets.push({ id: name, name, windows: [{
      name: 'quota', remaining: Math.max(0, Math.min(100, value.remaining_fraction * 100)),
      minutes: null, resetsAt: value.reset_time || null,
    }] });
    else for (const [key, item] of Object.entries(value)) if (item && typeof item === 'object') visit(item, item.modelId || item.model_id || item.id || key);
  }
  visit(result);
  return buckets;
}

export async function codexClient(agent, onNotification = () => {}) {
  const child = launch(resolveCommand(agent), ['app-server', '-c', 'cli_auth_credentials_store="file"'], { env: childEnv(agent) });
  const lines = createInterface({ input: child.stdout });
  let id = 0, diagnostic = '';
  const pending = new Map();
  const rejectAll = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-4000); });
  child.stdin.on('error', rejectAll); child.on('error', rejectAll);
  child.on('close', () => { rejectAll(new Error(diagnostic || 'Codex app-server exited')); onNotification({ method: 'transport/closed' }); });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const p = pending.get(message.id);
    if (p) { clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
    else if (message.method) onNotification(message);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Codex request timed out: ${method}`)); }, 25_000);
    pending.set(n, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: n, method, params }) + '\n');
  });
  // Codex app-server luôn cần trường params: method có tham số nhận {}, method không tham số nhận null.
  const request = async (method, params) => {
    if (params !== undefined) return send(method, params);
    try { return await send(method, {}); }
    catch (error) { if (/invalid type|expected unit|unknown field/i.test(error.message)) return send(method, null); throw error; }
  };
  const close = async () => { rejectAll(new Error('Codex connection closed')); lines.close(); await killTree(child); };
  try {
    await request('initialize', { clientInfo: { name: 'ai_team_control_room', title: 'AI Team Control Room', version: '0.1.0' } });
    child.stdin.write('{"method":"initialized"}\n');
    return { request, close };
  } catch (error) { await close(); throw error; }
}

// Mỗi CODEX_HOME chỉ chạy một tiến trình Codex tại một thời điểm: SQLite state trong hồ sơ không cho mở song song
// ("failed to initialize sqlite state runtime"). Các lệnh cùng hồ sơ xếp hàng; lỗi khóa thì thử lại một lần.
const homeLocks = new Map();
export function withHome(agent, fn) {
  if (!agent.home) return fn();
  const key = (agent.lockKey || agent.home).toLowerCase(), next = (homeLocks.get(key) || Promise.resolve()).then(fn, fn);
  homeLocks.set(key, next.catch(() => {}));
  return next;
}
async function retryState(fn) {
  try { return await fn(); }
  catch (error) { if (!/sqlite|state runtime|database is locked/i.test(error.message)) throw error; await new Promise(r => setTimeout(r, 2500)); return fn(); }
}
export async function codexRpc(agent, methods) {
  if (!existsSync(join(agent.home, 'auth.json'))) throw new Error(msg("srv.providers.chua_dang_nhap_bam_dang_nhap"));
  return withHome(agent, () => retryState(async () => {
    const client = await codexClient(agent);
    try {
      const results = [];
      for (const method of methods) results.push(await client.request(method));
      return results;
    } finally { await client.close(); }
  }));
}

const unsupportedUsage = new Set();
export async function readQuota(agent) {
  if (agent.provider === 'codex') {
    const sqliteHome = join(agent.home, 'sqlite-quota'); mkdirSync(sqliteHome, { recursive: true });
    const [account, quota] = await codexRpc({ ...agent, sqliteHome, lockKey: agent.home + '#quota' }, ['account/read', 'account/rateLimits/read']);
    return { buckets: normalizeCodexQuota(quota), account: account.account || null };
  }
  if (agent.provider !== 'antigravity') throw new Error(msg("srv.providers.cli_nay_chua_co_bo_doc"));
  // agy mới hỗ trợ `-p /usage` không gọi model. Bản cũ coi đó là prompt (tốn quota) → gặp lỗi một lần thì ngừng thử tới khi restart.
  if (unsupportedUsage.has(agent.id)) throw new Error(msg("srv.providers.agy_tren_may_chua_tra_usage"));
  const output = await run(resolveCommand(agent), ['-p', '/usage', '--output-format', 'json'], { env: childEnv(agent), timeoutMs: 25_000, allowFailure: true });
  let raw;
  try { raw = JSON.parse(output.stdout); if (typeof raw?.response === 'string') try { raw.response = JSON.parse(raw.response); } catch {} }
  catch { unsupportedUsage.add(agent.id); throw new Error(msg("srv.providers.agy_khong_tra_json_cho_usage") + (output.stderr || output.stdout).slice(0, 300)); }
  if (output.code !== 0) { unsupportedUsage.add(agent.id); throw new Error(msg("srv.providers.agy_usage_loi") + (output.stderr || output.stdout).slice(0, 300)); }
  const buckets = normalizeGoogleQuota(raw);
  return { buckets, schemaUnknown: !buckets.length, raw };
}

// `claude --effort`: mức khả dụng tùy model.
const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const suggestedModels = { claude: ['opus', 'sonnet', 'haiku'], gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'], antigravity: ['gemini-2.5-pro', 'gemini-2.5-flash'] };
// Codex có RPC model/list nên lấy đúng danh sách tài khoản được dùng; CLI khác chưa có lệnh liệt kê nên chỉ gợi ý.
export async function listModels(agent) {
  if (agent.provider === 'mock') return { source: 'demo', models: [{ id: 'mock', label: 'Mock (demo)' }] };
  if (agent.provider === 'codex') {
    if (!existsSync(join(agent.home, 'auth.json'))) throw new Error(msg("srv.providers.dang_nhap_codex_truoc_de_lay"));
    const models = await withHome(agent, () => retryState(async () => {
      const client = await codexClient(agent), list = [];
      try {
        let cursor;
        do { const r = await client.request('model/list', cursor ? { cursor } : {}); list.push(...(r.data || r.models || [])); cursor = r.nextCursor; } while (cursor && list.length < 200);
      } finally { await client.close(); }
      return list;
    }));
    // Codex trả các mức reasoning effort hỗ trợ theo từng model.
    const efforts = m => (m.supportedReasoningEfforts || m.reasoningEfforts || []).map(e => typeof e === 'string' ? e : e.reasoningEffort || e.effort).filter(Boolean);
    return { source: 'cli', models: models.map(m => ({ id: m.model || m.id, label: m.displayName || m.model || m.id, isDefault: !!m.isDefault, efforts: efforts(m), defaultEffort: m.defaultReasoningEffort || null })).filter(m => m.id), efforts: ['low', 'medium', 'high'] };
  }
  if (agent.provider === 'antigravity') {
    const result = await run(resolveCommand(agent), ['models'], { env: childEnv(agent), allowFailure: true, timeoutMs: 30000 });
    const ids = [...new Set(result.stdout.split(/\r?\n/).map(l => l.trim().split(/\s+/)[0]).filter(t => /^[a-z][\w.:\/-]*\d[\w.:\/-]*$/i.test(t || '')))];
    if (result.code === 0 && ids.length) return { source: 'cli', models: ids.map(id => ({ id, label: id })) };
  }
  return { source: 'suggested', note: msg("srv.providers.cli_nay_chua_co_lenh_liet"),
    models: (suggestedModels[agent.provider] || []).map(id => ({ id, label: id })), efforts: agent.provider === 'claude' ? claudeEfforts : [] };
}

export async function runAgent(agent, task, prompt, { signal, onEvent }) {
  signal?.throwIfAborted();
  if (agent.provider === 'mock') {
    await new Promise((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, 450);
      signal?.addEventListener('abort', aborted, { once: true });
    });
    signal?.throwIfAborted();
    if (task.stage === 'plan' && /hỏi lại|ask me/i.test(task.goal) && !task.messages?.length) return { summary: 'DEMO: cần làm rõ', status: 'needs_input', questions: ['DEMO: bạn muốn áp dụng cho trang nào?'] };
    const report = task.stage === 'plan'
      ? { summary: msg("srv.providers.demo_giao_builder_cap_nhat_hello"), kind: /research|nghiên cứu/i.test(task.goal) ? 'research' : 'code', rigor: /light|nhẹ/i.test(task.goal) ? 'light' : 'standard', risk: 'low', tasks: [{ agent: task.roster?.builders[0] || 'codex-2', difficulty: /hard|khó/i.test(task.goal) ? 4 : 2, instruction: msg("srv.providers.cap_nhat_hello_txt_va_kiem") }] }
      : { summary: msg("srv.providers.demo_hoan_tat_bang_bo_mo", { 0: task.stage }), status: 'completed', verdict: 'approved', findings: [] };
    if (task.stage === 'implement') {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(task.worktree, 'hello.txt'), 'Hello from AI Team demo!\n');
    }
    onEvent('ACTIVITY', { summary: msg("srv.providers.demo_hoat_dong_mo_phong") });
    return report;
  }
  let final = '', failed = '', policyBlocked = false;
  // Tìm kiếm/đọc web: chỉ khi project bật network, hoặc việc nghiên cứu (tắt bằng "researchWeb": false).
  const web = task.network === true || task.kind === 'research' && task.researchWeb !== false;
  const args = [];
  // Lệnh check reviewer/verifier được phép chạy (= lệnh tests của project), dạng chuỗi.
  const checks = (task.checks || []).map(c => c.join(' '));
  if (agent.provider === 'codex') {
    if (!existsSync(join(agent.home, 'auth.json'))) throw new Error(msg("srv.providers.chua_dang_nhap", { 0: agent.id }));
    // "none" (Windows): bỏ sandbox của Codex → không còn cửa sổ UAC codex-windows-sandbox-setup, đổi lại Codex có toàn quyền của user
    // (đọc/ghi mọi nơi, có mạng). Chỉ còn ràng buộc bằng prompt + kiểm tra worktree của controller. Bật bằng "codexWindowsSandbox": "none".
    const winSandbox = agent.windowsSandbox || task.codexWindowsSandbox || 'unelevated', noSandbox = process.platform === 'win32' && winSandbox === 'none';
    args.push('exec', ...(task.attachments || []).filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f)).flatMap(f => ['-i', join(task.worktree, f)]), '--json', '--color', 'never', '-c', 'cli_auth_credentials_store="file"', '-c', 'approval_policy="never"', '--sandbox', noSandbox ? 'danger-full-access' : task.stage === 'implement' || checks.length ? 'workspace-write' : 'read-only', '-C', task.worktree);
    if (agent.model) args.push('--model', agent.model);
    if (agent.effort) args.push('-c', `model_reasoning_effort="${agent.effort}"`);
    // Sandbox Codex: chỉ ghi trong worktree; mạng tắt trừ khi project bật "network": true.
    args.push('-c', `sandbox_workspace_write.network_access=${task.network === true}`, '-c', `features.web_search=${web}`);
    // Windows: không bật sandbox thì Codex (approval=never) từ chối mọi lệnh, kể cả lệnh chỉ đọc. "unelevated" không cần quyền admin.
    if (process.platform === 'win32' && !['off', 'none'].includes(winSandbox)) args.push('-c', `windows.sandbox="${winSandbox}"`);
    // MCP bật riêng cho member này (TOML inline qua -c).
    const toml = v => typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(toml).join(',')}]` : `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}=${toml(x)}`).join(',')}}`;
    // Repo liên kết được cấp quyền sửa: thêm làm thư mục ghi được của sandbox.
    for (const d of task.addDirs || []) args.push('--add-dir', d);
    for (const [name, s] of Object.entries(agent.mcp || {})) args.push('-c', `mcp_servers.${name}=${toml({ command: s.command, args: s.args || [], ...(s.env ? { env: s.env } : {}) })}`);
    args.push('-');
  } else if (agent.provider === 'claude') {
    args.push('-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', task.stage === 'implement' ? 'acceptEdits' : 'default');
    if (task.stage !== 'implement') args.push('--tools', `Read,Glob,Grep,Bash${web ? ',WebSearch,WebFetch' : ''}`, '--allowedTools', `Read,Glob,Grep,Bash(git diff *),Bash(git show *),Bash(git status *),Bash(git log *),Bash(git grep *)${checks.map(c => `,Bash(${c}),Bash(${c} *)`).join('')}${web ? ',WebSearch,WebFetch' : ''}`);
    if (agent.model) args.push('--model', agent.model);
    if (agent.effort) args.push('--effort', agent.effort);
    for (const d of task.addDirs || []) args.push('--add-dir', d); // repo liên kết được cấp quyền sửa (acceptEdits áp dụng cả ở đây)
    // MCP bật riêng cho member này; tên công cụ dạng mcp__<server> được cho phép không cần hỏi.
    if (agent.mcp && Object.keys(agent.mcp).length) args.push('--mcp-config', JSON.stringify({ mcpServers: agent.mcp }), '--strict-mcp-config', '--allowedTools', ...Object.keys(agent.mcp).map(n => `mcp__${n}`));
    if (!web) args.push('--disallowedTools', 'WebFetch,WebSearch');
    // Thư mục tham khảo: chỉ cho Read/Glob/Grep (không dùng --add-dir vì nó cho cả quyền sửa); cấm sửa và cấm đọc file bí mật.
    const refs = (task.readDirs || []).map(claudePath);
    if (refs.length) args.push('--allowedTools', ...refs.map(d => `Read(${d}/**)`), '--disallowedTools', ...refs.flatMap(d => [`Edit(${d}/**)`, `Write(${d}/**)`, ...SECRET_FILES.map(f => `Read(${d}/**/${f})`)]));
  } else {
    args.push('-p', task.promptFile ? `Read the file ${task.promptFile} in the current directory and follow its instructions exactly. Your final answer must be only the JSON it asks for.` : prompt, '--output-format', 'stream-json');
    if (agent.model) args.push('--model', agent.model);
    if (agent.provider === 'gemini' && task.addDirs?.length) args.push('--include-directories', task.addDirs.join(','));
    if (agent.provider === 'gemini') args.push('--approval-mode', task.stage === 'implement' ? 'auto_edit' : checks.length ? 'default' : 'plan', ...(checks.length ? ['--allowed-tools', ...checks.map(c => `run_shell_command(${c})`)] : []));
    // Antigravity (agy) không có cờ quyền theo lượt: lệnh check phải được cho phép trong ~/.gemini/antigravity-cli/settings.json (permissions.allow).
  }
  // Slot ≥ 2 của cùng tài khoản Codex: SQLite riêng (CODEX_SQLITE_HOME), giữ chung đăng nhập. sqlite_home trong config.toml sẽ ghi đè biến này.
  const slot = task.slot > 1 && agent.provider === 'codex' ? task.slot : 1, slotAgent = slot > 1 ? { ...agent, sqliteHome: join(agent.home, `sqlite-${slot}`), lockKey: `${agent.home}#${slot}` } : agent;
  if (slot > 1) mkdirSync(slotAgent.sqliteHome, { recursive: true });
  const env = childEnv(slotAgent);
  const exec = () => run(resolveCommand(agent), args, {
    cwd: task.worktree, env, onSpawn: pid => onEvent('SPAWN', { summary: `PID ${pid} · slot ${slot}`, details: { pid, slot, cwd: task.worktree, sqliteHome: env.CODEX_SQLITE_HOME || agent.home || null } }), input: ['codex', 'claude'].includes(agent.provider) ? prompt : '', signal,
    onLine(line, stream) {
      if (!line) return;
      if (stream === 'stderr') { if (/blocked by policy|CreateRestrictedToken|sandbox setup/i.test(line)) policyBlocked = true; onEvent('DIAGNOSTIC', { summary: line.slice(0, 4000) }); return; }
      let event; try { event = JSON.parse(line); } catch { onEvent('DIAGNOSTIC', { summary: line.slice(0, 4000) }); return; }
      // Deliberately expose actions and messages, not reasoning items.
      const item = event.item;
      if (event.type === 'item.completed' && item?.type === 'agent_message') final = item.text;
      if (item && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item.type) || event.type === 'item.completed' && item?.type === 'agent_message') onEvent('ACTIVITY', { summary: item.command || (item.text ? item.text.slice(0, 200) : item.type), details: item });
      if (event.type === 'turn.completed') onEvent('USAGE', { summary: 'Token usage', details: event.usage });
      if (['error', 'turn.failed'].includes(event.type)) failed = event.message || event.error?.message || event.type;
      if (event.type === 'message' && event.role === 'assistant') final += event.content || '';
      if (event.type === 'tool_use' || event.type === 'tool_result') onEvent('ACTIVITY', { summary: event.tool_name || event.type, details: event });
      if (event.event === 'step_update' && event.step_update?.step_type === 'tool') onEvent('ACTIVITY', { summary: event.step_update.tool_name || 'tool', details: event.step_update.tool_info });
      if (event.event === 'result') {
        final = event.result?.response || '';
        if (event.result?.status !== 'SUCCESS') failed = event.result?.error || 'Antigravity did not succeed';
        onEvent('USAGE', { summary: 'Token usage', details: event.result?.usage });
      }
      if (event.type === 'result' && event.status === 'error') failed = event.error?.message || 'Gemini did not succeed';
      if (agent.provider === 'claude' && event.type === 'assistant') {
        for (const block of event.message?.content || []) if (block.type === 'tool_use') onEvent('ACTIVITY', { summary: block.name, details: { name: block.name, input: block.input } });
      }
      if (agent.provider === 'claude' && event.type === 'user') {
        for (const block of event.message?.content || []) if (block.type === 'tool_result') { const out = Array.isArray(block.content) ? block.content.map(c => c.text || '').join('\n') : String(block.content ?? ''); onEvent('ACTIVITY', { summary: 'tool_result', details: { type: 'tool_result', output: out.slice(-8000), is_error: !!block.is_error } }); }
      }
      if (agent.provider === 'claude' && event.type === 'rate_limit_event') onEvent('RATE_LIMIT', { summary: `Quota: ${event.rate_limit_info?.status || ''} ${event.rate_limit_info?.rateLimitType || ''}`.trim(), details: event.rate_limit_info });
      if (agent.provider === 'claude' && event.type === 'result') {
        final = event.result || '';
        if (event.is_error || event.subtype !== 'success') failed = event.errors?.join('; ') || event.subtype;
        onEvent('USAGE', { summary: 'Token usage', details: event.usage });
      }
    },
  });
  await (agent.provider === 'codex' ? withHome(slotAgent, exec) : exec());
  const hint = policyBlocked ? '\n' + msg("srv.providers.codex_sandbox_hint") : '';
  if (failed) throw new Error(failed + hint);
  if (!final) throw new Error(msg("srv.providers.cli_khong_tra_ket_qua_cuoi") + hint);
  const report = parseReport(final);
  if (report.status === 'blocked' && hint) report.summary += hint;
  return report;
}
