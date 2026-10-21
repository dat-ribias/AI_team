// Điều khiển ChatGPT web trong Chrome/Edge có sẵn trên máy qua CDP: mỗi tài khoản một profile trình duyệt riêng,
// đăng nhập thủ công một lần, sau đó hỏi/đáp chạy ở cửa sổ đặt ngoài màn hình.
// Selector và cách nhận biết "trả lời xong" (nút Stop biến mất + nút Copy của lượt trả lời xuất hiện + nội dung đứng yên)
// tham khảo từ miuuyy/codex-chatgpt-web (MIT): src/chatgpt-session.ts, src/adapters/chatgpt-web/browser-worker.ts. Xem NOTICE.md.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { findChrome, previewEnv, stopTree } from './preview.js';

export const CHATGPT_URL = 'https://chatgpt.com/';
const SEL = {
  composer: '[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"], form [data-composer-markdown][contenteditable="true"][role="textbox"]',
  send: '[data-testid="send-button"], form button[type="submit"]',
  stop: '[data-testid="stop-button"]',
  assistant: '[data-message-author-role="assistant"], [data-turn="assistant"], [data-turn-key]:has([data-conversation-role="assistant"])',
  answer: '.markdown, [data-markdown-text-style="assistant-message"]',
  copy: 'button[data-testid="copy-turn-action-button"], .turn-action-controls button',
};

// Đọc trạng thái trang trong một lần evaluate: không phụ thuộc chữ hiển thị trừ các thông báo lỗi đã biết.
const PROBE = `(() => {
  const S = ${JSON.stringify(SEL)}, vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const turns = [...document.querySelectorAll(S.assistant)].filter(e => !e.parentElement?.closest(S.assistant));
  const last = turns.at(-1), roots = last ? [...last.querySelectorAll(S.answer)] : [];
  const body = document.body?.innerText || '', dialogs = [...document.querySelectorAll('[role="dialog"], [role="alert"]')].map(e => e.innerText).join('\\n');
  return {
    url: location.href, title: document.title,
    composer: [...document.querySelectorAll(S.composer)].some(vis),
    stop: [...document.querySelectorAll(S.stop)].some(vis),
    turns: turns.length,
    done: !!last && [...last.querySelectorAll(S.copy)].length > 0,
    text: roots.length ? roots.at(-1).innerText.trim() : '',
    captcha: /just a moment|verify (that )?you are human/i.test(document.title + ' ' + body.slice(0, 2000)) || !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
    login: /\\/(auth|login)\\b/.test(location.pathname) || !!document.querySelector('[data-testid="login-button"]'),
    rateLimit: /too many requests|making requests too quickly/i.test(dialogs),
    expired: /session has expired/i.test(dialogs),
  };
})()`;

const browsers = new Map(); // profileDir -> { child, port, visible }

export function profileDirOf(dataDir, account) { return join(dataDir, 'chatgpt-profiles', String(account).replace(/[^\w.-]+/g, '-')); }

async function launch(profileDir, { visible = false, headless = false, chrome = findChrome(), url = 'about:blank' } = {}) {
  if (!chrome) throw new Error('ChatGPT web: browser missing (cần Chrome hoặc Edge, hoặc đặt CHROME_PATH)');
  mkdirSync(profileDir, { recursive: true });
  const active = join(profileDir, 'DevToolsActivePort'); rmSync(active, { force: true });
  const args = [`--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), // Linux chạy bằng root (container) không bật được sandbox của Chrome
    ...(headless ? ['--headless=new'] : visible ? ['--window-size=1200,900'] : ['--window-position=-32000,-32000', '--window-size=1280,900']), url];
  const child = spawn(chrome, args, { env: previewEnv(0), windowsHide: !visible, detached: process.platform !== 'win32', stdio: 'ignore' });
  child.on('error', error => { child.launchError = error; });
  const until = Date.now() + 30_000;
  while (!existsSync(active)) {
    if (child.launchError || child.exitCode !== null) throw new Error(`ChatGPT web: browser missing (${child.launchError?.message || 'exited ' + child.exitCode}); hãy đóng cửa sổ trình duyệt đang dùng profile này rồi thử lại`);
    if (Date.now() > until) { await stopTree(child.pid).catch(() => {}); throw new Error('ChatGPT web: browser start timeout'); }
    await delay(100);
  }
  const port = Number(readFileSync(active, 'utf8').split('\n')[0]);
  const entry = { child, port, visible };
  browsers.set(profileDir, entry);
  child.once('exit', () => { if (browsers.get(profileDir) === entry) browsers.delete(profileDir); });
  return entry;
}

async function ensureBrowser(profileDir, opts) {
  const current = browsers.get(profileDir);
  if (current && current.child.exitCode === null) return current;
  return launch(profileDir, opts);
}

export async function closeBrowser(profileDir) {
  const current = browsers.get(profileDir); if (!current) return;
  browsers.delete(profileDir); await stopTree(current.child.pid).catch(() => {});
}
export async function closeAll() { await Promise.all([...browsers.keys()].map(closeBrowser)); }

// Mở cửa sổ hiện để chủ dự án tự đăng nhập; cửa sổ đang chạy ẩn của profile này được đóng trước (một profile chỉ một Chrome).
export async function openLogin({ profileDir, chrome, baseUrl = CHATGPT_URL }) {
  const current = browsers.get(profileDir);
  if (current && !current.visible) await closeBrowser(profileDir);
  if (browsers.get(profileDir)) return { opened: false };
  await launch(profileDir, { visible: true, chrome, url: baseUrl });
  return { opened: true };
}

async function connect(port) {
  const endpoint = `http://127.0.0.1:${port}/json/new?about:blank`;
  let res = await fetch(endpoint, { method: 'PUT', signal: AbortSignal.timeout(5000) });
  if (!res.ok) res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('ChatGPT web: browser tab unavailable');
  const target = await res.json(), socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map();
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('ChatGPT web: CDP connection failed')), { once: true }); });
  let seq = 0;
  socket.addEventListener('message', event => { const data = JSON.parse(event.data), p = pending.get(data.id); if (!p) return; pending.delete(data.id); data.error ? p.reject(new Error(data.error.message)) : p.resolve(data.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('ChatGPT web: page script failed'); return r.result.value; };
  const close = async () => { socket.close(); await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`, { signal: AbortSignal.timeout(3000) }).catch(() => {}); };
  return { send, evaluate, close };
}

const fail = message => new Error(`ChatGPT web: ${message}`);
function check(state) {
  if (state.captcha) throw fail('captcha challenge');
  if (state.expired) throw fail('session expired');
  if (state.rateLimit) throw fail('too many requests');
}

// Gửi một câu hỏi và chờ câu trả lời đầy đủ. followup = URL cuộc trò chuyện trước của job (hỏi tiếp trong cùng chat).
export async function askChatGpt({ profileDir, prompt, followup, timeoutMs = 600_000, signal, chrome, baseUrl = CHATGPT_URL, headless = false, pollMs = 1000, settleMs = 2000 }) {
  const until = Date.now() + timeoutMs, browser = await ensureBrowser(profileDir, { chrome, headless });
  const page = await connect(browser.port);
  const tick = async () => { signal?.throwIfAborted(); if (Date.now() > until) throw fail('timeout'); await delay(pollMs, undefined, { signal }); };
  try {
    const start = followup && /^https?:\/\//.test(followup) ? followup : baseUrl;
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: start });
    let state;
    for (const ready = Date.now() + Math.min(45_000, timeoutMs); ; await tick()) {
      state = await page.evaluate(PROBE).catch(() => null);
      if (state) { check(state); if (state.composer) break; }
      if (Date.now() > ready) throw fail(state?.login || state ? 'not logged in (không thấy ô nhập; bấm "Đăng nhập ChatGPT" trên dashboard)' : 'timeout');
    }
    // Lịch sử cuộc trò chuyện cũ có thể hiện sau ô nhập: chờ một nhịp rồi mới chốt mốc để không đọc nhầm câu trả lời cũ.
    await delay(Math.min(1500, settleMs)); state = await page.evaluate(PROBE); check(state);
    const before = state.turns, previous = state.text;
    await page.evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(SEL.composer)})].find(x => x.offsetWidth || x.offsetHeight); e.focus(); return true; })()`);
    await page.send('Input.insertText', { text: prompt });
    await delay(300);
    const clicked = await page.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(SEL.send)})].find(x => !x.disabled); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    let last = '', stableSince = 0;
    for (; ; await tick()) {
      state = await page.evaluate(PROBE).catch(() => null);
      if (!state) continue;
      check(state);
      if (state.turns <= before || state.stop || !state.text || state.text === previous && state.turns === before) { last = ''; continue; }
      if (state.text !== last) { last = state.text; stableSince = Date.now(); continue; }
      // Xong khi nút Copy của lượt trả lời đã hiện và nội dung đứng yên; thiếu nút Copy thì chờ đứng yên lâu hơn.
      if (Date.now() - stableSince >= (state.done ? settleMs : settleMs * 5)) break;
    }
    return { answer: state.text, session: state.url };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    throw /^ChatGPT web:/.test(error.message) ? error : fail(error.message);
  } finally { await page.close(); }
}
