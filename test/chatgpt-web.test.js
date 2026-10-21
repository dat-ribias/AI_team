import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askChatGpt, closeAll } from '../src/chatgpt-web.js';
import { findChrome } from '../src/preview.js';

// Trang ChatGPT giả cục bộ: cùng selector với trang thật (ô nhập, nút gửi/dừng, lượt trả lời, nút copy). Không gọi mạng.
const page = mode => `<!doctype html><html><head><title>${mode === 'captcha' ? 'Just a moment...' : 'ChatGPT'}</title></head><body>
${mode === 'login' ? '<button data-testid="login-button">Log in</button>' : mode === 'captcha' ? '<p>Verify you are human</p>' : `
<main id="thread"></main>
<form><div id="prompt-textarea" contenteditable="true" data-testid="prompt-textarea"></div><button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu">Pro</button><button type="submit" data-testid="send-button">Send</button></form>`}
<script>
const thread = document.getElementById('thread'), form = document.querySelector('form'), mode = ${JSON.stringify(mode)};
const picker = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
// Như menu Radix của ChatGPT: mở bằng pointerdown (click() thường không mở), chọn bằng click.
picker && picker.addEventListener('pointerdown', () => {
  const menu = document.createElement('div'); menu.setAttribute('role', 'menu');
  for (const name of ['Instant', 'Thinking', 'Pro']) { const item = document.createElement('div'); item.setAttribute('role', 'menuitem'); item.innerHTML = '<div>' + name + '</div><div>Answers right away</div>'; item.style.padding = '8px'; item.onclick = () => { picker.innerText = name; menu.remove(); }; menu.append(item); }
  document.body.append(menu);
});
const add = (role, html) => { const d = document.createElement('div'); d.setAttribute('data-message-author-role', role); d.innerHTML = html; thread.append(d); return d; };
if (location.pathname.startsWith('/c/')) add('assistant', '<div class="markdown">old answer</div><button data-testid="copy-turn-action-button">copy</button>');
form && form.addEventListener('submit', e => {
  e.preventDefault();
  const box = document.getElementById('prompt-textarea'), q = box.innerText; box.innerText = '';
  add('user', q);
  if (mode === 'ratelimit') { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.innerText = 'Too many requests. You are making requests too quickly.'; document.body.append(d); return; }
  if (mode === 'hang') return;
  if (mode === 'pause') { // như model dùng công cụ: câu mở đầu, dừng ngắn (không có nút Stop), rồi mới trả lời thật
    const a = add('assistant', '<div class="markdown">Let me check the repository first.</div>'), md = a.querySelector('.markdown');
    setTimeout(() => { const stop = document.createElement('button'); stop.setAttribute('data-testid', 'stop-button'); form.append(stop);
      setTimeout(() => { md.innerText = 'Real answer'; stop.remove(); a.insertAdjacentHTML('beforeend', '<button data-testid="copy-turn-action-button">copy</button>'); }, 600); }, 700);
    return;
  }
  const stop = document.createElement('button'); stop.setAttribute('data-testid', 'stop-button'); stop.innerText = 'Stop'; form.append(stop);
  const a = add('assistant', '<div class="markdown"></div>'), md = a.querySelector('.markdown');
  let i = 0; const words = ('Answer to: ' + q).split(' ');
  const timer = setInterval(() => { md.innerText = words.slice(0, ++i).join(' '); if (i >= words.length) { clearInterval(timer); stop.remove(); a.insertAdjacentHTML('beforeend', '<button data-testid="copy-turn-action-button">copy</button>'); history.pushState(null, '', '/c/conv-' + mode); } }, 150);
});
</script></body></html>`;

test('ChatGPT web driver: ask, follow up and classify errors against a local fake page', { skip: !findChrome() && !process.env.CHROME_PATH ? 'Chrome not installed' : false, timeout: 120_000 }, async t => {
  const server = createServer((req, res) => { const url = new URL(req.url, 'http://x'); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(url.searchParams.get('mode') || (url.pathname.startsWith('/c/') ? 'ok' : 'ok'))); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`, profileDir = mkdtempSync(join(tmpdir(), 'chatgpt-web-test-'));
  t.after(async () => { await closeAll(); server.close(); rmSync(profileDir, { recursive: true, force: true }); });
  const opts = { profileDir, chrome: process.env.CHROME_PATH || findChrome(), headless: true, pollMs: 100, settleMs: 300, timeoutMs: 30_000 };

  const first = await askChatGpt({ ...opts, baseUrl: base, prompt: 'What is 2+2?', model: 'thinking' });
  assert.equal(first.model, 'Thinking', 'the model is picked from the ChatGPT menu by its visible name');
  await assert.rejects(askChatGpt({ ...opts, baseUrl: base, prompt: 'x', model: 'GPT-9' }), /model "GPT-9" not found \(có: Instant, Thinking, Pro\)/);
  assert.equal(first.answer, 'Answer to: What is 2+2?'); assert.match(first.session, /\/c\/conv-ok$/);
  const second = await askChatGpt({ ...opts, baseUrl: base, followup: first.session, prompt: 'And 3+3?' });
  assert.equal(second.answer, 'Answer to: And 3+3?', 'a follow-up never returns the previous answer');

  assert.equal((await askChatGpt({ ...opts, baseUrl: base + '?mode=pause', prompt: 'x' })).answer, 'Real answer', 'a short pause after a preamble is not the end of the answer');
  await assert.rejects(askChatGpt({ ...opts, baseUrl: base + '?mode=login', prompt: 'x', timeoutMs: 3000 }), /ChatGPT web: (not logged in|timeout)/);
  await assert.rejects(askChatGpt({ ...opts, baseUrl: base + '?mode=captcha', prompt: 'x' }), /ChatGPT web: captcha challenge/);
  await assert.rejects(askChatGpt({ ...opts, baseUrl: base + '?mode=ratelimit', prompt: 'x' }), /ChatGPT web: too many requests/);
  await assert.rejects(askChatGpt({ ...opts, baseUrl: base + '?mode=hang', prompt: 'x', timeoutMs: 4000 }), /ChatGPT web: timeout \(answer; composer=true turns=0 .*\) · ảnh trang: .*-last-error\.png/, 'a timeout says where it got stuck and saves a screenshot');
  const abort = new AbortController(); setTimeout(() => abort.abort(new Error('cancelled by test')), 1500);
  await assert.rejects(askChatGpt({ ...opts, baseUrl: base + '?mode=hang', prompt: 'x', signal: abort.signal }), /cancelled by test/);
});
