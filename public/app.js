const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- i18n: chuỗi nằm ở /locales/<lang>.json, không viết cứng trong code ----
const LANGS = ['vi', 'en', 'ja'], LOCALE_TAG = { vi: 'vi-VN', en: 'en-US', ja: 'ja-JP' };
let lang = 'vi', dict = {}, fallback = {};
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { } } };
function t(key, vars = {}) {
  const text = dict[key] ?? fallback[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
}
async function loadLanguage(next) {
  lang = LANGS.includes(next) ? next : 'vi';
  const get = async l => (await fetch(`/locales/${l}.json`, { cache: 'no-store' })).json();
  [dict, fallback] = await Promise.all([get(lang), lang === 'vi' ? Promise.resolve({}) : get('vi')]);
  document.documentElement.lang = lang; $('lang-select').value = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); if (el.dataset.i18nTitle) el.title = t(el.dataset.i18nTitle); });
}
// ---- giao diện sáng/tối: lưu theo trình duyệt ----
function applyTheme(theme) { document.documentElement.dataset.theme = ['dark', 'light'].includes(theme) ? theme : 'system'; $('theme-select').value = document.documentElement.dataset.theme; }
applyTheme(store.get('theme'));

const clock = time => time ? new Date(time).toLocaleString(LOCALE_TAG[lang], { timeZone: 'Asia/Tokyo' }) : t('ui.common.unknown');
let names = {};
let state, selected, events = [], filter, tab = 'messages', rendering = false, again = false, eventsOf, loginId;
let resultsSelection;
let planView = { job: null, version: null };
async function api(path, data) {
  const r = await fetch('/api/' + path, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Team-Request': '1' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await r.json().catch(() => ({}));
  if (r.status === 404 && path.startsWith('members/') || r.status === 404 && path === 'settings') throw new Error(t('ui.error.oldServer'));
  if (!r.ok) throw Object.assign(new Error(result.error || r.statusText), { status: r.status, details: result.details }); return result;
}
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
async function attempt(fn) {
  try { await fn(); } catch (e) {
    // Hộp thoại mở chồng (Đăng ký dự án trên Giao việc): lỗi phải hiện ở hộp trên cùng.
    const d = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (!d) return notice(e.message);
    let box = d.querySelector('.dialog-error'); if (!box) { box = document.createElement('p'); box.className = 'error-box dialog-error'; box.setAttribute('role', 'alert'); (d.querySelector('form') || d).append(box); }
    box.textContent = e.message; box.scrollIntoView({ block: 'nearest' });
  }
}
document.addEventListener('close', e => e.target.querySelector?.('.dialog-error')?.remove(), true);
// Xác nhận / nhập liệu bằng popup <dialog> thay cho confirm()/prompt() của trình duyệt (bị chặn ở một số webview).
// ask(msg) → true/false; ask(msg, { input: true, value }) → chuỗi hoặc null khi hủy.
function ask(message, { input = false, value = '', ok = t('ui.common.ok'), danger = false } = {}) {
  const d = $('ask-dialog'), field = $('ask-input'), btn = $('ask-ok');
  $('ask-message').textContent = message; field.hidden = !input; field.value = value;
  btn.textContent = ok; btn.className = danger ? 'danger-ghost' : 'primary';
  d.returnValue = ''; d.showModal(); (input ? field : btn).focus();
  return new Promise(done => { d.onclose = () => { const yes = d.returnValue === 'ok'; done(input ? (yes ? field.value : null) : yes); }; });
}
// Đính kèm: chọn file, dán ảnh (Ctrl+V) hoặc kéo thả; gửi dạng base64 cùng mục tiêu/chỉ dẫn.
const pending = { goal: [], message: [] };
const readFile = file => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok({ name: file.name || `paste-${Date.now()}.png`, data: String(r.result).split(',')[1], size: file.size }); r.onerror = fail; r.readAsDataURL(file); });
async function addFiles(kind, list) {
  for (const f of list) { if (f.size > 15 * 2 ** 20) { notice(t('ui.attach.tooBig', { name: f.name })); continue; } pending[kind].push(await readFile(f)); }
  drawAttach(kind);
}
function drawAttach(kind) {
  $(`${kind}-attach`).innerHTML = pending[kind].map((f, i) => `<span class="attach-chip">${esc(f.name)} <small>${Math.ceil(f.size / 1024)} KB</small><button type="button" data-unattach="${kind}:${i}">×</button></span>`).join('');
  document.querySelectorAll(`[data-unattach^="${kind}:"]`).forEach(b => b.onclick = () => { pending[kind].splice(+b.dataset.unattach.split(':')[1], 1); drawAttach(kind); });
}
function wireAttach(kind, input, target) {
  input.onchange = () => attempt(async () => { await addFiles(kind, [...input.files]); input.value = ''; });
  target.addEventListener('paste', e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); attempt(() => addFiles(kind, files)); } });
  target.addEventListener('dragover', e => e.preventDefault());
  target.addEventListener('drop', e => { if (e.dataTransfer.files.length) { e.preventDefault(); attempt(() => addFiles(kind, [...e.dataTransfer.files])); } });
}
const statusLabel = s => t(`ui.status.${s}`);
function jobStatusLabel(job) { return job.git ? t(`ui.gitState.${job.git.state}`) : statusLabel(job.status); }
function badge(job) { return `<span class="status ${esc(job.git?.state || job.status)}">${esc(jobStatusLabel(job))}</span>`; }

let decisionNewIds = new Set(), reconcilePending;
function decisionId(item) { return item.kind === 'orphans' ? 'orphans' : item.jobId; }
function decisionReason(item) {
  if (item.kind === 'orphans') return t('ui.decisions.orphans', { n: item.count });
  if (['base_moved', 'conflict', 'tests_failed', 'cancelled_unmerged'].includes(item.kind || item.state)) return t(`ui.decisions.${item.kind || item.state}`, { files: (item.files || []).join(', ') });
  return item.reason || t(`ui.gitState.${item.state}`);
}
function drawDecisions() {
  const box = $('decisions'); if (!box) return;
  const items = state.decisions || [];
  let saved; try { saved = JSON.parse(store.get('decision-seen') || '[]'); } catch { saved = []; }
  const seen = new Set(Array.isArray(saved) ? saved : []), fresh = items.filter(item => !seen.has(decisionId(item)));
  const active = new Set(items.map(decisionId));
  decisionNewIds = new Set([...decisionNewIds].filter(id => active.has(id)));
  fresh.forEach(item => { seen.add(decisionId(item)); decisionNewIds.add(decisionId(item)); });
  store.set('decision-seen', JSON.stringify([...seen]));
  box.hidden = !items.length;
  $('decision-count').textContent = String(decisionNewIds.size);
  $('decision-count').hidden = !decisionNewIds.size;
  $('decision-list').innerHTML = items.map(item => `<button type="button" class="decision-row" data-decision="${esc(decisionId(item))}"><span class="decision-job">${esc(item.kind === 'orphans' ? t('ui.orphans.title') : item.title)}${item.jobId ? ` <small>#${esc(item.jobId)}</small>` : ''}</span><span class="decision-reason">${esc(decisionReason(item))}${item.reason && item.reason !== item.kind && item.reason !== decisionReason(item) ? ` — ${esc(item.reason)}` : ''}</span></button>`).join('');
  $('decision-list').querySelectorAll('[data-decision]').forEach(button => button.onclick = () => attempt(async () => {
    const id = button.dataset.decision; decisionNewIds.delete(id); drawDecisions(); syncTab();
    if (id === 'orphans') return openOrphans();
    const job = state.jobs.find(j => j.id === id); if (!job) return;
    curProject = job.project; curSession = job.sessionId || ''; selected = id; events = []; filter = null;
    $('overview').click(); await refresh();
  }));
  if (fresh.length) notice(t('ui.decisions.new', { n: fresh.length }));
}
async function reconcileAndRefresh() {
  if (reconcilePending) return reconcilePending;
  reconcilePending = (async () => { try { await api('reconcile', {}); } finally { await refresh(); } })();
  try { await reconcilePending; } finally { reconcilePending = null; }
}
async function deleteJob(id) {
  try { await api(`jobs/${id}/control`, { action: 'delete' }); return true; }
  catch (error) {
    const details = error.details;
    if (error.status !== 409 || !details || details.worktrees?.length) throw error;
    const entries = ['branches', 'wip', 'repos'].flatMap(kind => (details[kind] || []).map(item => `${kind}: ${item.root || ''} ${item.name || item.branch || item.commit || item.revision?.commit || ''}`));
    if (!entries.length) throw error;
    if (!await ask(`${error.message}\n\n${entries.join('\n')}\n\n${t('ui.orphans.archiveWarning')}`, { ok: t('ui.delete.archive'), danger: true })) return false;
    await api(`jobs/${id}/control`, { action: 'delete', archive: true }); return true;
  }
}
let orphanItems = [], orphanDeleting = false;
function drawOrphans() {
  $('orphan-list').innerHTML = orphanItems.length ? `<table class="orphan-table"><thead><tr><th scope="col">${esc(t('ui.orphans.select'))}</th>${['kind', 'repo', 'target', 'merged', 'lastCommit', 'flags'].map(key => `<th scope="col">${esc(t('ui.orphans.' + key))}</th>`).join('')}</tr></thead><tbody>${orphanItems.map((item, i) => `<tr><td><input type="checkbox" data-orphan="${i}" aria-label="${esc(t('ui.orphans.select') + ': ' + item.target)}" ${item.dirty ? 'disabled' : ''}></td><td>${esc(t('ui.orphans.' + item.kind))}</td><td>${esc(item.root)}</td><td>${esc(item.target)}${item.branch && item.branch !== item.target ? `<br><small>${esc(item.branch)}</small>` : ''}</td><td>${esc(t(item.inMain ? 'ui.orphans.inMain' : 'ui.orphans.notInMain'))}</td><td>${esc(clock(item.lastCommitAt))}</td><td>${esc([item.dirty && t('ui.orphans.dirty'), item.prunable && t('ui.orphans.prunable')].filter(Boolean).join(', '))}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">${esc(t('ui.orphans.empty'))}</p>`;
  $('orphan-delete').disabled = true;
  $('orphan-list').querySelectorAll('[data-orphan]').forEach(input => input.onchange = () => { $('orphan-delete').disabled = orphanDeleting || !$('orphan-list').querySelector('[data-orphan]:checked'); });
}
async function openOrphans() {
  $('orphan-dialog').showModal(); $('orphan-result').textContent = ''; $('orphan-list').textContent = t('ui.orphans.loading'); $('orphan-delete').disabled = true;
  orphanItems = await api('orphans'); drawOrphans();
}
async function deleteOrphans() {
  if (orphanDeleting) return;
  const items = [...$('orphan-list').querySelectorAll('[data-orphan]:checked')].map(input => orphanItems[+input.dataset.orphan]);
  if (!items.length || items.some(item => item.dirty)) return;
  orphanDeleting = true; $('orphan-delete').disabled = true;
  try {
    if (!await ask(t('ui.orphans.confirmDelete', { n: items.length }) + (items.some(item => !item.inMain) ? '\n\n' + t('ui.orphans.archiveWarning') : ''), { ok: t('ui.inspector.delete'), danger: true })) return;
    const result = await api('orphans/delete', { items: items.map(({ kind, root, target, tip }) => ({ kind, root, target, tip })) });
    $('orphan-result').textContent = (result.results || []).map(item => `${item.target}: ${item.status}${item.detail ? ' — ' + item.detail : ''}${item.archived ? ' — ' + t('ui.orphans.archived', { tag: Array.isArray(item.archived) ? item.archived.join(', ') : item.archived }) : ''}`).join('\n');
    orphanItems = await api('orphans'); drawOrphans(); await reconcileAndRefresh();
  } finally { orphanDeleting = false; $('orphan-delete').disabled = !$('orphan-list').querySelector('[data-orphan]:checked'); }
}
$('orphans-open').onclick = () => attempt(openOrphans);
$('orphan-close').onclick = () => $('orphan-dialog').close();
$('orphan-delete').onclick = () => attempt(deleteOrphans);
function duration(minutes) {
  const m = Math.max(0, Math.round(minutes)), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), r = m % 60;
  return [d && t('ui.time.days', { n: d }), h && t('ui.time.hours', { n: h }), r && t('ui.time.minutes', { n: r })].filter(Boolean).join(' ') || t('ui.time.minutes', { n: 0 });
}
function activityInfo(at) {
  const minutes = Math.max(0, (Date.now() - Date.parse(at)) / 60000);
  const warn = Number.isFinite(minutes) && minutes > (state?.silenceWarnMin ?? 5);
  return { warn, text: (warn ? '⚠ ' : '') + t('ui.progress.lastActivity', { time: duration(Number.isFinite(minutes) ? minutes : 0) }) };
}
const activityRunKey = run => JSON.stringify([run.agent, run.task ?? null, run.stage ?? null, run.startedAt ?? null]);
function activityHTML(run, job) {
  const at = run.lastActivityAt || run.startedAt, info = activityInfo(at);
  return `<div class="run-activity${info.warn ? ' silence-warn' : ''}" data-activity-at="${esc(at)}"><span data-activity-label>${esc(info.text)}</span><span class="activity-actions" ${info.warn ? '' : 'hidden'}><button type="button" data-activity-check="${esc(activityRunKey(run))}" data-activity-job="${esc(job.id)}">${esc(t('ui.progress.check'))}</button><button type="button" data-activity-pause="${esc(job.id)}">${esc(t('ui.progress.stop'))}</button></span></div>`;
}
function updateActivities() {
  document.querySelectorAll('[data-activity-at]').forEach(el => {
    const info = activityInfo(el.dataset.activityAt);
    el.classList.toggle('silence-warn', info.warn);
    el.querySelector('[data-activity-label]').textContent = info.text;
    el.querySelector('.activity-actions').hidden = !info.warn;
  });
}
function jobEta(job) {
  if (job.overMinutes > 0) return t('ui.eta.over', { time: duration(job.overMinutes) });
  if (job.eta == null) return '';
  return t(job.eta <= 0 ? 'ui.eta.over' : 'ui.eta', { time: duration(Math.abs(job.eta)) });
}
const untilReset = time => { const ms = Date.parse(time) - Date.now(); return Number.isFinite(ms) && ms > 0 ? ' · ' + t('ui.quota.left', { time: duration(ms / 60000) }) : ''; };
function quotaPercent(q) {
  if ('pct' in q) return q.pct == null ? null : Math.round(q.pct); // server đã lọc theo nhóm model (agy: Gemini vs Claude/GPT)
  if (q.observed) { const v = q.buckets.flatMap(b => b.windows).filter(w => !w.resetsAt || Date.parse(w.resetsAt) > Date.now()).map(w => w.remaining).filter(Number.isFinite); return v.length ? Math.round(Math.min(...v)) : null; }
  if (!q.checkedAt || Date.now() - Date.parse(q.checkedAt) > 10 * 60000) return null;
  const values = q.buckets.flatMap(b => b.windows.map(w => w.remaining)).filter(Number.isFinite);
  return values.length ? Math.round(Math.min(...values)) : null;
}
function quotaRemaining(q) {
  const p = quotaPercent(q); if (p == null) return t('ui.common.unknown');
  return t(q.observed ? 'ui.quota.remainingObserved' : 'ui.quota.remaining', { n: p });
}

function dedupeBuckets(buckets) {
  if (!Array.isArray(buckets)) return [];
  const canonicalKey = b => {
    const raw = `${b.id || ''} ${b.name || ''}`.toLowerCase();
    const prefix = String(b.id || '').startsWith('3p') ? '3p:' : (String(b.id || '').startsWith('gemini') ? 'gemini:' : '');
    if (/five[_\s-]*hour|session|\b5h\b/i.test(raw)) return prefix + 'session';
    if (/seven[_\s-]*day|week|\b7d\b/i.test(raw)) return prefix + 'weekly';
    return (b.id || b.name || '').toLowerCase().replace(/[:\s]+$/, '');
  };
  const map = new Map();
  for (const b of buckets) {
    const key = canonicalKey(b);
    if (!map.has(key)) map.set(key, b);
  }
  const result = Array.from(map.values());
  const rank = b => {
    const raw = `${b.id || ''} ${b.name || ''}`.toLowerCase();
    const min = b.windows?.[0]?.minutes;
    if (min === 300 || /five[_\s-]*hour|session|\b5h\b/i.test(raw)) return 1;
    if (min === 10080 || /seven[_\s-]*day|week|\b7d\b/i.test(raw)) return 2;
    return 3;
  };
  return result.sort((a, b) => {
    const groupA = String(a.id).startsWith('3p') ? 1 : 0;
    const groupB = String(b.id).startsWith('3p') ? 1 : 0;
    if (groupA !== groupB) return groupA - groupB;
    return rank(a) - rank(b);
  });
}

function quota5hInfo(q) {
  if (!q || !Array.isArray(q.buckets)) return null;
  const buckets = dedupeBuckets(q.buckets);
  for (const b of buckets) {
    if (b.id === 'claude-session' && b.windows?.length) return { bucket: b, window: b.windows[0] };
  }
  for (const b of buckets) {
    for (const w of (b.windows || [])) {
      if (w.minutes === 300) return { bucket: b, window: w };
    }
  }
  for (const b of buckets) {
    for (const w of (b.windows || [])) {
      if (w.name === '5h' || w.name === 'primary') return { bucket: b, window: w };
    }
  }
  for (const b of buckets) {
    if (/session|5h|five[_\s-]*hour/i.test(b.id || '') || /session|5h|five[_\s-]*hour/i.test(b.name || '')) {
      if (b.windows && b.windows.length) return { bucket: b, window: b.windows[0] };
    }
  }
  for (const b of buckets) {
    for (const w of (b.windows || [])) {
      if (Number.isFinite(w.remaining)) return { bucket: b, window: w };
    }
  }
  return null;
}

function moodKey(rem) {
  if (rem == null) return 'unknown';
  if (rem <= 0) return '0';
  if (rem <= 10) return '10';
  if (rem <= 20) return '20';
  if (rem <= 30) return '30';
  if (rem <= 40) return '40';
  if (rem <= 50) return '50';
  if (rem <= 60) return '60';
  if (rem <= 70) return '70';
  if (rem <= 80) return '80';
  if (rem <= 90) return '90';
  return '100';
}

function moodClass(rem) {
  if (rem == null) return 'unknown';
  if (rem <= 0) return 'danger strike';
  if (rem <= 15) return 'danger';
  if (rem <= 40) return 'warning';
  return 'healthy';
}

function agentHealth(a) {
  if (!a) return null;
  if (a.enabled === false) {
    return {
      state: 'disabled',
      cls: 'disabled',
      label: t('ui.health.disabled'),
      shortLabel: t('ui.health.short.disabled'),
      rem: null,
      title: `${a.label} · ${t('ui.health.disabled')}`
    };
  }
  const info5h = quota5hInfo(a.quota);
  const w = info5h?.window;
  let rem = null, resetText = null, resetsAt = null;
  if (w && Number.isFinite(w.remaining)) {
    rem = Math.max(0, Math.min(100, Math.round(w.remaining)));
    resetText = w.resetText;
    resetsAt = w.resetsAt;
  } else {
    const p = quotaPercent(a.quota);
    if (p != null) rem = Math.max(0, Math.min(100, Math.round(p)));
  }

  if (rem == null) {
    return {
      state: 'unknown',
      cls: 'unknown',
      label: t('ui.health.unknown'),
      shortLabel: t('ui.health.short.unknown'),
      rem: null,
      title: `${a.label} · ${t('ui.health.unknown')}`
    };
  }

  const k = moodKey(rem);
  const cls = moodClass(rem);
  const label = t(`ui.health.mood.${k}`);
  const shortLabel = t(`ui.health.short.${k}`);
  const resetPart = resetText || (resetsAt ? clock(resetsAt) + untilReset(resetsAt) : '');
  const resetSuffix = resetPart ? ` · ${t('ui.quota.reset')} ${resetPart}` : '';

  return {
    state: k,
    cls,
    label,
    shortLabel,
    rem,
    title: `${a.label} · ${label} (${t('ui.quota.windowRemaining', { n: rem })})${resetSuffix}`
  };
}
const tierLabel = tier => t(`ui.tier.${['strong', 'normal', 'weak'].includes(tier) ? tier : 'normal'}`);
const roleLabel = kind => t(`ui.role.${kind}`);
const cut = (s, n) => (s = String(s ?? '')).length > n ? s.slice(0, n - 1) + '…' : s;
const jobTitle = j => j.title || cut((j.goal || '').split('\n').find(l => l.trim()) || '', 60);
const jobWorker = j => runningOf(j).map(r => [names[r.agent] || r.agent, r.stage || j.stage].filter(Boolean).join(' → ')).join(', ') || [names[j.current?.agent] || j.current?.agent, j.stage].filter(Boolean).join(' → ');
function svgText({ text, x, y, cls, maxW, baseSize = 12, minSize = 7.8 }) {
  const str = String(text ?? '');
  if (!str) return '';
  const estCharW = baseSize * 0.56;
  const estTotalW = str.length * estCharW;
  let size = baseSize;
  let useTextLength = false;
  if (estTotalW > maxW) {
    const scaled = Math.floor((maxW / str.length / 0.54) * 10) / 10;
    size = Math.max(minSize, Math.min(baseSize, scaled));
    if (str.length * (size * 0.52) > maxW) {
      useTextLength = true;
    }
  }
  const style = size !== baseSize ? ` font-size="${size}"` : '';
  // Quá dài ngay cả ở cỡ nhỏ nhất: cắt bằng "…" (ép textLength làm chữ dồn thành vệt không đọc được); bản đầy đủ ở tooltip.
  if (!useTextLength) return `<text x="${x}" y="${y}" class="${cls}"${style}>${esc(str)}</text>`;
  const fit = Math.max(4, Math.floor(maxW / (size * 0.56)) - 1);
  return `<text x="${x}" y="${y}" class="${cls}"${style}><title>${esc(str)}</title>${esc(str.slice(0, fit).trimEnd())}…</text>`;
}

// Các lượt đang chạy của một công việc (song song); dữ liệu cũ chỉ có job.current.
const deletable = j => !['running', 'queued', 'merging'].includes(j.status);
const runningOf = j => j?.status === 'running' ? (j.running?.length ? j.running : j.current ? [j.current] : []) : [];
const nodeOfRun = r => ({ plan: 'manager', challenge: 'manager', final: 'manager', implement: 'b:' + r.agent, research: 'b:' + r.agent, review: 'reviewer', verify: 'verifier' })[r.stage] || null;
// ---- Token: isolated usage report view ----
let tokenFilter = { period: 'today', project: '', session: '', job: '', from: '', to: '' }, tokenRequest = 0, tokenReports, tokenTimezone;
const tokenNumber = value => value == null ? '—' : Number(value).toLocaleString(LOCALE_TAG[lang], { maximumFractionDigits: 1 });
const tokenShift = (day, count) => new Date(Date.parse(day + 'T00:00:00Z') + count * 86400000).toISOString().slice(0, 10);
function tokenDay(date, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function tokenRange(timezone, now = new Date()) {
  const today = tokenDay(now, timezone);
  let from = today, to = tokenShift(today, 1);
  if (tokenFilter.period === 'week') { from = tokenShift(today, -((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7)); to = tokenShift(from, 7); }
  if (tokenFilter.period === 'month') { from = today.slice(0, 7) + '-01'; const end = new Date(from + 'T00:00:00Z'); end.setUTCMonth(end.getUTCMonth() + 1); to = end.toISOString().slice(0, 10); }
  if (tokenFilter.period === 'custom') { from = tokenFilter.from; to = tokenFilter.to ? tokenShift(tokenFilter.to, 1) : ''; }
  return { from, to };
}
const tokenCost = r => !r.calls || r.unpricedCalls === r.calls ? '—' : '$' + r.cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const tokenJobCache = new Map();
function tokenJobLink(job) {
  const key = `${job.id}:${job.usage?.calls}:${job.usage?.tokens}:${job.status}`, cached = tokenJobCache.get(key);
  if (!cached && job.createdAt) {
    tokenJobCache.set(key, {});
    api('usage?' + new URLSearchParams({ job: job.id, from: job.createdAt, to: new Date().toISOString(), groupBy: 'job' })).then(report => {
      const totals = report.totals; tokenJobCache.set(key, totals);
      document.querySelectorAll('[data-token-job]').forEach(link => { if (link.dataset.tokenJob === job.id && link.closest('.token-job-usage')) link.textContent = t('ui.token.jobUsage', { tokens: tokenNumber(totals.tokens), calls: tokenNumber(totals.calls), minutes: tokenNumber(totals.unknownDurationCalls ? null : totals.durationMs / 60000) }); });
    }).catch(() => {});
  }
  const ms = cached?.durationMs != null && !cached.unknownDurationCalls ? cached.durationMs : null;
  return `<p class="token-job-usage"><a href="#token" data-token-job="${esc(job.id)}">${esc(t('ui.token.jobUsage', { tokens: tokenNumber(cached?.tokens ?? job.usage?.tokens), calls: tokenNumber(cached?.calls ?? job.usage?.calls), minutes: tokenNumber(ms == null ? null : ms / 60000) }))}</a></p>`;
}
document.addEventListener('click', e => {
  const link = e.target.closest('[data-token-job]');
  if (!link) return;
  e.preventDefault();
  const job = state.jobs.find(j => j.id === link.dataset.tokenJob);
  tokenFilter.job = link.dataset.tokenJob; tokenFilter.project = job?.project || ''; tokenFilter.session = job?.sessionId || '';
  if (job?.createdAt) { const timezone = tokenTimezone || state.usageTimezone || state.timezone || 'Asia/Tokyo'; tokenFilter.period = 'custom'; tokenFilter.from = tokenDay(new Date(job.createdAt), timezone); tokenFilter.to = tokenDay(new Date(), timezone); }
  view('token');
});
function tokenCSV(rows) {
  return rows.map(row => row.map(value => '"' + String(value ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
}
function tokenExport() {
  if (!tokenReports) return;
  const rows = [['from', 'to', 'timezone', 'groupBy', 'key', 'tokens', 'calls', 'durationMs', 'tokensPerMinute', 'wasteRatio', 'unknownTokenCalls', 'unknownDurationCalls', 'costUsd', 'unpricedCalls']];
  for (const report of Object.values(tokenReports)) for (const row of [{ key: 'total', ...report.totals }, ...report.groups]) rows.push([report.from, report.to, report.timezone, report.groupBy, row.key, row.tokens, row.calls, row.durationMs, row.tokensPerMinute, row.wasteRatio, row.unknownTokenCalls, row.unknownDurationCalls, row.cost, row.unpricedCalls]);
  const url = URL.createObjectURL(new Blob(['\uFEFF', tokenCSV(rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'usage.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function tokenRanking(report) {
  const jobGroup = report.groupBy === 'job';
  return `<section class="panel token-ranking"><h3>${esc(t('ui.token.' + report.groupBy))}</h3><div class="token-table-wrap"><table><thead><tr>${['name', 'tokens', 'cost', 'minutes', 'calls', ...(jobGroup ? ['fixes'] : [])].map(k => `<th scope="col">${esc(t('ui.token.' + k))}</th>`).join('')}</tr></thead><tbody>${[...report.groups].sort((a, b) => b.tokens - a.tokens).map(row => {
    const job = jobGroup && state.jobs.find(j => j.id === row.key);
    const label = job ? jobTitle(job) : report.groupBy === 'agent' ? names[row.key] || row.key : row.key;
    return `<tr><th scope="row">${jobGroup ? `<a href="#token" data-token-job="${esc(row.key)}">${esc(label || t('ui.common.unknown'))}</a>` : esc(label || t('ui.common.unknown'))}${job ? `<small>${esc(row.key)}</small>` : ''}</th><td>${tokenNumber(row.tokens)}</td><td title="${row.unpricedCalls ? esc(t('ui.token.unpriced', { n: row.unpricedCalls })) : ''}">${tokenCost(row)}</td><td>${tokenNumber(row.durationMs / 60000)}</td><td>${tokenNumber(row.calls)}</td>${jobGroup ? `<td>${tokenNumber(job ? job.round ?? null : null)}</td>` : ''}</tr>`;
  }).join('') || `<tr><td colspan="${jobGroup ? 6 : 5}">${esc(t('ui.token.empty'))}</td></tr>`}</tbody></table></div></section>`;
}
async function drawToken() {
  if (!state) return;
  const request = ++tokenRequest, root = $('token-view'); tokenReports = null;
  const timezone = tokenTimezone || state.usageTimezone || state.timezone || 'Asia/Tokyo';
  const range = tokenRange(timezone), projects = state.projects, sessions = state.sessions.filter(s => !tokenFilter.project || s.project === tokenFilter.project);
  root.innerHTML = `<div class="panel token-toolbar"><div class="panel-heading"><h2 id="token-title">${esc(t('ui.token.title'))}</h2><button id="token-export" disabled>${esc(t('ui.token.csv'))}</button></div><form id="token-form" class="token-filters"><label>${esc(t('ui.token.period'))}<select id="token-period">${['today', 'week', 'month', 'custom'].map(k => `<option value="${k}" ${tokenFilter.period === k ? 'selected' : ''}>${esc(t('ui.token.' + k))}</option>`).join('')}</select></label><label>${esc(t('ui.task.project'))}<select id="token-project"><option value="">${esc(t('ui.token.all'))}</option>${projects.map(p => `<option value="${esc(p.id)}" ${p.id === tokenFilter.project ? 'selected' : ''}>${esc(p.id)}</option>`).join('')}</select></label><label>${esc(t('ui.token.session'))}<select id="token-session"><option value="">${esc(t('ui.token.all'))}</option>${sessions.map(s => `<option value="${esc(s.id)}" ${s.id === tokenFilter.session ? 'selected' : ''}>${esc(s.name || s.id)}</option>`).join('')}</select></label><label ${tokenFilter.period !== 'custom' ? 'hidden' : ''}>${esc(t('ui.token.from'))}<input id="token-from" type="date" value="${esc(tokenFilter.from)}" required></label><label ${tokenFilter.period !== 'custom' ? 'hidden' : ''}>${esc(t('ui.token.to'))}<input id="token-to" type="date" value="${esc(tokenFilter.to)}" required></label><button type="submit">${esc(t('ui.token.apply'))}</button></form><p class="token-range muted">${esc(range.from)} – ${esc(range.to)} · ${esc(timezone)} · ${esc(t('ui.token.exclusive'))}</p>${tokenFilter.job ? `<p class="token-range">${esc(t('ui.token.job'))}: ${esc(tokenFilter.job)} <button id="token-clear-job">${esc(t('ui.token.clearJob'))}</button></p>` : ''}</div><div id="token-data" aria-live="polite" aria-busy="true">${esc(t('ui.token.loading'))}</div>`;
  $('token-period').onchange = e => { tokenFilter.period = e.target.value; if (tokenFilter.period === 'custom') { tokenFilter.from ||= range.from; tokenFilter.to ||= tokenShift(range.to, -1); } drawToken(); };
  $('token-project').onchange = e => { tokenFilter.project = e.target.value; tokenFilter.session = ''; tokenFilter.job = ''; drawToken(); };
  $('token-session').onchange = e => { tokenFilter.session = e.target.value; tokenFilter.job = ''; drawToken(); };
  for (const key of ['from', 'to']) { $('token-' + key).disabled = tokenFilter.period !== 'custom'; $('token-' + key).onchange = e => { tokenFilter[key] = e.target.value; }; }
  $('token-form').onsubmit = e => { e.preventDefault(); drawToken(); };
  $('token-export').onclick = tokenExport;
  if ($('token-clear-job')) $('token-clear-job').onclick = () => { tokenFilter.job = ''; drawToken(); };
  try {
    if (!range.from || !range.to || range.from >= range.to) throw new Error(t('ui.token.invalidRange'));
    const query = { ...range, project: tokenFilter.project, session: tokenFilter.session, job: tokenFilter.job };
    const get = (groupBy, dates = {}) => api('usage?' + new URLSearchParams({ ...query, ...dates, groupBy }));
    const reports = await Promise.all(['day', 'job', 'agent', 'stage', 'model'].map(k => get(k)));
    if (request !== tokenRequest) return;
    if (reports[0].timezone && reports[0].timezone !== timezone) { tokenTimezone = reports[0].timezone; return drawToken(); }
    const daily = reports[0], days = [...daily.groups].sort((a, b) => a.key.localeCompare(b.key)), members = new Map();
    // Fetch real member totals within each day's bounds; never distribute totals by guesswork.
    for (let i = 0; i < days.length; i += 4) {
      const batch = await Promise.all(days.slice(i, i + 4).map(day => get('agent', { from: day.key, to: tokenShift(day.key, 1) })));
      if (request !== tokenRequest) return;
      batch.forEach((report, n) => members.set(days[i + n].key, report.groups));
    }
    tokenReports = Object.fromEntries(reports.map(r => [r.groupBy, r]));
    const totals = daily.totals, change = daily.change || {}, colors = ['#3182ce', '#d69e2e', '#38a169', '#805ad5', '#dd6b20', '#d53f8c'];
    const agents = reports[2].groups.map(r => r.key).sort(), color = id => colors[agents.indexOf(id) % colors.length];
    const max = Math.max(1, ...days.map(d => d.tokens));
    const comparison = (value, points = false) => value == null ? t('ui.token.noBaseline') : `${value > 0 ? '+' : ''}${tokenNumber(value)}${points ? ' ' + t('ui.token.points') : '%'} ${t('ui.token.previous')}`;
    const cards = [['tokens', tokenNumber(totals.tokens), change.tokensPercent], ['cost', tokenCost(totals), change.costPercent], ['calls', tokenNumber(totals.calls), change.callsPercent], ['minutes', tokenNumber(totals.durationMs / 60000), change.durationPercent], ['waste', tokenNumber(totals.wasteRatio * 100) + '%', change.wasteRatioPoints]];
    const stage = reports[3].groups.find(r => r.key === 'review'), wasted = [...reports[1].groups].sort((a, b) => b.wastedTokens - a.wastedTokens)[0];
    const tips = [];
    if (totals.tokens && stage?.tokens / totals.tokens > .4) tips.push(t('ui.token.reviewTip'));
    if (totals.wastedCalls) tips.push(t('ui.token.wasteTip', { job: wasted?.key || '—' }));
    // SVG presentation attributes render under CSP without inline styles or flex sizing.
    const column = day => {
      let y = 180;
      const bars = (members.get(day.key) || []).map(row => {
        const height = row.tokens / max * 180; y -= height;
        return `<rect x="0" y="${y}" width="46" height="${height}" fill="${color(row.key)}"><title>${esc(day.key + ' · ' + (names[row.key] || row.key) + ': ' + tokenNumber(row.tokens))}</title></rect>`;
      }).join('');
      return `<div class="token-column"><span>${tokenNumber(day.tokens)}</span><svg class="token-stack" viewBox="0 0 46 180" preserveAspectRatio="none" aria-hidden="true">${bars}</svg><small>${esc(day.key.slice(5))}</small></div>`;
    };
    $('token-data').innerHTML = `<div class="token-totals">${cards.map(([k, value, delta]) => `<div class="metric"><span>${esc(t('ui.token.' + k))}</span><strong>${esc(value)}</strong><small>${esc(k === 'cost' && totals.unpricedCalls ? t('ui.token.unpriced', { n: totals.unpricedCalls }) : comparison(delta, k === 'waste'))}</small></div>`).join('')}</div><p class="token-range muted">${esc(t('ui.token.rate', { rate: tokenNumber(totals.tokensPerMinute) }))}${totals.unknownTokenCalls || totals.unknownDurationCalls ? ' · ' + esc(t('ui.token.partial', { tokens: totals.unknownTokenCalls, durations: totals.unknownDurationCalls })) : ''}</p><section class="panel token-chart-panel"><h3>${esc(t('ui.token.daily'))}</h3><div class="token-legend">${agents.map(id => `<span><svg width="12" height="12" aria-hidden="true"><rect width="12" height="12" rx="2" fill="${color(id)}"/></svg>${esc(names[id] || id)}</span>`).join('')}</div><div class="token-chart" role="img" aria-label="${esc(t('ui.token.daily'))}">${days.map(column).join('') || `<p>${esc(t('ui.token.empty'))}</p>`}</div><details><summary>${esc(t('ui.token.chartData'))}</summary><div class="token-table-wrap"><table><thead><tr>${['day', 'agent', 'tokens'].map(k => `<th scope="col">${esc(t('ui.token.' + k))}</th>`).join('')}</tr></thead><tbody>${days.flatMap(day => (members.get(day.key) || []).map(row => `<tr><td>${esc(day.key)}</td><td>${esc(names[row.key] || row.key || t('ui.common.unknown'))}</td><td>${tokenNumber(row.tokens)}</td></tr>`)).join('')}</tbody></table></div></details></section><div class="token-rankings">${reports.slice(1).map(tokenRanking).join('')}</div><section class="panel token-tips"><h3>${esc(t('ui.token.tips'))}</h3>${(tips.length ? tips : [t('ui.token.noTips')]).map(tip => `<p>${esc(tip)}</p>`).join('')}</section>`;
    $('token-data').setAttribute('aria-busy', 'false'); $('token-export').disabled = false;
  } catch (e) {
    if (request !== tokenRequest) return;
    $('token-data').innerHTML = `<p class="error-box">${esc(t('ui.token.failed'))} ${esc(e.message)}</p><button id="token-retry">${esc(t('ui.token.retry'))}</button>`;
    $('token-data').setAttribute('aria-busy', 'false'); $('token-retry').onclick = drawToken;
  }
}
function drawStorage() {
  const storage = state.storage, box = $('storage-warn');
  box.hidden = !(storage?.warn?.dataDir || storage?.warn?.disk);
  if (box.hidden) { box.innerHTML = ''; return; }
  const messages = [];
  if (storage.warn.dataDir) messages.push(t('ui.storage.dataDir', { gb: (storage.dataDirBytes / 2 ** 30).toFixed(1) }));
  if (storage.warn.disk) messages.push(t('ui.storage.disk', { gb: (storage.freeBytes / 2 ** 30).toFixed(1) }));
  box.innerHTML = `<span>${esc(messages.join(' '))}</span><div class="cleanup-actions">${cleanupButtons('storage')}</div>`;
  wireCleanup('storage');
}
function cleanupButtons(prefix) {
  return `<button type="button" id="${esc(prefix)}-cleanup-preview">${esc(t('ui.cleanup.preview'))}</button><button type="button" id="${esc(prefix)}-cleanup-now">${esc(t('ui.cleanup.now'))}</button>`;
}
const cleanupKept = item => /unmerged|kept/i.test(item.reason || '');
function cleanupTotals(items) {
  const removable = items.filter(item => !cleanupKept(item));
  return { n: removable.length, mb: (removable.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0) / 2 ** 20).toFixed(1) };
}
function drawCleanup(manifest, results) {
  const groups = new Map();
  for (const item of manifest.items) {
    if (!groups.has(item.kind)) groups.set(item.kind, []);
    groups.get(item.kind).push(item);
  }
  $('cleanup-body').innerHTML = `<p>${esc(t('ui.cleanup.total', cleanupTotals(manifest.items)))}</p>
    ${results ? `<p role="status">${esc(t('ui.cleanup.finished', { ok: results.filter(r => r.status === 'ok').length, skipped: results.filter(r => r.status === 'skipped').length, errors: results.filter(r => r.status === 'error').length }))}</p>` : ''}
    ${[...groups].map(([kind, items]) => `<section class="cleanup-group"><h3>${esc(t('ui.cleanup.kind.' + kind))} · ${esc(t('ui.cleanup.group', { n: items.length, mb: (items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0) / 2 ** 20).toFixed(1) }))}</h3><ul>${items.map(item => {
      const result = results?.find(r => r.kind === item.kind && r.target === item.target);
      return `<li><span>${esc(item.target)}</span><small>${esc(item.reason)}${cleanupKept(item) ? ' · ' + esc(t('ui.cleanup.kept')) : ''}${result ? ' · ' + esc(t('ui.cleanup.status.' + result.status)) + (result.error ? ': ' + esc(result.error) : '') : ''}</small></li>`;
    }).join('')}</ul></section>`).join('') || `<p class="muted">${esc(t('ui.cleanup.empty'))}</p>`}
    ${!cleanupTotals(manifest.items).n && state?.storage?.top?.length ? `<section class="cleanup-group"><h3>${esc(t('ui.cleanup.usage'))}</h3><p class="muted">${esc(t('ui.cleanup.nothingNote'))}</p><ul>${state.storage.top.map(e => `<li><span>${esc(e.name)}</span><small>${(e.bytes / 2 ** 20).toFixed(1)} MB</small></li>`).join('')}</ul></section>` : ''}`;
  $('cleanup-dialog').querySelector('.dialog-error')?.remove();
  if (!$('cleanup-dialog').open) $('cleanup-dialog').showModal();
}
async function previewCleanup() {
  drawCleanup(await api('cleanup'));
}
async function runCleanup() {
  const manifest = await api('cleanup');
  drawCleanup(manifest);
  if (!cleanupTotals(manifest.items).n) return; // không có gì để dọn: chỉ xem trước, không hỏi xác nhận
  if (!await ask(t('ui.cleanup.confirm', cleanupTotals(manifest.items)))) return;
  try {
    const result = await api('cleanup', { id: manifest.id });
    drawCleanup(manifest, result.results);
    await refresh();
  } catch (e) {
    if (e.status === 409) throw new Error(t('ui.cleanup.expired'));
    throw e;
  }
}
function wireCleanup(prefix) {
  for (const [suffix, action] of [['preview', previewCleanup], ['now', runCleanup]]) {
    const button = $(`${prefix}-cleanup-${suffix}`);
    button.onclick = () => attempt(async () => {
      button.disabled = true;
      try { await action(); } finally { button.disabled = false; }
    });
  }
}
$('close-cleanup').onclick = () => $('cleanup-dialog').close();

function drawState() {
  $('oracle-toggle').checked = !!state.oracle?.enabled;
  $('oracle-toggle').disabled = !state.oracle?.accounts;
  $('oracle-toggle').parentElement.title = t('ui.settings.oracleHint') + (!state.oracle?.accounts ? ' ' + t('ui.settings.oracleUnavailable') : '');
  names = { controller: 'Controller', user: t('ui.who.user'), team: t('ui.who.team'), ...Object.fromEntries(state.agents.map(a => [a.id, a.label])) };
  $('stale').hidden = !state.stale;
  drawStorage();
  $('mode').textContent = state.demo ? t('ui.header.demo') : 'LIVE · LOCAL';
  $('connection').textContent = t('ui.nav.connected');
  if (state.demo && !$('notice').textContent) notice(t('ui.header.demoNotice'));
  const projJobs = state.jobs.filter(j => j.project === curProject); // số liệu công việc theo dự án đang mở
  const ready = projJobs.filter(j => j.status === 'ready').length;
  $('metrics').innerHTML = [
    [t('ui.metric.agents'), `${state.resources.active} <small>/ ${state.resources.slots ?? 1}</small>`, state.resources.waitingReason || t('ui.metric.onDemand'), state.resources.active > state.resources.maxAgents ? t('ui.metric.agentsAboveRecommended', { n: state.resources.active, m: state.resources.maxAgents }) : ''],
    [t('ui.metric.jobs'), projJobs.length, t('ui.metric.jobsNote', { running: projJobs.filter(j => ['queued', 'running'].includes(j.status)).length, ready })],
    [t('ui.metric.ram'), `${state.resources.ramPercent}%`, t('ui.metric.ramNote', { total: state.resources.totalGB, controller: state.resources.controllerMB })],
    [t('ui.metric.cpu'), `${state.resources.cpuPercent}%`, t('ui.metric.cpuAverage30s')],
  ].map(([label, value, note, warning]) => `<div class="metric"><span>${esc(label)}</span><strong>${value}</strong><small>${esc(note)}</small>${warning ? `<small class="metric-agents-warning">${esc(warning)}</small>` : ''}</div>`).join('');
  if (!$('recent-flaky')) $('metrics').insertAdjacentHTML('afterend', '<section id="recent-flaky" class="panel history" aria-labelledby="recent-flaky-title"></section>');
  $('recent-flaky').innerHTML = `<h2 id="recent-flaky-title">${esc(t('ui.flaky.title'))}</h2>` + ((state.flaky || []).filter(item => { const p = state.jobs.find(j => j.id === item.job)?.project; return !p || p === curProject; }).slice(0, 10).map(item => `<p class="muted">${esc(t('ui.flaky.item', { test: item.test, job: item.job, at: clock(item.at) }))}</p>`).join('') || `<p class="muted">${esc(t('ui.flaky.empty'))}</p>`);
  const resultJob = state.jobs.find(j => j.id === selected);
  if (resultsSelection !== selected) {
    resultsSelection = selected;
    if (['ready', 'done', 'merged'].includes(resultJob?.status)) tab = 'results';
  }
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('selected', b.dataset.tab === tab));
  drawSessions(); syncTab();
  { const j = state.jobs.find(x => x.id === selected); $('flow-summary').textContent = j ? `${jobTitle(j)} · ${jobStatusLabel(j)}${runningOf(j).map(r => ' · ' + (names[r.agent] || r.agent) + ' → ' + r.stage).join('')}${jobEta(j) ? ' · ' + jobEta(j) : ''}` : t('ui.flow.summaryIdle'); }
  drawJobsList();
  drawJobsDialog();
  drawFlow();
  if ($('slot-dialog').open && slot?.current) refreshSlotLive();
  document.querySelectorAll('[data-slot]').forEach(b => b.onclick = () => {
    if (b.dataset.task != null) {
      const detail = $('inspector').querySelector('[data-task-detail="' + b.dataset.task + '"]');
      if (detail) { detail.open = true; detail.scrollIntoView({ block: 'nearest' }); detail.querySelector('summary').focus(); return; }
    }
    openSlot(b.dataset.slot, b.dataset.agent || null, b.dataset.task, b.closest('#flow') ? selected : null);
  });
  document.querySelectorAll('[data-bench]').forEach(b => b.onclick = () => attempt(() => openProfile(b.dataset.bench)));
  $('running-label').textContent = t('ui.team.running', { n: state.resources.active });
  const taskProject = $('task-dialog').open ? $('project').value : null;
  $('project').innerHTML = state.projects.map(p => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join('');
  if (taskProject && state.projects.some(p => p.id === taskProject)) $('project').value = taskProject;
  $('project-help').textContent = t(state.projects.length ? 'ui.task.projectHelp' : 'ui.task.noProject');
  $('submit-task').disabled = !state.projects.length;
  drawInspector(); drawQuota(); drawLogin();
}

let jobsFilter = 'all', jobsSearchQuery = '', jobsProject = '';

// Thứ tự merge của dự án: job code chưa vào nhánh gốc, job được nhắc mã (#id) trong goal/lý do/tin nhắn của job khác phải merge trước, còn lại theo giờ tạo.
// ponytail: phụ thuộc đoán từ việc nhắc mã job; thay bằng phụ thuộc khai báo khi e778ed40 xong.
function mergeQueue() {
  const open = state.jobs.filter(j => j.project === curProject && j.kind !== 'research' && !['merged', 'cancelled'].includes(j.status) && j.git?.state !== 'in_master').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const deps = new Map(open.map(j => { const text = [j.goal, j.reason, JSON.stringify(j.messages || [])].join(' '); return [j.id, open.filter(o => o !== j && text.includes(o.id.slice(0, 8))).map(o => o.id)]; }));
  const out = [], done = new Set();
  const visit = (j, path) => { if (done.has(j.id) || path.has(j.id)) return; path.add(j.id); for (const d of deps.get(j.id)) visit(open.find(o => o.id === d), path); done.add(j.id); out.push(j); };
  open.forEach(j => visit(j, new Set()));
  return out.map(j => ({ job: j, waits: deps.get(j.id) }));
}

function drawJobsList() {
  // Menu liệt kê MỌI việc của dự án đang mở (phiên chỉ là nhóm con, hiện trong dòng meta), việc của phiên hiện tại lên trước.
  const sessionJobs = state.jobs.filter(j => !curProject || j.project === curProject).sort((a, b) => (b.sessionId === curSession) - (a.sessionId === curSession));
  const maxSidebar = 10;
  const showList = sessionJobs.slice(0, maxSidebar);
  const hasMore = sessionJobs.length > maxSidebar;

  const queue = mergeQueue();
  const queueHTML = queue.length ? `<div class="merge-queue"><p class="muted away-title">${esc(t('ui.mergeQueue.title'))}</p>` + queue.map(({ job: j, waits }, i) => `<button class="job-button merge-queue-item ${j.status === 'ready' && !waits.length ? 'merge-next' : ''}" data-job="${esc(j.id)}" title="${esc(jobTitle(j))}"><span class="merge-queue-n">${i + 1}</span><div class="job-button-content"><strong>${esc(jobTitle(j))}</strong><small>${badge(j)}<span class="job-list-meta"> · #${esc(j.id.slice(0, 8))}${waits.length ? ' · ' + esc(t('ui.mergeQueue.waits', { ids: waits.map(x => '#' + x.slice(0, 8)).join(', ') })) : ''}</span></small></div></button>`).join('') + '</div>' : '';
  $('job-list').innerHTML = queueHTML + (showList.length ? showList.map(j => `
    <button class="job-button ${j.id === selected ? 'selected' : ''} ${runningOf(j).length ? 'working' : ''} ${j.status === 'blocked' ? 'blocked' : ''}" data-job="${esc(j.id)}" title="${esc(jobTitle(j))}">
      <span class="job-dot-status ${j.status}"></span>
      <div class="job-button-content">
        <strong>${esc(jobTitle(j))}</strong>
        <small>${badge(j)}<span class="job-list-meta"> · ${esc([state.sessions.find(x => x.id === j.sessionId)?.name, jobWorker(j), clock(j.updatedAt || j.createdAt)].filter(Boolean).join(' · '))}</span></small>
      </div>
    </button>
  `).join('') : `<p class="muted">${esc(t('ui.nav.noJobs'))}</p>`)
  + (hasMore ? `<button type="button" class="sidebar-more-jobs" id="sidebar-more-jobs"><span>⤢</span> ${esc(t('ui.jobs.viewAll', { n: sessionJobs.length }))}</button>` : '');

  // Việc đang chạy ở dự án/phiên khác: hiện lối tắt để khỏi nhìn sơ đồ sáng mà khung chat trống.
  const away = state.jobs.filter(j => ['running', 'queued', 'waiting'].includes(j.status) && !sessionJobs.includes(j));
  if (away.length) $('job-list').insertAdjacentHTML('beforeend', `<p class="muted away-title">${esc(t('ui.nav.runningElsewhere'))}</p>` + away.slice(0, 4).map(j => `<button class="job-button away ${runningOf(j).length ? 'working' : ''}" data-away="${esc(j.id)}" title="${esc(jobTitle(j))}"><span class="job-dot-status ${j.status}"></span><div class="job-button-content"><strong>${esc(jobTitle(j))}</strong><small>${esc(j.project)} · ${esc(state.sessions.find(x => x.id === j.sessionId)?.name || '')} · #${esc(j.id.slice(0, 8))}</small></div></button>`).join(''));
  document.querySelectorAll('[data-away]').forEach(b => b.onclick = () => gotoJob(b.dataset.away));
  document.querySelectorAll('[data-job]').forEach(b => b.onclick = () => { if ($('jobs-dialog')?.open) $('jobs-dialog').close(); gotoJob(b.dataset.job); }); // chuyển luôn sang phiên của việc

  const moreBtn = $('sidebar-more-jobs');
  if (moreBtn) moreBtn.onclick = () => openJobsDialog();
}

function openJobsDialog() {
  jobsProject = curProject; // mặc định chỉ hiện job của dự án đang mở
  $('jobs-dialog').showModal();
  drawJobsDialog();
}

function drawJobsDialog() {
  if (!$('jobs-dialog')?.open) return;
  const sel = $('jobs-project');
  if (sel) { sel.innerHTML = `<option value="">${esc(t('ui.jobs.allProjects'))}</option>` + state.projects.map(p => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join(''); sel.value = jobsProject; }
  const allJobs = (state.jobs || []).filter(j => !jobsProject || j.project === jobsProject);
  const q = (jobsSearchQuery || '').trim().toLowerCase();

  const counts = {
    all: allJobs.length,
    running: allJobs.filter(j => ['running', 'queued'].includes(j.status)).length,
    ready: allJobs.filter(j => j.status === 'ready').length,
    done: allJobs.filter(j => ['done', 'merged'].includes(j.status)).length,
    cancelled: allJobs.filter(j => ['cancelled', 'blocked', 'failed'].includes(j.status)).length,
  };

  if ($('count-all')) $('count-all').textContent = counts.all;
  if ($('count-running')) $('count-running').textContent = counts.running;
  if ($('count-ready')) $('count-ready').textContent = counts.ready;
  if ($('count-done')) $('count-done').textContent = counts.done;
  if ($('count-cancelled')) $('count-cancelled').textContent = counts.cancelled;
  if ($('jobs-dialog-sub')) $('jobs-dialog-sub').textContent = t('ui.metric.jobsNote', { running: counts.running, ready: counts.ready });

  // Gõ mã job (hex) mà có job trùng mã thì chỉ hiện job đó, không lẫn các job có nhắc mã ấy trong mục tiêu.
  const idHits = /^#?[0-9a-f]{4,}$/.test(q) ? allJobs.filter(j => j.id.startsWith(q.replace('#', ''))) : [];
  const filtered = idHits.length ? idHits : allJobs.filter(j => {
    if (jobsFilter === 'running' && !['running', 'queued'].includes(j.status)) return false;
    if (jobsFilter === 'ready' && j.status !== 'ready') return false;
    if (jobsFilter === 'done' && !['done', 'merged'].includes(j.status)) return false;
    if (jobsFilter === 'cancelled' && !['cancelled', 'blocked', 'failed'].includes(j.status)) return false;
    if (q) {
      const matchTitle = jobTitle(j).toLowerCase().includes(q);
      const matchGoal = (j.goal || '').toLowerCase().includes(q);
      const matchId = (j.id || '').toLowerCase().includes(q);
      const matchBranch = (j.branch || '').toLowerCase().includes(q);
      const matchProject = (j.project || '').toLowerCase().includes(q);
      const matchAgent = (names[j.current?.agent] || j.current?.agent || '').toLowerCase().includes(q);
      if (!matchTitle && !matchGoal && !matchId && !matchBranch && !matchProject && !matchAgent) return false;
    }
    return true;
  });

  const listEl = $('jobs-dialog-list');
  if (!listEl) return;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty"><span class="empty-icon">⌁</span><b>${esc(t('ui.jobs.noMatch'))}</b></div>`;
    return;
  }

  const openGoals = new Set([...listEl.querySelectorAll('details[open]')].map(d => d.dataset.jobGoal));
  listEl.innerHTML = filtered.map(j => {
    const isSelected = j.id === selected;
    const session = state.sessions.find(x => x.id === j.sessionId)?.name;
    const tasksDone = j.taskIndex ?? 0;
    const tasksTotal = j.tasks?.length ?? 0;
    return `
      <div class="job-card ${isSelected ? 'selected' : ''}" data-job-select="${esc(j.id)}">
        <div class="job-card-head">
          <strong class="job-card-title" title="${esc(jobTitle(j))}">${esc(jobTitle(j))}</strong>
          ${badge(j)}
          <time class="muted">${esc(clock(j.updatedAt || j.createdAt))}</time>
        </div>
        <div class="job-card-row">
          <div class="job-card-meta" title="${esc([j.project, session, jobWorker(j)].filter(Boolean).join(' · '))}">
            ${esc([j.project, session, jobWorker(j), '#' + j.id.slice(0, 8), t('ui.jobs.tasks', { done: tasksDone, total: tasksTotal })].filter(Boolean).join(' · '))}
          </div>
          <details data-job-goal="${esc(j.id)}" ${openGoals.has(j.id) ? 'open' : ''}><summary>${esc(t('ui.jobs.showGoal'))}</summary><p class="task-instruction">${esc(j.goal)}</p></details>
          <div class="job-card-actions">
            ${deletable(j) ? `<button type="button" class="danger-ghost" data-job-delete="${esc(j.id)}">${esc(t('ui.inspector.delete'))}</button>` : ''}
            <button type="button" class="${isSelected ? 'primary-ghost' : 'primary'}" data-job-open="${esc(j.id)}">${esc(t(isSelected ? 'ui.jobs.selected' : 'ui.jobs.select'))}</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('details').forEach(el => el.onclick = e => e.stopPropagation());
  listEl.querySelectorAll('[data-job-delete]').forEach(el => el.onclick = e => { e.stopPropagation(); attempt(async () => {
    if (!await ask(t('ui.inspector.confirmDelete'), { ok: t('ui.inspector.delete'), danger: true })) return;
    const id = el.dataset.jobDelete, card = el.closest('.job-card'); card?.classList.add('deleting'); // xóa worktree/branch có thể mất vài giây: khóa thẻ để khỏi bấm lại
    try { if (!await deleteJob(id)) { card?.classList.remove('deleting'); return; } } catch (err) { card?.classList.remove('deleting'); throw err; }
    $('jobs-dialog').querySelector('.dialog-error')?.remove();
    if (selected === id) { selected = undefined; events = []; } await refresh(); }); });
  listEl.querySelectorAll('[data-job-open], [data-job-select]').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      const id = el.dataset.jobOpen || el.dataset.jobSelect;
      if (id) {
        $('jobs-dialog').close();
        view('work');
        gotoJob(id); // chuyển luôn dự án/phiên theo job, không chỉ đổi selected
      }
    };
  });
}
const ROLE_KEYS = ['manager', 'builder', 'reviewer', 'verifier'];
const rolesOf = (id, r = state.roster) => ROLE_KEYS.filter(k => k === 'builder' ? r.builders.includes(id) : r[k] === id);
const rolesText = id => rolesOf(id).map(roleLabel).join(' / ') || roleLabel('none');
// Một member có thể giữ nhiều vai trò: tick/bỏ tick từng vai trò.
const roleChecks = a => `<div class="role-checks">${ROLE_KEYS.map(k => `<label class="role-chip"><input type="checkbox" data-role-toggle="${esc(a.id)}" value="${k}" ${rolesOf(a.id).includes(k) ? 'checked' : ''} ${k === 'builder' && a.provider === 'antigravity' ? 'disabled' : ''}> ${esc(roleLabel(k))}</label>`).join('')}</div>`;
// Bấm ô trên sơ đồ: đổi member cho vai trò đó + sửa system prompt của member ngay tại chỗ.
let slot = null;
// Phiên chat theo dự án (lưu lựa chọn theo trình duyệt).
// Mỗi tab giữ dự án/phiên/việc riêng trên URL (#p=&s=&j=), mở nhiều tab = nhiều phòng điều phối; localStorage chỉ là mặc định cho tab mới.
const tabHash = new URLSearchParams(location.hash.slice(1));
let curProject = tabHash.get('p') ?? (store.get('project') || ''), curSession = tabHash.get('s') ?? (store.get('session') || '');
if (tabHash.get('job') || tabHash.get('j')) selected = tabHash.get('job') || tabHash.get('j');
let linkedJob = tabHash.get('job');
function syncTab() {
  const q = new URLSearchParams({ p: curProject, s: curSession, ...(selected ? { j: selected } : {}) });
  if (location.hash.slice(1) !== q.toString()) history.replaceState(null, '', '#' + q);
  const s = state.sessions.find(x => x.id === curSession);
  document.title = (decisionNewIds.size ? "(" + decisionNewIds.size + ") " : "") + `${s ? s.name + ' · ' : ''}${curProject || 'AI Team'} · Control Room`;
}
function drawSessions() {
  if (!state.projects.some(p => p.id === curProject)) curProject = state.projects[0]?.id || '';
  const list = state.sessions.filter(x => x.project === curProject);
  // Chưa chọn phiên (vd vừa đổi dự án): mở phiên có việc mới nhất, không phải phiên mới tạo đang trống.
  if (!list.some(x => x.id === curSession)) curSession = list.find(x => x.id === state.jobs.find(j => j.project === curProject)?.sessionId)?.id || list.at(-1)?.id || '';
  // Dự án có AI đang chạy: chấm ● + số AI trong ô chọn; ô sáng khi có dự án KHÁC đang chạy.
  // Đếm việc đang chạy (kể cả lúc controller chạy test/merge, khi không có AI nào) chứ không chỉ AI đang gọi.
  const busyOf = id => state.jobs.filter(j => j.project === id && (['running', 'queued', 'merging'].includes(j.status) || runningOf(j).length)).length;
  $('session-project').innerHTML = state.projects.map(p => { const n = busyOf(p.id); return `<option value="${esc(p.id)}">${n ? `● ${esc(p.id)} · ${esc(t('ui.nav.jobsRunning', { n }))}` : esc(p.id)}</option>`; }).join('') + `<option value="__add">${esc(t('ui.project.add'))}</option>`;
  $('session-project').classList.toggle('working', state.projects.some(p => p.id !== curProject && busyOf(p.id)));
  $('session-project').value = curProject;
  $('session-tabs').innerHTML = list.map(x => { const st = sessionState(x.id); return `<button role="tab" class="stab ${x.id === curSession ? 'active' : ''} ${st.cls}" data-session="${esc(x.id)}" title="${esc(x.name + ' · ' + st.label + ' · ' + sessionSummary(x))}"><span class="job-dot-status ${st.dot}"></span>${esc(cut(x.name, 28))}<span class="stab-x" data-session-del="${esc(x.id)}" title="${esc(t('ui.inspector.delete'))}">×</span></button>`; }).join('') || `<span class="muted">${esc(t('ui.session.none'))}</span>`;
  $('session-summary').textContent = sessionSummary(list.find(x => x.id === curSession));
  $('session-tabs').querySelectorAll('[data-session]').forEach(b => { b.onclick = () => { curSession = b.dataset.session; store.set('session', curSession); drawSessions(); selectSessionJob(); }; b.ondblclick = () => $('session-rename').click(); });
  $('session-tabs').querySelectorAll('[data-session-del]').forEach(x => x.onclick = e => { e.stopPropagation();
    const id = x.dataset.sessionDel, n = state.jobs.filter(j => j.sessionId === id).length;
    attempt(async () => { if (!await ask(t('ui.session.confirmDelete', { n }), { ok: t('ui.inspector.delete'), danger: true })) return; await api(`sessions/${id}/delete`, {}); if (curSession === id) { curSession = ''; selected = undefined; events = []; } await refresh(); }); });
}
function sessionSummary(session) {
  if (!session) return '';
  const job = state.jobs.find(j => j.project === session.project && j.sessionId === session.id);
  return [session.notes, job && jobStatusLabel(job) + ' · #' + job.id + ' · ' + jobTitle(job)].filter(Boolean).join(' · ');
}
// working = có AI thật sự đang chạy; còn lại theo việc mới nhất của phiên.
function sessionState(id) {
  const jobs = state.jobs.filter(j => j.project === curProject && j.sessionId === id);
  if (jobs.some(j => runningOf(j).length)) return { cls: 'working', dot: 'running', label: statusLabel('running') };
  const live = jobs.find(j => ['running', 'queued'].includes(j.status)), last = live || jobs[0];
  return last ? { cls: last.status === 'blocked' ? 'blocked' : '', dot: last.status, label: jobStatusLabel(last) } : { cls: '', dot: '', label: '' };
}
// Bảng "node đang làm gì": dựng từ events đã có, không gọi thêm AI.
function slotLive(id) {
  const job = state.jobs.find(j => j.id === (slot?.job || selected));
  if (!id || !job) return '';
  const concurrent = runningOf(job).filter(r => r.agent === id).length > 1;
  const mine = events.filter(e => e.from === id && (slot?.task == null || e.details?.task === slot.task || e.details?.task == null && !concurrent));
  // Codex gửi in_progress rồi completed cho cùng item: giữ bản mới nhất.
  const last = new Map(); for (const e of mine.filter(e => e.type === 'ACTIVITY')) last.set(e.details?.id ? e.details.id + (e.details.command || e.details.text || "") : e.details?.parameters ? e.details.name + JSON.stringify(e.details.parameters) : e.seq, e); // agy: bắt đầu + kết thúc cùng tham số → 1 dòng // id (item_1…) lặp lại giữa các lượt
  const acts = [...last.values()].slice(-40), res = mine.filter(e => ['RESULT', 'REVIEW_RESULT', 'CONCLUSION', 'BLOCKER'].includes(e.type)).at(-1);
  const cur = runningOf(job).find(r => r.agent === id && (slot?.run ? activityRunKey(r) === slot.run : slot?.task == null || r.task === slot.task));
  return `<b>${esc(t(cur ? 'ui.slot.liveNow' : 'ui.slot.liveIdle', { stage: cur?.stage || '', time: cur ? duration((Date.now() - Date.parse(cur.startedAt)) / 60000) : '' }))}</b>${cur ? activityHTML(cur, job) : ''}${acts.length ? `<div class="live-log">${acts.map((e, i) => actView(e, i === acts.length - 1)).join('')}</div>` : ''}${res ? `<p class="muted">${esc(t('ui.slot.lastResult'))}</p><div class="chat-bubble">${esc(cut(res.summary, 800))}</div>` : ''}`;
}
const shortCmd = c => String(c || '').replace(/^"?[^"]*powershell(\.exe)?"?\s+(-NoProfile\s+)?-Command\s+/i, '');
function actView(e, open) {
  const d = e.details || {}, pre = (head, body) => `<details data-seq="${e.seq}" ${open ? 'open' : ''}><summary>${head}</summary><pre>${esc(String(body).slice(-6000))}</pre></details>`;
  if (d.type === 'command_execution') return pre(`<code>$ ${esc(cut(shortCmd(d.command), 160))}</code> <span class="muted">${d.status === 'in_progress' ? '…' : 'exit ' + d.exit_code}</span>`, shortCmd(d.command) + '\n\n' + (d.aggregated_output || ''));
  if (d.type === 'file_change') return `<div class="live-file">✎ ${(d.changes || []).map(c => esc(c.kind + ' ' + c.path)).join('<br>')}</div>`;
  if (d.type === 'agent_message') return `<div class="chat-bubble">${esc(cut(d.text, 3000))}</div>`;
  if (d.type === 'tool_result') return pre(`<span class="muted">↳ output${d.is_error ? ' (error)' : ''}</span>`, d.output);
  if (d.name) { const args = d.input || d.parameters || {}, key = Object.values(args).find(v => typeof v === 'string') || JSON.stringify(args), out = d.error ? '⚠ ' + (d.error.message || JSON.stringify(d.error)) : d.output;
    return pre(`<code>${esc(d.name)}</code> <span class="muted">${esc(cut(key, 140))}</span>${out != null ? ` <span class="${d.error ? 'risk-high' : 'muted'}">↳ ${esc(cut(String(out), 60))}</span>` : ''}`, JSON.stringify(args, null, 2) + (out != null ? '\n\n' + out : '')); }
  return pre(`<code>${esc(cut(e.summary, 160))}</code>`, JSON.stringify(d, null, 2));
}
// Giữ trạng thái mở/đóng và vị trí cuộn khi cập nhật live.
function refreshSlotLive() {
  const el = $('slot-live'), log = el.querySelector('.live-log'), atEnd = !log || log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  const opened = new Set([...el.querySelectorAll('details[open]')].map(x => x.dataset.seq)), top = log?.scrollTop;
  el.innerHTML = slotLive(slot.current);
  el.querySelectorAll('details').forEach(x => { if (opened.size) x.open = opened.has(x.dataset.seq); });
  const nlog = el.querySelector('.live-log'); if (nlog) nlog.scrollTop = atEnd ? nlog.scrollHeight : top;
}
// Bấm ô trên sơ đồ của một việc → chỉ đổi người cho việc đó (task hoặc vai trò); ngoài sơ đồ việc → đổi vai trò chung của đội.
function openSlot(kind, current, task, jobId, run = null) {
  const job = jobId && state.jobs.find(j => j.id === jobId && !['merged', 'cancelled', 'done'].includes(j.status));
  if (jobId && !job && task != null) return; // việc đã kết thúc: ô task là lịch sử, không đổi được
  slot = { kind, current, task: job && task != null ? +task : null, job: job?.id || null, run };
  $('slot-live').innerHTML = slotLive(current); const lg = $('slot-live').querySelector('.live-log'); if (lg) lg.scrollTop = lg.scrollHeight;
  $('slot-title').textContent = t(current || kind !== 'builder' ? 'ui.slot.title' : 'ui.slot.addBuilderTitle', { role: roleLabel(kind) });
  $('slot-member').innerHTML = (current ? '' : `<option value="">${esc(t('ui.slot.none'))}</option>`) + state.agents.map(a => {
    const h = agentHealth(a);
    const healthText = h ? ` · ${h.label}${h.rem != null ? ' ' + h.rem + '%' : ''}` : '';
    return `<option value="${esc(a.id)}" ${a.id === current ? 'selected' : ''} ${kind === 'builder' && a.provider === 'antigravity' ? 'disabled' : ''}>${esc(a.label)} · ${esc(a.provider)} · ${esc(tierLabel(a.tier))}${healthText}</option>`;
  }).join('');
  if (slot.job) $('slot-title').textContent = slot.task != null ? t('ui.slot.taskTitle', { n: slot.task + 1 }) : t('ui.slot.jobTitle', { role: roleLabel(kind) });
  else if (jobId) $('slot-title').textContent = t('ui.slot.teamTitle', { role: roleLabel(kind) }); // việc đã kết thúc giữ người đã làm; đổi ở đây là đổi cả đội
  $('slot-remove').hidden = !current || !!slot.job; $('slot-filter').hidden = !current; $('slot-profile').hidden = !current;
  slotMember(); $('slot-dialog').showModal();
}
function slotMember() {
  const a = state.agents.find(x => x.id === $('slot-member').value);
  $('slot-prompt').value = a?.systemPrompt || ''; $('slot-prompt').disabled = !a;
  $('slot-info').textContent = (slot?.job ? t('ui.slot.jobNote') + ' ' : '') + (a ? t('ui.slot.info', { roles: rolesText(a.id), model: (a.model || t('ui.profile.modelDefault')) + (a.effort ? ' · ' + effortLabel(a.effort) : '') }) : '');
}
async function saveSlot() {
  const { kind, current } = slot, next = $('slot-member').value;
  if (slot.job) { if (next && next !== current) await api(`jobs/${slot.job}/control`, { action: 'assign', agent: next, ...(slot.task != null ? { task: slot.task } : { role: kind, from: current }) }); }
  else if (next && next !== current) {
    if (kind === 'builder' && current) await api(`members/${current}/role`, { kind, on: false });
    await api(`members/${next}/role`, { kind, on: true });
  }
  const a = state.agents.find(x => x.id === next);
  if (a && $('slot-prompt').value !== (a.systemPrompt || '')) await api(`members/${next}/profile`, { systemPrompt: $('slot-prompt').value });
  $('slot-dialog').close(); await refresh();
}
// Sơ đồ dựng lại từ roster + plan của task đang chọn: thêm member hay Manager đổi người là tự vẽ lại.
function drawFlow() {
  const current = state.jobs.find(j => j.id === selected), plans = current?.plans || [], latest = plans.at(-1);
  if (planView.job !== selected) planView = { job: selected, version: null };
  const plan = plans.find(p => p.version === planView.version) || latest, readonly = !!plan && plan !== latest;
  const job = readonly ? { ...current, tasks: plan.tasks, flow: plan.flow, round: plan.round, running: [], current: null, checkers: {}, override: {}, skipped: [] } : current, r = job?.roster || state.roster;
  let history = '';
  if (plans.length > 1 || latest && current.planGate) {
    const previous = plans[plans.indexOf(plan) - 1], before = previous?.tasks || [], after = plan.tasks || [];
    const remaining = [...before]; let added = 0, reassigned = 0;
    for (const task of after) {
      const i = remaining.findIndex(x => x.instruction === task.instruction);
      if (i < 0) added++; else { if (remaining[i].agent !== task.agent) reassigned++; remaining.splice(i, 1); }
    }
    const diff = previous ? added || remaining.length || reassigned ? t('ui.plan.diff', { added, removed: remaining.length, reassigned }) : t('ui.plan.noDiff') : '';
    history = `<div class="plan-history"><nav class="plan-versions" aria-label="${esc(t('ui.plan.history'))}">${plans.map(p => `<button type="button" data-plan-version="${p.version}" aria-pressed="${p === plan}" class="${p === plan ? 'selected' : ''}">${esc(t('ui.plan.version', { v: p.version }))}${p === latest ? ' · ' + esc(t(current.planGate ? 'ui.plan.draft' : 'ui.plan.current')) : ''}</button>`).join('')}</nav>${readonly ? `<b class="plan-readonly">${esc(t('ui.plan.readonly'))}</b>` : ''}<p>${esc(t('ui.plan.reason.' + plan.reason))}${plan.trigger ? ' · ' + esc(plan.trigger) : ''}</p>${plan.summary ? `<p>${esc(plan.summary)}</p>` : ''}${diff ? `<p class="muted">${esc(diff)}</p>` : ''}</div>`;
  }
  const byId = Object.fromEntries(state.agents.map(a => [a.id, a]));
  const graph = !!job?.tasks?.some(x => x.kind === 'review'), gtasks = graph ? job.tasks : [];
  const depsOf = (x, i) => Array.isArray(x.dependsOn) ? x.dependsOn : i ? [i - 1] : [];
  // Task sửa tự động nằm cuối danh sách nhưng chạy trước node review của nó → tính độ sâu theo phụ thuộc, không theo chỉ số.
  const level = [], lv = (i, seen = new Set()) => level[i] ?? (seen.has(i) ? 0 : (seen.add(i), level[i] = depsOf(gtasks[i], i).filter(d => gtasks[d]).reduce((m, d) => Math.max(m, lv(d, seen) + 1), 0)));
  gtasks.forEach((x, i) => lv(i));
  const cols = graph ? Math.max(...level) + 1 : 1, colW = 190, shift = (cols - 1) * colW;
  const perCol = Array.from({ length: cols }, (_, c) => level.filter(l => l === c).length);
  const builders = graph ? [] : r.builders.filter(id => byId[id]), rowH = 68, top = graph ? 46 : 34;
  const H = Math.max(140, (graph ? Math.max(...perCol) : builders.length) * rowH + 20), cy = top + H / 2, W = 1260 + shift, nodes = {};
  const place = (key, x, y, w = 172) => nodes[key] = { x, y, w };
  place('user', 10, cy, 90);
  place('manager', 140, cy, 172);
  builders.forEach((id, i) => place('b:' + id, 365, cy + (i - (builders.length - 1) / 2) * rowH, 172));
  { const seen = Array(cols).fill(0); gtasks.forEach((x, i) => { const c = level[i], k = seen[c]++; place('t:' + i, 365 + c * colW, cy + (k - (perCol[c] - 1) / 2) * rowH, 172); }); }
  place('tests', 585 + shift, cy, 96);
  place('reviewer', 730 + shift, cy, 172);
  place('verifier', 945 + shift, cy, 172);
  place('merge', 1155 + shift, cy, 92);
  const tasksOf = id => (job?.tasks || []).map((x, i) => ({ ...x, n: i + 1 })).filter(x => (x.ranBy || x.agent) === id);
  const challenge = !readonly && (job?.stage === 'challenge' || runningOf(job).some(r => r.stage === 'challenge'));
  const runs = readonly ? [] : runningOf(job), live = new Set(runs.map(x => graph && x.task != null ? 't:' + x.task : nodeOfRun(x)));
  const active = new Set(job?.status === 'running' && runs.length ? (job.stage === 'implement' ? runs.map(r => 'manager>b:' + r.agent) : [{ plan: job.round ? 'rework' : 'user>manager', challenge: 'user>manager', test: 'b>tests', review: 'tests>reviewer', verify: 'reviewer>verifier', final: 'verifier>merge' }[job.stage]]) : []);
  if (challenge) { live.delete('reviewer'); live.add('manager'); active.delete('tests>reviewer'); active.delete('rework'); active.add('user>manager'); }
  if (!readonly && job?.status === 'running' && job.stage === 'test' && !runs.length) { live.add('tests'); active.add('b>tests'); }
  if (!readonly && job?.status === 'ready') live.add('merge');
  const edge = (a, b, cls, label = '') => {
    const A = nodes[a], B = nodes[b]; if (!A || !B) return '';
    const x1 = A.x + A.w, x2 = B.x, mx = (x1 + x2) / 2, on = active.has(`${a}>${b}`) || active.has('b>tests') && b === 'tests' && cls.includes('used');
    return `<path class="edge ${cls} ${on ? 'active' : ''}" d="M${x1} ${A.y} C${mx} ${A.y} ${mx} ${B.y} ${x2} ${B.y}"/>${label ? `<text class="edge-label task" x="${x2 - 6}" y="${B.y - 6}" text-anchor="end">${esc(label)}</text>` : ''}`;
  };
  const sub = id => {
    const a = byId[id]; if (!a) return t('ui.flow.notChosen');
    const h = agentHealth(a);
    return `${tierLabel(a.tier)} · ${h ? `${h.label}${h.rem != null ? ' ' + h.rem + '%' : ''}` : ((a.model || t('ui.flow.defaultModel')) + (a.effort ? '/' + a.effort : ''))}`;
  };
  const box = (key, title, subtitle, agentId, slot, task) => {
    const substitute = !readonly && job?.substitutes?.[key];
    if (substitute) subtitle += ' · ' + t('ui.flow.substitute', { from: names[substitute.from] || substitute.from });
    if (readonly) slot = null;
    const n = nodes[key], a = agentId && byId[agentId];
    const h = a ? agentHealth(a) : null;
    const cls = [
      substitute && 'substitute',
      (job ? live.has(key) : a?.state === 'working') && 'working',
      job && !live.has(key) && a?.state === 'working' && !runs.some(r => r.agent === agentId) && !(challenge && key === 'reviewer') && 'elsewhere', // cùng member đang chạy vai khác TRONG job này thì không phải 'nơi khác'
      filter && filter === agentId && 'filtered',
      agentId === null && 'missing',
      a && !a.enabled && 'disabled',
      h && `health-${h.cls}`
    ].filter(Boolean).join(' ');
    const healthDot = h ? `<circle cx="${n.w - 12}" cy="14" r="4.5" class="flow-dot ${h.cls}"><title>${esc(h.title)}</title></circle>` : '';
    const tip = a ? `${a.label} · ${rolesText(a.id)}\n${t('ui.health.title')}: ${h ? `${h.label} (${h.rem != null ? h.rem + '% quota' : '—'})` : '—'}${a.speed?.samples ? `\n${t('ui.members.speed', { time: duration(a.speed.avgMinutesPerCall), tokens: a.speed.avgTokensPerCall, n: a.speed.samples })}` : ''}\n${a.provider} · ${a.model || t('ui.flow.defaultModel')} · ${tierLabel(a.tier)}${a.enabled ? '' : ' · ' + t('ui.flow.disabled')}${job && !live.has(key) && a.state === 'working' ? '\n' + t('ui.flow.busyElsewhere') : ''}` : title;
    const titleW = n.w - (h ? 24 : 16);
    const subW = n.w - 16;
    const titleEl = svgText({ text: title, x: 10, y: 19, cls: 't', maxW: titleW, baseSize: 12, minSize: 9.5 });
    const subEl = svgText({ text: subtitle, x: 10, y: 37, cls: 's', maxW: subW, baseSize: 10.5, minSize: 7.8 });
    return `<g class="node ${cls}" ${slot ? `data-slot="${slot}" ${a ? `data-agent="${esc(agentId)}"` : ''} ${task != null ? `data-task="${task}"` : ''} role="button" tabindex="0"` : ''} transform="translate(${n.x},${n.y - 24})"><title>${esc(tip)}${substitute ? '\n' + esc(`${names[substitute.from] || substitute.from} → ${names[substitute.to] || substitute.to}`) : ''}</title><rect width="${n.w}" height="48" rx="8"/><rect class="ring" width="${n.w}" height="48" rx="8" pathLength="100"/>${healthDot}${titleEl}${subEl}</g>`;
  };
  const rv = nodes.reviewer, mg = nodes.manager, research = job?.kind === 'research', skipped = step => !!job?.skipped?.includes(step) || ['review', 'verify', 'final'].includes(step) && !!job?.flow?.requested?.steps && !job.flow.requested.steps.includes(step) && !job.flow.overrides?.some(o => o.step === step); // Manager đã bỏ (chưa bị ép lại)
  let edges = edge('user', 'manager', 'used');
  // Đồ thị: manager → task gốc, task → task phụ thuộc, task cuối (không ai phụ thuộc) → tests.
  gtasks.forEach((x, i) => {
    const deps = depsOf(x, i).filter(d => gtasks[d]), on = live.has('t:' + i) ? ' active' : '';
    if (!deps.length) edges += edge('manager', 't:' + i, 'used' + on);
    for (const d of deps) edges += edge('t:' + d, 't:' + i, 'used' + on);
    if (!gtasks.some((y, j) => depsOf(y, j).includes(i))) edges += edge('t:' + i, 'tests', 'used');
  });
  for (const id of builders) {
    const tasks = tasksOf(id), used = !job || tasks.length > 0;
    edges += edge('manager', 'b:' + id, used ? 'used' : 'idle', tasks.map(x => `T${x.n}·k${x.difficulty ?? '?'}${x.done ? '✓' : ''}`).join(' '));
    edges += edge('b:' + id, 'tests', used ? 'used' : 'idle');
  }
  edges += edge('tests', 'reviewer', challenge ? 'idle' : 'used') + edge('reviewer', 'verifier', challenge ? 'idle' : 'used') + edge('verifier', 'merge', 'used');
  edges += `<path class="edge rework ${job?.round && !challenge ? 'used' : ''} ${active.has('rework') ? 'active' : ''}" d="M${rv.x + rv.w / 2} ${rv.y - 24} C${rv.x + rv.w / 2} 4 ${mg.x + mg.w / 2} 4 ${mg.x + mg.w / 2} ${mg.y - 24}"/><text class="edge-label" x="${(rv.x + mg.x + mg.w) / 2}" y="14" text-anchor="middle">${esc(job?.round ? t('ui.flow.reworkRound', { n: job.round, max: state.limits?.rounds ?? 3 }) : t('ui.flow.rework'))}</text>`;
  // Người review/verify thực tế của job: đã chạy → Manager chọn (flow) → mặc định đội. Bước bị controller ép thêm ghi "bị ép".
  const mgId = (!readonly && job?.substitutes?.manager?.to) || r.manager;
  const rvId = (!readonly && job?.substitutes?.reviewer?.to) || job?.checkers?.reviewer || job?.override?.reviewer || job?.flow?.reviewer || r.reviewer, vfId = (!readonly && job?.substitutes?.verifier?.to) || job?.checkers?.verifier || job?.override?.verifier || job?.flow?.verifier || r.verifier;
  const forced = step => { const o = job?.flow?.overrides?.find(x => x.step === step); return o ? t('ui.flow.forced', { why: o.reasons.join('; ') }) : ''; };
  const named = (role, id) => `${role} · ${byId[id]?.label || '—'}`;
  const nodesSvg = box('user', t('ui.who.user'), t('ui.flow.goal')) + box('manager', named('Manager', mgId), challenge ? t('ui.results.challenge', { name: names[runs.find(x => x.stage === 'challenge')?.agent] || names[job?.current?.agent] || '—' }) : skipped('plan') ? t('ui.flow.fastPath') : sub(mgId), mgId || null, 'manager')
    + builders.map(id => box('b:' + id, named('Builder', id), sub(id), id, 'builder')).join('')
    + gtasks.map((x, i) => { const who = x.ranBy || x.agent, wait = depsOf(x, i).filter(d => gtasks[d] && !gtasks[d].done).map(d => 'T' + (d + 1)); return box('t:' + i, `T${i + 1} · ${x.kind === 'review' ? 'Review ' + depsOf(x, i).map(d => 'T' + (d + 1)).join(',') : x.auto ? t('ui.flow.fix') : 'Build'} · ${byId[who]?.label || '—'}`,
      readonly ? cut(x.instruction, 40) : (x.pinned && !x.done ? '📌 ' + t('ui.flow.pinned') + ' · ' : '') + (x.done ? (x.kind === 'review' ? '✓ ' + (x.note || x.verdict || '') : '✓') + (x.attempts ? ' · ' + t('ui.flow.attempts', { n: x.attempts }) : '') : live.has('t:' + i) ? t('ui.flow.running') : wait.length ? '⏳ ' + t('ui.flow.waitFor', { list: wait.join(', ') }) : x.attempts ? t('ui.flow.attempts', { n: x.attempts }) : cut(x.instruction, 40)), who || null, x.kind === 'review' ? 'reviewer' : 'builder', i); }).join('')
    + box('tests', 'Tests', research ? t('ui.flow.skipped') : t('ui.flow.testsBy')) + box('reviewer', named('Review', rvId), skipped('review') ? t('ui.flow.skipped') : forced('review') || sub(rvId), rvId || null, 'reviewer')
    + box('verifier', named('Verify', vfId), skipped('verify') ? t('ui.flow.skipped') : forced('verify') || sub(vfId), vfId || null, 'verifier') + box('merge', research ? t('ui.flow.conclusion') : t('ui.flow.approve'), job ? jobStatusLabel(job) : 'merge');
  // Mỗi cột là một đợt: task cùng cột chạy song song, cột sau chờ cột trước theo mũi tên.
  const waves = graph ? perCol.map((n, c) => `<text class="edge-label wave" x="${365 + c * colW + 86}" y="${top + 4}" text-anchor="middle">${esc(t(n > 1 ? 'ui.flow.waveParallel' : 'ui.flow.wave', { n: c + 1 }))}</text>`).join('') : '';
  const planTasks = plan && !graph ? `<ul class="task-list plan-tasks">${job.tasks.map((x, i) => `<li>${taskDetailHTML(job, x, i)}</li>`).join('')}</ul>` : '';
  $('flow').innerHTML = history + planTasks + (builders.length || r.manager || graph ? `<svg class="flow" viewBox="0 0 ${W} ${top + H + 6}" role="img" aria-label="${esc(t('ui.flow.aria'))}">${waves}${edges}${nodesSvg}</svg>` : `<p class="muted">${esc(t('ui.flow.empty'))}</p>`);
  document.querySelectorAll('[data-plan-version]').forEach(b => b.onclick = () => { const version = Number(b.dataset.planVersion); planView.version = version === latest.version ? null : version; drawState(); });
  // CSP cấm style="" trong markup; đặt qua CSSOM để vòng sáng không giật lại từ đầu mỗi lần vẽ lại.
  const phase = `-${(Date.now() % 2000) / 1000}s`; $('flow').querySelectorAll('rect.ring').forEach(x => { x.style.animationDelay = phase; });
  const inRoster = new Set([r.manager, r.reviewer, r.verifier, ...r.builders]);
  const bench = state.agents.filter(a => !inRoster.has(a.id));
  $('bench').innerHTML = `<button data-slot="builder" class="primary-ghost">${esc(t('ui.slot.addBuilder'))}</button>${bench.length ? `<span>${esc(t('ui.flow.bench'))}</span>${bench.map(a => {
    const h = agentHealth(a);
    return `<button data-bench="${esc(a.id)}" class="${a.state} bench-chip ${h ? 'health-' + h.cls : ''}" title="${esc(h ? h.title : a.label)}">${h ? `<span class="health-dot-inline ${h.cls}"></span>` : ''}<span>${esc(a.label)} · ${esc(tierLabel(a.tier))}</span>${h ? `<small class="bench-health ${h.cls}">${h.label}${h.rem != null ? ' ' + h.rem + '%' : ''}</small>` : ''}</button>`;
  }).join('')}` : ''}`;
  document.querySelectorAll('g[data-slot]').forEach(g => g.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); g.onclick(); } });
}
function taskDetailHTML(job, task, i, open = false) {
  const status = task.done ? 'done' : runningOf(job).some(r => r.task === i) ? 'running' : 'waiting';
  const context = typeof task.context === 'string' ? task.context : JSON.stringify(task.context || '', null, 2);
  return `<details data-task-detail="${i}" ${open ? 'open' : ''}><summary tabindex="0">T${i + 1} · ${esc(names[task.ranBy || task.agent] || task.ranBy || task.agent || t('ui.flow.notChosen'))} · ${esc(t('ui.results.task.' + status))} · ${esc(cut(task.instruction, 80))}</summary><p class="task-instruction">${esc(task.instruction)}</p><p class="muted">${esc(t('ui.inspector.difficulty', { n: task.difficulty ?? '?' }))}${task.estMinutes ? ' · ~' + esc(duration(task.estMinutes)) : ''}${task.dependsOn?.length ? ' · ' + esc(t('ui.inspector.after', { list: task.dependsOn.map(d => 'T' + (d + 1)).join(', ') })) : ''}</p>${task.why ? `<p>${esc(task.why)}</p>` : ''}${task.skills?.length ? `<p class="skill-tags">${task.skills.map(n => `<span class="tag">${esc(n)}</span>`).join(' ')}</p>` : ''}${context ? '<p><b>' + esc(t('ui.results.context')) + '</b></p><pre>' + esc(context) + '</pre>' : ''}${task.files?.length ? '<p><b>' + esc(t('ui.results.files')) + '</b></p><ul>' + task.files.map(f => '<li>' + esc(f) + '</li>').join('') + '</ul>' : ''}${task.contextGaps?.length ? `<p>${esc(t('ui.inspector.contextGaps', { n: task.contextGaps.length }))}</p><ul>${task.contextGaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}</details>`;
}
function drawInspector() {
  const job = state.jobs.find(j => j.id === selected);
  $('message').disabled = !!job && ['merged', 'cancelled'].includes(job.status) || !job && !curProject;
  if (!job) {
    // Chưa chọn việc mà nơi khác đang chạy: đưa lối tắt ngay giữa khung, khỏi phải đoán dự án/phiên.
    const live = state.jobs.filter(j => ['running', 'queued', 'waiting'].includes(j.status));
    $('inspector').innerHTML = `<div class="empty"><span class="empty-icon">⌁</span><b>${esc(t('ui.inspector.emptyTitle'))}</b><span>${esc(t('ui.inspector.emptyText'))}</span>${live.length ? `<p class="muted">${esc(t('ui.nav.runningElsewhere'))}</p>${live.slice(0, 5).map(j => `<button class="primary" data-goto="${esc(j.id)}">${esc(j.project)} · #${esc(j.id.slice(0, 8))} · ${esc(jobTitle(j))}</button>`).join('')}` : ''}</div>`;
    document.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => gotoJob(b.dataset.goto));
    return;
  }
  if ($('inspector').querySelector('[data-rename-input]')?.dataset.renameInput === job.id) return;
  const goalOpen = $('inspector').querySelector('[data-inspector-goal]')?.open;
  const stopped = ['blocked', 'paused'].includes(job.status), finished = ['merged', 'cancelled'].includes(job.status), idle = ['paused', 'blocked', 'ready'].includes(job.status);
  const research = job.kind === 'research';
  const br = job.status === 'blocked' && ['quota', 'transient'].includes(job.blockedReason?.kind) ? job.blockedReason : null;
  const quotaWait = br ? `<div class="questions quota-wait"><b>${esc(t(br.kind === 'transient' ? 'ui.quota.transientWait' : br.resetsAt ? 'ui.quota.wait' : 'ui.quota.waitUnknown', { agent: names[br.agent] || br.agent, provider: br.provider, time: br.resetsAt ? new Date(br.resetsAt).toLocaleTimeString(LOCALE_TAG[lang], { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }) : '' }))}</b><button class="primary" id="quota-replace">${esc(t('ui.quota.replaceNow'))}</button></div>` : '';
  const facts = [['Task', job.id], ...(job.kind ? [[t('ui.inspector.mode'), `${t('ui.kind.' + job.kind)} · ${t('ui.rigor.' + (job.rigor || 'standard'))}`]] : []), [t('ui.inspector.stage'), job.stage], ['Branch', job.branch], [t('ui.job.baseBranch'), job.baseBranch], ...(job.mergedInto ? [[t('ui.job.mergedInto'), `${job.mergedInto.branch} · ${job.mergedInto.commit} · ${job.mergedInto.mode}`]] : []), ['Commit', job.revision.slice(0, 12)], ['Worktree', job.worktree], ...(job.linked?.length ? [[t('ui.inspector.linked'), job.linked.map(l => `${l.project} · ${l.revision.slice(0, 8)}${l.revision !== l.base ? ' ✎' : ''}`).join(', ')]] : []), [t('ui.inspector.round'), `${job.round} / ${state.limits?.rounds ?? 3}`], ...(job.usage ? [[t('ui.inspector.usage'), t('ui.inspector.usageText', { calls: job.usage.calls, tokens: job.usage.tokens.toLocaleString(), limit: state.limits?.tokens ? ' / ' + state.limits.tokens.toLocaleString() : '' })]] : []), [t('ui.inspector.started'), clock(job.createdAt)], ...(job.metrics ? [[t('ui.inspector.debate'), Object.entries(job.metrics).map(([k, v]) => t('ui.metric.' + k) + ' ' + v).join(' · ')]] : []), ...(job.flow?.requested?.steps ? [[t('ui.inspector.flow'), job.flow.requested.steps.join(' → ') || '—']] : [])];
  // Tiến độ: bước đang chạy + ước tính dựa trên thời gian trung bình các bước agent trước đó.
  const progress = (() => {
    if (!['running', 'queued'].includes(job.status)) return '';
    const left = job.tasks.filter(x => !x.done).length, research = job.kind === 'research', light = job.rigor === 'light';
    const after = research ? (light ? 0 : 1) + (job.rigor === 'strict' ? 1 : 0) + 1 : 1 + (light ? 0 : 1) + 1;
    const steps = job.stage === 'plan' ? null : ({ implement: left + after, test: after, review: after, verify: 2, final: 1 })[job.stage] ?? after;
    const avg = job.durations?.length ? job.durations.reduce((a, b) => a + b, 0) / job.durations.length / 60000 : null;
    const cur = job.current, elapsed = cur ? (Date.now() - Date.parse(cur.startedAt)) / 60000 : null;
    const runs = runningOf(job);
    const lines = runs.length ? runs.map(r => `<div class="progress-run"><b>${esc(t('ui.progress.now', { stage: r.task != null ? `${t(research ? 'ui.kind.research' : 'ui.kind.code')} T${r.task + 1}/${job.tasks.length}` : r.stage, who: names[r.agent] || r.agent, time: duration((Date.now() - Date.parse(r.startedAt)) / 60000) }))}</b>${activityHTML(r, job)}</div>`) : [esc(t('ui.progress.queued'))];
    const predicted = avg * steps - (elapsed || 0);
    const eta = jobEta(job) || (steps == null ? t('ui.progress.planning') : avg ? predicted <= 0 ? t('ui.eta.over', { time: duration(-predicted) }) : t('ui.progress.eta', { time: duration(predicted), n: steps, avg: duration(avg) }) : t('ui.progress.noEta', { n: steps }));
    return `<div class="progress-box"><span class="dot green"></span><div>${lines.join('')}<span class="muted">${esc(eta)}</span>${job.waiting || state.resources.waitingReason ? `<br><span class="muted">${esc(job.waiting || state.resources.waitingReason)}</span>` : ''}</div></div>`;
  })();
  const attachments = job.attachments?.length ? `<p class="muted">📎 ${job.attachments.map(a => esc(a.split('/').pop())).join(', ')}</p>` : '';
  const waiting = job.status === 'waiting' ? job.planGate ? `<div class="questions plan-gate"><b>${esc(t('ui.plan.waiting', { v: job.planGate.version }))}</b><button type="button" class="primary" id="approve-plan">${esc(t('ui.plan.approve'))}</button><p id="plan-feedback-hint" class="muted">${esc(t('ui.plan.feedbackHint'))}</p><textarea id="answer" rows="4" aria-labelledby="plan-feedback-hint" placeholder="${esc(t('ui.question.placeholder'))}"></textarea><button class="primary-ghost" id="send-answer">${esc(t('ui.question.send'))}</button></div>` : `<div class="questions"><b>${esc(t('ui.question.title'))}</b><ol>${(job.questions || []).map(q => `<li>${esc(q)}</li>`).join('')}</ol><textarea id="answer" rows="4" placeholder="${esc(t('ui.question.placeholder'))}"></textarea><button class="primary" id="send-answer">${esc(t('ui.question.send'))}</button></div>` : '';
  const reworkOpen = $('inspector').querySelector('[data-rework-digest]')?.open;
  const digest = job.reworkDigest;
  const rework = digest ? `<details class="rework-digest" data-rework-digest ${reworkOpen ? 'open' : ''}><summary>${esc(t('ui.rework.title'))} · ${esc(t('ui.rework.summary', { rounds: digest.round, open: digest.open.length, scope: digest.scopeAdds }))}</summary><ol class="rework-rounds">${digest.rounds.map(round => `<li><p>${esc(t('ui.rework.round', { n: round.n, who: names[round.agent] || round.agent, verdict: round.verdict }))} · ${esc(round.stage)}</p><ul>${round.findings.map(finding => `<li><b>${esc(finding.id)}</b> ${esc(finding.claim)} <span class="tag ${finding.origin === 'owner' ? 'rework-owner' : ''}">${esc(t(finding.origin === 'owner' ? 'ui.rework.owner' : finding.origin === 'builder' ? 'ui.rework.builder' : 'ui.rework.unknown'))}</span>${finding.open ? ` <span class="tag rework-open">${esc(t('ui.rework.open'))}</span>` : ''}</li>`).join('')}</ul></li>`).join('')}</ol>${job.handoff ? `<p class="muted">${esc(t('ui.rework.handedOff'))}</p>` : ['blocked', 'waiting'].includes(job.status) ? `<div class="controls"><button type="button" class="primary" data-rework-extra>${esc(t('ui.rework.extraRound'))}</button><button type="button" data-rework-handoff>${esc(t('ui.rework.handoff'))}</button></div>` : ''}</details>` : '';
  const openTasks = new Set([...$('inspector').querySelectorAll('details[data-task-detail][open]')].map(d => Number(d.dataset.taskDetail)));
  const tasks = job.tasks.length ? '<ul class="task-list">' + job.tasks.map((x, i) => '<li>' + taskDetailHTML(job, x, i, openTasks.has(i)) + '</li>').join('') + '</ul>' : '';

  const openDiscussions = new Set([...$('inspector').querySelectorAll('details[data-discussion][open]')].map(d => d.dataset.discussion));
  const discussions = (job.discussions || []).map(d => `<details data-discussion="${esc(d.id)}" ${openDiscussions.has(d.id) ? 'open' : ''}><summary>${esc(d.id)} · ${esc(d.topic)} · ${esc(t('ui.peer.' + d.status))} (${d.rounds}/2)</summary><p class="muted">${esc(names[d.owner || d.from] || d.owner || d.from)} → ${esc(names[d.to] || d.to)} · ${esc(d.stage)}${d.task != null ? ' / T' + (d.task + 1) : ''}</p><p>${esc(d.claim)}</p>${d.assessment ? `<p><b>${esc(t('ui.peer.independent'))}</b><br>${esc(d.assessment.answer)}</p>` : ''}${(d.claims || []).map(c => `<p><b>${esc(c.id)}</b> · ${esc(c.statement)} · ${esc(c.status)}${c.judgment ? ' · ' + esc(t('ui.peer.' + c.judgment.transition)) : ''} <button data-score-thread="${esc(d.id)}" data-claim="${esc(c.id)}" ${['running','queued','merging'].includes(job.status) ? 'disabled' : ''}>${esc(t('ui.peer.score'))}</button></p>`).join('')}${(d.messages || []).map(m => `<p><b>${esc(m.id || '')}${m.replyTo ? ' → ' + esc(m.replyTo) : ''} · ${esc(names[m.by] || m.by)} · ${esc(t('ui.peer.' + m.type))}</b> ${esc((m.claimIds || []).join(', '))}<br>${esc(m.text)}</p>${m.evidence?.length ? `<ul>${m.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}<small class="muted">${esc(t('ui.peer.snapshot'))}: ${esc(m.snapshot?.commit?.slice(0, 12) || '—')} / ${esc(m.snapshot?.fingerprint?.slice(0, 12) || m.snapshot?.dirtyHash?.slice(0, 12) || '—')}</small>`).join('')}${d.evidence?.length ? `<ul>${d.evidence.map(e => `<li>${esc(e.id)} · ${esc(e.kind)} · ${esc(t('ui.peer.' + e.status))} · ${esc(e.source)}</li>`).join('')}</ul>` : ''}${d.decision ? `<p><b>${esc(t('ui.peer.' + d.decision.outcome))}</b><br>${esc(d.decision.choice || d.decision.reason)}<br>${esc(d.decision.reason)}</p><ul>${(d.decision.evidence || []).map(e => `<li>${esc(e)}</li>`).join('')}</ul>${d.decision.conditions?.length ? `<p>${esc(t('ui.peer.conditions'))}: ${esc(d.decision.conditions.join('; '))}</p>` : ''}${d.decision.remaining?.length ? `<p>${esc(t('ui.peer.obligations'))}: ${esc(d.decision.remaining.join('; '))}</p>` : ''}` : ''}${d.status !== 'resolved' && (idle || job.status === 'waiting') ? `<button data-obligation="${esc(d.id)}">${esc(t('ui.peer.map'))}</button>` : ''}</details>`).join('');
  const risk = job.risk ? `<p class="muted">${esc(t('ui.inspector.risk'))} <b class="${job.risk === 'high' ? 'risk-high' : ''}">${esc(t('ui.risk.' + job.risk))}</b>${job.riskReasons?.length ? ' · ' + esc(job.riskReasons.join('; ')) : ''}</p>` : '';
  const steps = research ? [['Plan', job.tasks.length], [t('ui.kind.research'), job.taskIndex >= job.tasks.length && job.tasks.length], ['Review', job.reviewed === job.revision || job.skipped?.includes('review')], [t('ui.flow.conclusion'), job.status === 'done']]
    : [['Plan', job.tasks.length], ['Code', job.revision !== job.base], ['Tests', job.tested === job.revision], ['Review', job.reviewed === job.revision || job.skipped?.includes('review')], ['Verify', job.verified === job.revision || job.skipped?.includes('verify')], ['Merge', job.status === 'merged']];
  const c = job.conclusion, conclusion = c ? `<div class="conclusion"><b>${esc(t('ui.inspector.conclusion'))}</b>${c.confidence ? ` <span class="tag">${esc(t('ui.inspector.confidence', { n: c.confidence }))}</span>` : ''}<p>${esc(c.conclusion)}</p>${c.sources?.length ? `<details><summary>${esc(t('ui.inspector.sources'))} (${c.sources.length})</summary><ul>${c.sources.map(s => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}${c.openQuestions?.length ? `<details><summary>${esc(t('ui.inspector.open'))} (${c.openQuestions.length})</summary><ul>${c.openQuestions.map(s => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}</div>` : '';
  $('inspector').innerHTML = `<h2 class="job-title" data-rename tabindex="0" role="button" title="${esc(t('ui.jobs.renameHint'))}">${esc(jobTitle(job))}</h2><details data-inspector-goal ${goalOpen ? 'open' : ''}><summary>${esc(t('ui.jobs.showGoal'))}</summary><p class="task-instruction">${esc(job.goal)}</p></details>${badge(job)}${tokenJobLink(job)}${quotaWait}${progress}${attachments}${waiting}${conclusion}<dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${tasks}${risk}<div class="pipeline">${steps.map(([label, done]) => { const sk = job.skipped?.includes(String(label).toLowerCase()); return `<span class="step ${done ? 'done' : ''} ${sk ? 'skipped' : ''}">${sk ? '–' : done ? '✓' : '○'} ${label}${sk ? ' · ' + esc(t('ui.flow.skipped')) : ''}</span>`; }).join('')}</div>${job.error ? `<p class="error-box">${esc(job.error)}</p>` : ''}${rework}<div class="controls"><button data-action="${stopped ? 'resume' : 'pause'}" ${finished ? 'disabled' : ''}>${esc(t(stopped ? 'ui.inspector.resume' : 'ui.inspector.pause'))}</button><button data-action="cancel" ${finished ? 'disabled' : ''}>${esc(t('ui.inspector.cancel'))}</button>${deletable(job) ? `<button data-action="delete">${esc(t('ui.inspector.delete'))}</button>` : ''}<button id="view-diff">${esc(t('ui.common.viewDiff'))}</button><button id="export-job" title="${esc(t('ui.mem.exportTitle'))}">${esc(t('ui.mem.export'))}</button><button data-action="review" ${idle ? '' : 'disabled'}>${esc(t('ui.inspector.rereview'))}</button>${research ? '' : `<button data-action="sync" ${idle ? '' : 'disabled'} title="${esc(t('ui.inspector.syncTitle', { branch: job.baseBranch }))}">${esc(t('ui.inspector.sync'))}</button>`}<select id="reassign" aria-label="${esc(t('ui.inspector.reassign'))}" ${!stopped ? 'disabled' : ''}><option value="">${esc(t('ui.inspector.reassign'))}…</option>${(job.roster || state.roster).builders.map(id => `<option value="${esc(id)}">${esc(names[id] || id)}</option>`).join('')}</select></div>${research ? '' : `<button id="merge" class="primary merge-button" ${job.status !== 'ready' ? 'disabled' : ''}>${esc(t('ui.inspector.merge', { branch: job.baseBranch }))}</button>`}<p class="muted">${esc(t('ui.inspector.note'))}</p>`;
  if ($('quota-replace')) $('quota-replace').onclick = () => openSlot(br.role, br.agent, br.task ?? undefined, job.id);
  const heading = $('inspector').querySelector('[data-rename]');
  const rename = () => {
    const input = document.createElement('input');
    input.className = 'job-title-input'; input.maxLength = 60; input.value = jobTitle(job);
    input.dataset.renameInput = job.id; input.setAttribute('aria-label', t('ui.jobs.renameHint'));
    heading.replaceWith(input); input.focus(); input.select();
    let finished = false;
    const finish = save => {
      if (finished) return; finished = true;
      const title = input.value.trim(); input.replaceWith(heading);
      if (save) attempt(async () => { await api(`jobs/${job.id}/control`, { action: 'rename', title }); await refresh(); });
    };
    input.onblur = () => finish(true);
    input.onkeydown = e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); finish(e.key === 'Enter'); heading.focus(); } };
  };
  heading.onclick = rename;
  heading.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rename(); } };
  if (discussions) $('inspector').insertAdjacentHTML('beforeend', `<h3>${esc(t('ui.peer.title'))}</h3>${discussions}`);
  const unmapped = (job.obligations || []).filter(o => o.status === 'unmapped');
  if (unmapped.length) $('inspector').insertAdjacentHTML('beforeend', `<h3>${esc(t('ui.peer.obligations'))}</h3>${unmapped.map(o => `<p>${esc(o.id)} · ${esc(o.topic)}<br>${esc((o.pending || []).map(m => m.text).join('; ') || o.reason)} <button data-obligation="${esc(o.id)}" ${['running','queued','merging'].includes(job.status) ? 'disabled' : ''}>${esc(t('ui.peer.map'))}</button></p>`).join('')}`);
  if (job.comparison) {
    const peers = state.jobs.filter(j => j.comparison?.group === job.comparison.group);
    $('inspector').insertAdjacentHTML('beforeend', `<h3>${esc(t('ui.peer.compare'))} · ${esc(job.comparison.group)}</h3><p class="muted">${esc(t('ui.peer.compareNote'))}</p><table><thead><tr><th>${esc(t('ui.peer.mode'))}</th><th>${esc(t('ui.peer.calls'))}</th><th>${esc(t('ui.peer.tokens'))}</th><th>${esc(t('ui.peer.wrongToRight'))}</th><th>${esc(t('ui.peer.rightToWrong'))}</th><th>${esc(t('ui.peer.unjudged'))}</th></tr></thead><tbody>${peers.map(j => { const labels = (j.discussions || []).flatMap(d => d.claims || []).map(c => c.judgment?.transition || 'unjudged'), n = k => labels.filter(x => x === k).length; return `<tr><td><button data-compare-job="${esc(j.id)}">${esc(t('ui.peer.' + j.dialogueMode))}</button><br>${esc(jobStatusLabel(j))}</td><td>${j.usage?.calls || 0}/${j.callBudget}</td><td>${j.usage?.tokens || 0}/${j.tokenBudget}</td><td>${n('wrongToRight')}</td><td>${n('rightToWrong')}</td><td>${labels.length ? n('unjudged') : '—'}</td></tr>`; }).join('')}</tbody></table>`);
    document.querySelectorAll('[data-compare-job]').forEach(b => b.onclick = () => gotoJob(b.dataset.compareJob));
  }
  document.querySelectorAll('[data-score-thread]').forEach(b => b.onclick = () => { scoreTarget = { job: job.id, thread: b.dataset.scoreThread, claim: b.dataset.claim }; $('claim-score-form').reset(); $('claim-score-dialog').showModal(); });
  document.querySelectorAll('[data-obligation]').forEach(b => b.onclick = () => {
    obligationTarget = { job: job.id, thread: b.dataset.obligation, imported: unmapped.some(o => o.id === b.dataset.obligation) };
    $('obligation-form').reset(); $('obligation-task').innerHTML = job.tasks.map((task, i) => task.kind === 'review' ? '' : `<option value="${i}">T${i + 1} · ${esc(cut(task.instruction, 70))}</option>`).join('');
    const r = job.roster || state.roster; $('obligation-recipient').innerHTML = [...new Set([r.manager, ...r.builders, r.reviewer, r.verifier].filter(Boolean))].map(id => `<option value="${esc(id)}">${esc(names[id] || id)}</option>`).join('');
    $('obligation-adopt').disabled = !job.tasks.length; $('obligation-dialog').showModal();
  });
  document.querySelectorAll('[data-action]').forEach(b => b.onclick = () => attempt(async () => {
    if (b.dataset.action === 'cancel' && !await ask(t('ui.inspector.confirmCancel'), { danger: true })) return;
    if (b.dataset.action === 'delete' && !await ask(t('ui.inspector.confirmDelete'), { ok: t('ui.inspector.delete'), danger: true })) return;
    b.disabled = true; try { if (b.dataset.action === 'delete') { if (!await deleteJob(selected)) return; selected = undefined; events = []; } else await api(`jobs/${selected}/control`, { action: b.dataset.action }); await refresh(); } finally { b.disabled = false; }
  }));
  $('inspector').querySelectorAll('[data-rework-extra], [data-rework-handoff]').forEach(b => b.onclick = () => attempt(async () => {
    const extra = b.hasAttribute('data-rework-extra');
    b.disabled = true; try { await api(`jobs/${job.id}/control`, extra ? { action: 'resume', extraRound: true } : { action: 'pause', handoff: true }); await refresh(); } finally { b.disabled = false; }
  }));
  $('reassign').onchange = () => attempt(async () => { if ($('reassign').value) await api(`jobs/${selected}/control`, { action: 'reassign', agent: $('reassign').value }); await refresh(); });
  $('view-diff').onclick = () => attempt(showDiff);
  $('export-job').onclick = () => { location.href = `/api/jobs/${encodeURIComponent(selected)}/export`; };
  const transfer = document.createElement('button'); transfer.textContent = t('ui.mem.transfer');
  transfer.disabled = ['running', 'queued', 'merging'].includes(job.status); transfer.title = t('ui.mem.transferTitle');
  transfer.onclick = () => { location.href = `/api/jobs/${encodeURIComponent(selected)}/transfer`; };
  $('export-job').after(transfer);
  $('inspector').querySelectorAll('.task-list > li').forEach((li, i) => {
    const task = job.tasks[i], point = task.checkpoint;
    const detail = li.querySelector('[data-task-detail]');
    if (point) detail.insertAdjacentHTML('beforeend', `<details><summary>${esc(t('ui.mem.checkpoint'))}</summary><p>${esc(point.done)}</p><p>${esc(point.remaining)}</p><p>${esc(point.next)}</p><pre>${esc(point.tests)}</pre>${point.failedAttempts?.length ? `<ul>${point.failedAttempts.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</details>`);
    if (task.memoryIds?.length) detail.insertAdjacentHTML('beforeend', `<small class="muted">${esc(t('ui.mem.used'))}: ${esc(task.memoryIds.join(', '))}</small>`);
  });
  if ($('merge')) $('merge').onclick = () => attempt(openMerge);
  if ($('send-answer')) $('send-answer').onclick = () => attempt(async () => { const v = $('answer').value.trim(); if (!v) return; await api(`jobs/${selected}/control`, { action: 'message', message: v }); await refresh(); });
  if ($('approve-plan')) $('approve-plan').onclick = () => attempt(async () => { const gate = state.jobs.find(j => j.id === selected)?.planGate; if (!gate) return; await api(`jobs/${selected}/control`, { action: 'approve-plan', version: gate.version, hash: gate.hash }); await refresh(); });
}
async function showDiff() { const result = await api(`jobs/${selected}/diff`); $('diff-content').textContent = result.diff || t('ui.diff.empty'); if (result.status) $('diff-content').textContent += '\n\nWorking tree:\n' + result.status; $('diff-dialog').showModal(); }
const evidenceURL = (id, path) => '/api/jobs/' + encodeURIComponent(id) + '/evidence-file?path=' + encodeURIComponent(path);
const evidenceLink = (id, path, label) => path ? `<a href="${esc(evidenceURL(id, path))}" target="_blank" rel="noopener">${esc(label)}</a>` : '';
function controllerTestHTML(id, check) {
  const command = Array.isArray(check.command) ? check.command.join(' ') : check.command;
  return `<div class="evidence-record"><span class="tag">${esc(t('ui.evidence.controller'))}</span>${Array.isArray(check.targeted) && check.targeted.length ? `<span class="tag">${esc(t('ui.evidence.targeted'))}</span><p>${esc(t('ui.evidence.targetedFiles', { files: check.targeted.join(', ') }))}</p>` : ''}<p><code>${esc(command)}</code></p><p class="${check.code === 0 ? 'evidence-pass' : 'evidence-fail'}">${esc(t('ui.evidence.exit', { code: check.code ?? '—' }))} · ${esc(t('ui.evidence.seconds', { n: Number.isFinite(check.ms) ? (check.ms / 1000).toFixed(2) : '—' }))}${check.project ? ' · ' + esc(check.project) : ''} · ${esc(clock(check.at))}</p>${evidenceLink(id, check.log, t('ui.evidence.openLog'))}${!check.log && check.output ? `<pre>${esc(check.output)}</pre>` : ''}</div>`;
}
function aiCheckHTML(report) {
  const text = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `<div class="evidence-record"><span class="tag">${esc(t('ui.evidence.ai'))}</span><p><b>${esc(report.stage)} · ${esc(names[report.agent] || report.agent)} · ${esc(report.verdict || '—')}</b></p>${report.findings?.length ? `<pre>${esc(text(report.findings))}</pre>` : ''}${report.tests ? `<p>${esc(t('ui.evidence.selfTests'))}</p><pre>${esc(text(report.tests))}</pre>` : ''}</div>`;
}
const resultsMergeChecks = new Map();
let resultsHTML;
const resultsKey = job => `${job.id}|${job.revision}|${job.status}`;
async function drawResults() {
  const id = selected, job = state?.jobs.find(j => j.id === id);
  $('conversation-title').textContent = t('ui.results.title'); $('chat-members').innerHTML = ''; $('event-count').textContent = '';
  if (!job) { resultsHTML = undefined; $('results-panel').textContent = t('ui.evidence.selectJob'); return; }
  const project = state.projects.find(p => p.id === job.project), session = state.sessions.find(s => s.id === job.sessionId);
  let changes = job.changes?.revision === job.revision ? job.changes : null, acceptance = { required: !!project?.preview && project.preview.requireAcceptance !== false, ok: job.acceptance?.revision === job.revision }, warning = '';
  let checking = false;
  if (job.status === 'ready' && job.kind !== 'research') {
    const key = resultsKey(job);
    let cached = resultsMergeChecks.get(key);
    if (!cached) {
      cached = {}; resultsMergeChecks.set(key, cached);
      // Register the pending check before fetching: merge-check itself emits SSE.
      api(`jobs/${encodeURIComponent(id)}/merge-check`).then(check => { cached.check = check; }, e => { cached.error = e.message; }).finally(() => {
        cached.done = true;
        if (tab === 'results' && selected === id && resultsKey(state.jobs.find(j => j.id === id) || {}) === key) attempt(drawResults);
      });
    }
    checking = !cached.done;
    if (cached.check) {
      const check = cached.check;
      changes = { added: check.added, removed: check.removed, files: check.paths || [] };
      acceptance.required = check.acceptance?.required ?? acceptance.required;
    }
    warning = cached.error || '';
  }
  if (tab !== 'results' || selected !== id) return;
  const stale = revision => revision !== job.revision ? `<span class="tag">${esc(t('ui.results.stale'))}</span>` : '';
  const source = key => `<span class="tag">${esc(t('ui.evidence.' + key))}</span>`;
  const items = job.evidence || [], images = [], other = [];
  for (const item of items) for (const f of item.files || []) {
    const file = typeof f === 'string' ? { path: f } : f, path = item.dir + '/' + file.path;
    const match = item.stage === 'preview' && /^(before|after)-(.+)-(desktop|mobile)\.png$/i.exec(file.path);
    if (match) images.push({ item, path, phase: match[1], route: match[2], viewport: match[3] });
    else other.push({ item, file, path });
  }
  images.sort((a, b) => a.route.localeCompare(b.route) || a.viewport.localeCompare(b.viewport) || b.phase.localeCompare(a.phase));
  const shownImages = images.filter(x => x.item.revision === job.revision);
  const verified = shownImages.some(x => x.phase === 'after' && x.item.agent === 'controller');
  const technical = job.tested === job.revision && ['review', 'verify'].every(stage => job.skipped?.includes(stage) || job[stage === 'review' ? 'reviewed' : 'verified'] === job.revision);
  const final = (job.reports || []).filter(r => r.stage === 'final').at(-1);
  const summary = job.kind === 'research' ? job.conclusion?.conclusion : final?.summary;
  const reports = ['review', 'verify'].map(stage => (job.reports || []).filter(r => r.stage === stage).at(-1)).filter(Boolean);
  const checks = job.checkResults || [], preview = job.preview, running = preview?.status === 'running' && preview.revision === job.revision;
  const configured = job.kind !== 'research' && !!project?.preview;
  const stats = checking ? t('ui.members.checking') : changes ? t('ui.results.stats', { n: changes.files?.length || 0, added: changes.added ?? '—', removed: changes.removed ?? '—' }) : '—';
  const level = (key, ok) => `<li class="${ok ? 'evidence-pass' : 'muted'}"><b>${esc(t('ui.results.' + key))}</b><span>${esc(t(ok ? 'ui.results.pass' : 'ui.results.pending'))}</span></li>`;
  // Job nghiên cứu: kết quả thật nằm trong các tài liệu evidence → đưa lên đầu, mỗi tên file lấy bản mới nhất.
  const docs = new Map();
  if (job.kind === 'research') for (const x of other) if (/\.(md|txt|csv|html)$/i.test(x.file.path)) { const name = x.file.path.split('/').pop(), old = docs.get(name); if (!old || Date.parse(x.item.at) >= Date.parse(old.item.at)) docs.set(name, x); }
  const docsHTML = docs.size ? `<section class="result-section"><h3>${esc(t('ui.results.docs'))}</h3><ul class="evidence-files">${[...docs.values()].map(x => `<li>${evidenceLink(id, x.path, x.file.path.split('/').pop())} <span class="muted">${esc(Math.round((x.file.bytes || 0) / 1024))} KB · ${esc(names[x.item.agent] || x.item.agent || '')}</span></li>`).join('')}</ul></section>` : '';
  const html = `<section class="result-section"><h3>${esc(t('ui.results.request'))}</h3><p class="muted">${esc(session?.name || '—')} · ${esc(job.project)}</p><p class="result-goal">${esc(jobTitle(job))}</p>${tokenJobLink(job)}<details><summary>${esc(t('ui.results.full'))}</summary><p class="task-instruction">${esc(job.goal)}</p></details></section>
    <section class="result-section"><h3>${esc(t('ui.results.changed'))}</h3>${source('ai')}${final ? stale(final.revision) : ''}<p>${esc(summary || '—')}</p><p><b>${esc(stats)}</b></p>${changes?.files?.length ? `<details><summary>${esc(t('ui.results.files'))}</summary><ul>${changes.files.map(f => `<li><code>${esc(f.path)}</code> +${esc(f.added ?? '—')} / −${esc(f.removed ?? '—')}</li>`).join('')}</ul></details>` : ''}<button type="button" id="results-diff">${esc(t('ui.common.viewDiff'))}</button></section>${docsHTML}
    <section class="result-section"><h3>${esc(t('ui.results.proof'))}</h3>${preview?.status === 'failed' || preview?.screenshots === false ? `<div class="error-box">${source('controller')} ${stale(preview.revision)}<p>${esc(preview.error || t(preview.screenshots === false ? 'ui.results.noChrome' : 'ui.results.previewFailed'))}</p>${other.filter(x => x.item.stage === 'preview' && x.item.revision === preview.revision && x.file.path.endsWith('preview.log')).map(x => evidenceLink(id, x.path, t('ui.evidence.openLog'))).join(' ')}</div>` : ''}
    <div class="result-images">${images.map(x => `<figure>${source(x.item.agent === 'controller' ? 'controller' : 'ai')}${stale(x.item.revision)}<figcaption>${esc(x.route)} · ${esc(t('ui.results.' + x.viewport))} · ${esc(t('ui.results.' + x.phase))}</figcaption><a href="${esc(evidenceURL(id, x.path))}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(evidenceURL(id, x.path))}" alt="${esc(x.route + ' · ' + t('ui.results.' + x.phase) + ' · ' + t('ui.results.' + x.viewport))}"></a></figure>`).join('')}</div>${!images.length ? `<p class="muted">${esc(t('ui.results.noImages'))}</p>` : ''}
    ${checks.map(c => `<div>${stale(c.revision)}<code>${esc(c.revision || '—')}</code>${controllerTestHTML(id, c)}</div>`).join('')}${reports.map(r => `<div>${stale(r.revision)}${aiCheckHTML({ ...r, findings: (r.findings || []).filter(f => !['resolved', 'closed'].includes(f.status) && f.resolved !== true) })}</div>`).join('')}
    <ul class="evidence-files">${other.map(x => `<li>${source(x.item.agent === 'controller' ? 'controller' : 'ai')}${stale(x.item.revision)} ${evidenceLink(id, x.path, x.file.path)}</li>`).join('')}</ul>
    ${job.acceptance ? `<p>${source('user')}${stale(job.acceptance.revision)} ${esc(clock(job.acceptance.at))}</p>` : ''}</section>
    <section class="result-section"><h3>${esc(t('ui.results.decision'))}</h3><ul class="result-levels">${level('technical', technical)}${level('verified', verified)}${level('accepted', job.acceptance?.revision === job.revision)}</ul>${warning ? `<p class="error-box">${esc(warning)}</p>` : ''}${acceptance.required && !acceptance.ok ? `<p class="error-box">${esc(t('ui.results.acceptRequired'))}</p>` : ''}<div class="controls">${running ? (preview.routes?.length ? preview.routes : [{ name: t('ui.results.openPreview'), path: '/' }]).map((r, i) => `<button type="button" data-result-route="${i}">${esc(t('ui.results.openPreview'))} · ${esc(r.name)}</button>`).join('') + `<button type="button" data-result-control="preview-stop">${esc(t('ui.results.stopPreview'))}</button>` : configured ? `<button type="button" data-result-control="preview-start" ${job.status === 'ready' ? '' : 'disabled'}>${esc(t('ui.results.restartPreview'))}</button>` : ''}<button type="button" data-result-control="accept" ${job.status === 'ready' ? '' : 'disabled'}>${esc(t('ui.results.accept'))}</button><button type="button" id="results-feedback" ${['merged', 'cancelled'].includes(job.status) ? 'disabled' : ''}>${esc(t('ui.results.feedback'))}</button>${job.kind !== 'research' ? `<button type="button" id="results-merge" class="primary" ${job.status !== 'ready' || acceptance.required && !acceptance.ok ? 'disabled' : ''}>${esc(t('ui.results.merge'))}</button>` : ''}</div></section>`;
  if (html !== resultsHTML) { $('results-panel').innerHTML = html; resultsHTML = html; }
  $('results-diff').onclick = () => $('view-diff')?.click();
  $('results-feedback').onclick = () => { $('message').focus(); $('message').scrollIntoView({ block: 'nearest' }); };
  if ($('results-merge')) $('results-merge').onclick = () => $('merge')?.click();
  $('results-panel').querySelectorAll('[data-result-route]').forEach(b => b.onclick = () => {
    const route = preview.routes?.[Number(b.dataset.resultRoute)]?.path || '/';
    window.open(preview.url.replace(/\/$/, '') + route, '_blank', 'noopener');
  });
  $('results-panel').querySelectorAll('[data-result-control]').forEach(b => b.onclick = () => attempt(async () => {
    const action = b.dataset.resultControl; b.disabled = true;
    try { await api(`jobs/${encodeURIComponent(id)}/control`, { action, ...(action === 'accept' ? { revision: job.revision, evidence: shownImages.map(x => x.path) } : {}) }); await refresh(); }
    finally { if (b.isConnected) b.disabled = false; }
  }));
}
let evidenceRequest = 0;
async function drawEvidence() {
  const id = selected, request = ++evidenceRequest, job = state?.jobs?.find(j => j.id === id);
  $('conversation-title').textContent = t('ui.evidence.title'); $('chat-members').innerHTML = ''; $('event-count').textContent = '';
  if (!job) { $('evidence-panel').textContent = t('ui.evidence.selectJob'); return; }
  let data;
  try { data = await api(`jobs/${encodeURIComponent(id)}/evidence`); }
  catch (e) { if (request === evidenceRequest && tab === 'evidence' && selected === id) $('evidence-panel').textContent = e.message; return; }
  if (request !== evidenceRequest || tab !== 'evidence' || selected !== id) return;
  const groups = new Map();
  const group = (revision, at) => {
    const key = revision || t('ui.common.unknown');
    if (!groups.has(key)) groups.set(key, { revision: key, at: 0, order: groups.size, checks: [], reports: [], items: [] });
    const g = groups.get(key); g.at = Math.max(g.at, Date.parse(at) || 0); return g;
  };
  for (const report of job.reports || []) if (['review', 'verify'].includes(report.stage)) group(report.revision, report.at).reports.push(report);
  for (const item of data.items || []) group(item.revision, item.at).items.push(item);
  for (const check of data.checkResults || []) group(check.revision, check.at).checks.push(check);
  $('evidence-panel').innerHTML = [...groups.values()].sort((a, b) => b.at - a.at || b.order - a.order).map(g => `<section class="evidence-revision"><h3>${esc(t('ui.evidence.revision'))} <code>${esc(g.revision)}</code></h3>${g.checks.map(c => controllerTestHTML(id, c)).join('')}${g.reports.map(aiCheckHTML).join('')}${g.items.map(item => `<div class="evidence-record"><p class="muted">${esc(item.stage)} · ${esc(names[item.agent] || item.agent)} · ${esc(clock(item.at))}</p><div class="evidence-images">${(item.files || []).filter(f => f.type === 'image').map(f => `<a href="${esc(evidenceURL(id, item.dir + '/' + f.path))}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(evidenceURL(id, item.dir + '/' + f.path))}" alt="${esc(f.path)}"><span>${esc(f.path)}</span></a>`).join('')}</div><ul class="evidence-files">${(item.files || []).filter(f => f.type !== 'image').map(f => `<li>${evidenceLink(id, item.dir + '/' + f.path, f.path)} <small class="muted">${esc(f.type)} · ${esc(f.bytes)} B</small></li>`).join('')}</ul></div>`).join('')}</section>`).join('') || `<p class="muted">${esc(t('ui.evidence.empty'))}</p>`;
}
let baseBranchesRequest = 0;
async function loadBaseBranches() {
  const id = $('project').value, request = ++baseBranchesRequest;
  $('base-branch').innerHTML = ''; $('base-branch').disabled = true; $('base-branch-error').hidden = true;
  if (!id) return;
  try {
    const data = await api(`projects/${encodeURIComponent(id)}/branches`);
    if (request !== baseBranchesRequest || $('project').value !== id) return;
    $('base-branch').innerHTML = (data.branches || []).map(branch => `<option value="${esc(branch)}">${esc(branch)}</option>`).join('');
    if (data.current) $('base-branch').value = data.current;
    $('base-branch').disabled = false;
  } catch (e) { if (request === baseBranchesRequest) { $('base-branch-error').textContent = e.message; $('base-branch-error').hidden = false; } }
}
let mergeJob, mergeCheck, mergeRequest = 0, mergeSending = false, resyncSending = false;
function mergeTarget() {
  const type = document.querySelector('input[name="merge-target"]:checked')?.value || 'base';
  return { type, branch: type === 'new' ? $('merge-new-branch').value.trim() : type === 'existing' ? $('merge-branch').value : state?.jobs?.find(j => j.id === mergeJob)?.baseBranch };
}
function updateMergeButton() {
  const c = mergeCheck, checks = c?.checks, target = mergeTarget();
  $('merge-go').disabled = mergeSending || !checks || c?.acceptance?.required && !c.acceptance.ok || !['tested', 'reviewed', 'verified', 'baseUnchanged', 'ready'].every(key => checks[key]) || !!c?.target?.error || target.type !== 'base' && (!c?.target || !target.branch) || !!c?.pendingMerge && c.pendingMerge.passed !== true || !!c?.needsConfirm && $('merge-confirm').value.trim() !== String(c.code);
  $('merge-go').disabled ||= resyncSending;
  $('merge-go').title = $('merge-go').disabled ? t(checks?.baseUnchanged === false ? 'ui.merge.blockedBase' : 'ui.merge.notStarted') : '';
}
async function refreshMergeCheck() {
  const id = mergeJob, target = mergeTarget(), request = ++mergeRequest;
  $('merge-error').textContent = ''; $('merge-error').hidden = true;
  mergeCheck = null; updateMergeButton();
  $('merge-branch').disabled = target.type !== 'existing'; $('merge-new-branch').disabled = target.type !== 'new';
  const c = await api(`jobs/${encodeURIComponent(id)}/merge-check?target=${encodeURIComponent(target.type)}&branch=${encodeURIComponent(target.branch || '')}`);
  if (request !== mergeRequest || mergeJob !== id || !$('merge-dialog').open) return;
  const job = state.jobs.find(j => j.id === id), branch = c.target?.branch || target.branch || job?.baseBranch;
  const checks = [...(c.acceptance?.required ? [[t('ui.results.accepted'), c.acceptance.ok]] : []), [t('ui.merge.tested'), c.checks?.tested], [t(c.checks?.reviewSkipped ? 'ui.merge.reviewSkipped' : 'ui.merge.reviewed'), c.checks?.reviewed], [t(c.checks?.verifySkipped ? 'ui.merge.verifySkipped' : 'ui.merge.verified'), c.checks?.verified], [t('ui.merge.baseUnchanged', { branch }), c.checks?.baseUnchanged]];
  const evidence = c.evidence, tests = Array.isArray(evidence?.controllerTests) ? evidence.controllerTests : [], files = Array.isArray(evidence?.files) ? evidence.files.reduce((n, item) => n + (item.files?.length || 0), 0) : evidence?.files ?? 0;
  const p = c.pendingMerge;
  const resync = c.checks?.baseUnchanged === false, recheck = resync || ['tested', 'reviewed', 'verified'].some(key => c.checks?.[key] === false);
  const busyTests = state.jobs.filter(j => j.id !== id && j.status === 'running' && j.stage === 'test').length;
  $('merge-check').innerHTML = `<p>${esc(t('ui.merge.summary', { code: c.code, branch, files: c.files, added: c.added, removed: c.removed }))}</p><p>${esc(t('ui.merge.risk'))} <b class="${c.risk === 'high' ? 'risk-high' : ''}">${esc(t('ui.risk.' + c.risk))}</b></p>${c.target?.mode ? `<p>${esc(t('ui.merge.targetMode'))}: <b>${esc(t('ui.merge.targetMode.' + c.target.mode))}</b></p>` : ''}${c.target?.error || target.type !== 'base' && !c.target ? `<p class="error-box" role="alert">${esc(c.target?.error || t('ui.merge.targetUnavailable'))}</p>` : ''}<ul class="check-list">${checks.map(([label, ok]) => `<li class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${esc(label)}</li>`).join('')}${(c.reasons || []).map(reason => `<li class="bad">⚠ ${esc(reason)}</li>`).join('')}</ul>${evidence ? `<section class="merge-evidence"><h3>${esc(t('ui.evidence.title'))} <code>${esc(evidence.revision)}</code></h3><p>${esc(t('ui.evidence.controller'))}: ${esc(t('ui.evidence.testCounts', { pass: tests.filter(x => x.code === 0).length, fail: tests.filter(x => x.code !== 0).length }))} · ${esc(t('ui.evidence.fileCount', { n: files }))}</p>${(evidence.aiChecks || []).map(report => `<p><span class="tag">${esc(t('ui.evidence.ai'))}</span> ${esc(report.stage)} · ${esc(names[report.agent] || report.agent)} · <b>${esc(report.verdict || '—')}</b></p>`).join('')}${evidence.warnNoControllerTest ? `<p class="evidence-warning" role="alert">${esc(t('ui.evidence.noControllerTest'))}</p>` : ''}<button type="button" id="merge-open-evidence">${esc(t('ui.evidence.view'))}</button></section>` : ''}${p ? `<section class="merge-pending"><h3>${esc(t('ui.merge.secondApproval'))}</h3><p><code>${esc(p.commit)}</code> · ${esc(p.target?.branch || p.target || branch)}</p><p class="${p.passed ? 'evidence-pass' : 'evidence-fail'}">${esc(t(p.passed ? 'ui.merge.pendingPassed' : 'ui.merge.pendingFailed'))}</p><div id="merge-pending-tests"></div><pre class="merge-pending-diff">${esc(p.diff || '')}</pre></section>` : ''}`;
  if (busyTests) $('merge-check').innerHTML += `<p class="evidence-warning merge-busy">${esc(t('ui.merge.busyTests', { n: busyTests }))}</p>`;
  if (recheck) {
    $('merge-check').innerHTML += `<section class="merge-resync"><p>${esc(t(resync ? 'ui.merge.resyncHint' : 'ui.merge.recheckHint', { branch: job?.baseBranch || branch }))}</p><button type="button" id="merge-resync">${esc(t(resync ? 'ui.merge.resync' : 'ui.merge.recheck'))}</button></section>`;
    const button = $('merge-resync');
    button.disabled = resyncSending || mergeSending || !['ready', 'paused', 'blocked'].includes(job?.status);
    button.onclick = async () => {
      if (button.disabled || resyncSending || mergeSending || !['ready', 'paused', 'blocked'].includes(state.jobs.find(j => j.id === id)?.status)) return;
      resyncSending = true; button.disabled = true; updateMergeButton();
      $('merge-error').textContent = ''; $('merge-error').hidden = true;
      try {
        await api(`jobs/${encodeURIComponent(id)}/control`, { action: resync ? 'sync' : 'review' });
        await refresh();
        const job = state.jobs.find(j => j.id === id);
        $('merge-dialog').close();
        notice(t('ui.merge.resyncStarted', { status: `${job?.status || 'queued'}/${job?.stage || 'test'}` }));
      } catch (e) {
        $('merge-error').textContent = e.message; $('merge-error').hidden = false;
      } finally {
        resyncSending = false;
        button.disabled = !['ready', 'paused', 'blocked'].includes(state.jobs.find(j => j.id === id)?.status);
        updateMergeButton();
      }
    };
  }
  $('merge-open-evidence')?.addEventListener('click', () => { $('merge-dialog').close(); selected = id; document.querySelector('[data-tab="evidence"]').click(); });
  $('merge-confirm-label').textContent = t('ui.merge.confirm', { code: c.code });
  $('merge-confirm').hidden = $('merge-confirm-label').hidden = !c.needsConfirm;
  $('merge-go').textContent = p ? t('ui.merge.approveUpdate', { branch }) : t(c.target?.mode === 'create' ? 'ui.merge.targetNew' : c.target?.mode === 'merge' ? 'ui.merge.targetMode.merge' : 'ui.merge.go');
  mergeCheck = c; updateMergeButton();
  if (p) {
    const data = await api(`jobs/${encodeURIComponent(id)}/evidence`);
    if (request === mergeRequest && mergeJob === id && $('merge-pending-tests')) $('merge-pending-tests').innerHTML = (data.checkResults || []).filter(test => test.revision === p.commit).map(test => controllerTestHTML(id, test)).join('');
  }
}
async function openMerge() {
  mergeJob = selected; mergeCheck = null; ++mergeRequest;
  $('merge-error').textContent = ''; $('merge-error').hidden = true;
  const job = state.jobs.find(j => j.id === mergeJob);
  document.querySelector('input[name="merge-target"][value="base"]').checked = true;
  $('merge-target-base').textContent = t('ui.merge.targetBase', { branch: job?.baseBranch || '—' });
  $('merge-branch').innerHTML = ''; $('merge-new-branch').value = ''; $('merge-confirm').value = '';
  $('merge-branch-error').hidden = true; $('merge-check').innerHTML = ''; updateMergeButton();
  $('merge-dialog').showModal();
  const id = mergeJob;
  await Promise.all([refreshMergeCheck(), (async () => {
    try {
      const data = await api(`projects/${encodeURIComponent(job.project)}/branches`);
      if (mergeJob === id) $('merge-branch').innerHTML = (data.branches || []).filter(branch => branch !== job.baseBranch).map(branch => `<option value="${esc(branch)}">${esc(branch)}</option>`).join('');
    } catch (e) { if (mergeJob === id) { $('merge-branch-error').textContent = e.message; $('merge-branch-error').hidden = false; } }
  })()]);
}
let profileId, profileModels = [], profileEfforts = [];
const effortLabel = e => dict['ui.effort.' + e] || fallback['ui.effort.' + e] || e;
// Mức suy luận theo model đang chọn (Codex) hoặc danh sách chung của CLI (Claude).
function fillEfforts(current) {
  const a = state.agents.find(x => x.id === profileId), id = $('profile-model').value === '__custom' ? $('profile-model-custom').value : $('profile-model').value;
  const model = profileModels.find(m => m.id === id) || profileModels.find(m => m.isDefault);
  let list = model?.efforts?.length ? model.efforts : profileEfforts;
  if (current && !list.includes(current)) list = [...list, current];
  $('profile-effort-box').hidden = !['codex', 'claude'].includes(a?.provider) || !list.length && !current;
  const def = model?.defaultEffort ? ` (${effortLabel(model.defaultEffort)})` : '';
  $('profile-effort').innerHTML = `<option value="">${esc(t('ui.profile.effortDefault'))}${esc(def)}</option>${list.map(e => `<option value="${esc(e)}">${esc(effortLabel(e))}</option>`).join('')}`;
  $('profile-effort').value = current || '';
}
function fillModels(models, current) {
  profileModels = models;
  $('profile-model').innerHTML = `<option value="">${esc(t('ui.profile.modelDefault'))}</option>${models.map(m => `<option value="${esc(m.id)}">${esc(m.label || m.id)}${m.isDefault ? ' · ' + esc(t('ui.profile.default')) : ''}</option>`).join('')}<option value="__custom">${esc(t('ui.profile.modelOther'))}</option>`;
  const known = !current || models.some(m => m.id === current);
  $('profile-model').value = known ? current || '' : '__custom'; $('profile-model-custom').value = known ? '' : current; $('profile-model-custom').hidden = known;
}
async function openProfile(id) {
  profileId = id; const a = state.agents.find(x => x.id === id);
  $('profile-mcp').value = a.mcp ? JSON.stringify(a.mcp, null, 2) : '';
  $('profile-cli').value = $('profile-cli').dataset.initial = a.auth?.cli || ''; $('profile-cli-note').textContent = t(a.auth?.cli ? 'ui.profile.cliFound' : 'ui.profile.cliMissing');
  $('profile-title').textContent = t('ui.profile.title', { name: a.label }); $('profile-name').value = a.label; $('profile-tier').value = a.tier; $('profile-enabled').checked = a.enabled; $('profile-prompt').value = a.systemPrompt;
  profileEfforts = []; fillModels([], a.model); fillEfforts(a.effort); $('profile-model-note').textContent = t('ui.profile.loadingModels'); $('profile-dialog').showModal();
  try { const r = await api(`members/${id}/models`, {}); if (profileId === id) { profileEfforts = r.efforts || []; const keep = $('profile-effort').value; fillModels(r.models, a.model); fillEfforts(keep); $('profile-model-note').textContent = r.note || t('ui.profile.modelsFromCli', { n: r.models.length }); } }
  catch (e) { $('profile-model-note').textContent = t('ui.profile.modelsFailed', { error: e.message }); }
}
// Trạng thái đăng nhập nằm trong bộ nhớ server; mở màn thành viên thì hỏi lại CLI cho các member chưa kết nối.
let checking = false;
async function recheckMembers(ids) {
  if (checking || !state || state.demo) return; checking = true;
  try {
    for (const a of state.agents.filter(a => (ids ? ids.includes(a.id) : true) && !['connected', 'starting', 'pending', 'terminal'].includes(a.auth?.status))) {
      await api(`members/${a.id}/refresh`, {}).catch(() => { });
    }
    await refresh();
  } finally { checking = false; }
}
// Khung trao đổi kiểu chat nhóm: mọi thành viên trong luồng, tin của Bạn bên phải, hoạt động kỹ thuật thu gọn ở giữa.
const SYSTEM_TYPES = ['ACTIVITY', 'DIAGNOSTIC', 'TEST_OUTPUT', 'TEST_START', 'USAGE', 'RATE_LIMIT'];
const DECISION_TYPES = ['QUESTION', 'ORACLE_QUESTION', 'ORACLE_ANSWER', 'CONCLUSION', 'DECISION', 'PEER_QUESTION', 'PEER_REPLY', 'PEER_DECISION', 'PEER_UNRESOLVED', 'PEER_HANDOVER', 'PEER_REOPENED', 'PEER_SCORE', 'BLOCKER', 'REWORK_REQUEST', 'REVIEW_RESULT', 'READY_FOR_MERGE', 'MERGED', 'REROUTE', 'REASSIGN', 'REQUEUE', 'CONFLICT', 'WARNING'];
const hueClass = id => 'hue-' + [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 8, 3);
const evLabel = type => dict['ui.ev.' + type] || fallback['ui.ev.' + type] || type;
function avatar(id) {
  const name = names[id] || id, letter = id === 'controller' ? '⚙' : ((String(name).match(/\p{L}|\d/u)?.[0] || '?') + (String(name).match(/\d+$/)?.[0] || '')).toUpperCase().slice(0, 3);
  const a = state?.agents?.find(x => x.id === id);
  const h = a ? agentHealth(a) : null;
  return `<span class="avatar-wrap"><span class="chat-avatar ${id === 'controller' ? 'sys' : hueClass(id)}" title="${esc(name)}">${esc(letter)}</span>${h ? `<span class="health-dot ${h.cls}" title="${esc(h.title)}"></span>` : ''}</span>`;
}
function drawTimeline() {
  const evidence = tab === 'evidence', results = tab === 'results';
  $('results-panel').hidden = !results;
  if (results) { $('timeline').hidden = true; $('evidence-panel').hidden = true; attempt(drawResults); return; }
  $('timeline').hidden = evidence; $('evidence-panel').hidden = !evidence;
  if (evidence) { attempt(drawEvidence); return; }
  const filtered = events.filter(e => (!filter || e.from === filter || e.to === filter) && (tab === 'all' || tab === 'activity' && SYSTEM_TYPES.concat('TEST_RESULT', 'CHECKPOINT').includes(e.type) || tab === 'decisions' && DECISION_TYPES.includes(e.type) || tab === 'messages' && !SYSTEM_TYPES.includes(e.type)));
  $('event-count').textContent = t('ui.timeline.count', { n: events.length });
  $('conversation-title').textContent = filter ? t('ui.timeline.with', { name: names[filter] }) : t('ui.timeline.title');
  const job = state?.jobs.find(j => j.id === selected), r = job?.roster || state?.roster;
  const people = r ? [...new Set([r.manager, ...r.builders, r.reviewer, r.verifier].filter(Boolean))] : [];
  $('chat-members').innerHTML = people.map(id => {
    const a = state?.agents?.find(x => x.id === id);
    const h = a ? agentHealth(a) : null;
    const working = a?.state === 'working' ? 'working' : '';
    const healthBadge = h ? `<span class="health-pill ${h.cls}" title="${esc(h.title)}">${esc(h.label)}${h.rem != null ? ' ' + h.rem + '%' : ''}</span>` : '';
    return `<button class="chat-person ${filter === id ? 'on' : ''} ${working} ${h ? 'health-' + h.cls : ''}" data-person="${esc(id)}" title="${esc(h?.title || names[id] || id)}">${avatar(id)}<span class="chat-person-info"><span class="chat-person-name">${esc(names[id] || id)}</span><small class="chat-person-sub">${esc(rolesText(id))}${h ? ' · ' + healthBadge : ''}</small></span></button>`;
  }).join('') + (filter ? `<button class="chat-person" data-person="">${esc(t('ui.team.showAll'))}</button>` : '');
  document.querySelectorAll('[data-person]').forEach(b => b.onclick = () => { filter = b.dataset.person && filter !== b.dataset.person ? b.dataset.person : null; drawTimeline(); });
  const timeline = $('timeline'), atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
  const opened = new Set([...timeline.querySelectorAll('details[open]')].map(e => e.dataset.seq));
  const time = e => new Date(e.timestamp).toLocaleTimeString(LOCALE_TAG[lang], { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const details = e => (['TASK_ASSIGNMENT', 'REVIEW_REQUEST'].includes(e.type) && e.details?.prompt ? `<button type="button" data-view-prompt="${esc(e.seq)}">${esc(t('ui.prompt.view'))}</button>` : '') + (e.details ? `<details data-seq="${e.seq}" ${opened.has(String(e.seq)) ? 'open' : ''}><summary>${esc(t('ui.timeline.details'))}</summary><pre>${esc(JSON.stringify(e.details, null, 2))}</pre></details>` : '');
  timeline.innerHTML = filtered.length ? filtered.map(e => {
    if (e.type === 'PROMPT_BUDGET') return `<article class="prompt-warning" role="alert"><strong>${esc(t('ui.prompt.over'))}</strong><p>${esc(e.summary)}</p><time>${time(e)}</time>${details(e)}</article>`;
    if (['ORACLE_QUESTION', 'ORACLE_ANSWER'].includes(e.type)) return `<article class="chat-msg"><div class="chat-body"><div class="chat-head"><strong>${esc(names[e.from] || e.from)}</strong><span class="chat-to">→ ${esc(names[e.to] || e.to)}</span><span class="chat-type">${esc(evLabel(e.type))}</span><time>${time(e)}</time></div><div class="chat-bubble">${esc(cut(e.summary || evLabel(e.type), 200))}</div><details data-seq="${e.seq}" ${opened.has(String(e.seq)) ? 'open' : ''}><summary>${esc(t('ui.timeline.details'))}</summary><pre>${esc(e.type === 'ORACLE_QUESTION' ? e.details?.question : e.details?.answer)}</pre></details></div></article>`;
    if (SYSTEM_TYPES.includes(e.type)) return `<div class="chat-system"><span class="chat-type">${esc(evLabel(e.type))}</span><b>${esc(names[e.from] || e.from)}</b> ${esc(cut(e.summary, 300))}<time>${time(e)}</time>${details(e)}</div>`;
    const mine = e.from === 'user', cls = [mine && 'mine', e.from === 'controller' && 'from-system', e.type === 'BLOCKER' && 'alert', e.type === 'QUESTION' && 'question', ['READY_FOR_MERGE', 'MERGED'].includes(e.type) && 'success'].filter(Boolean).join(' ');
    return `<article class="chat-msg ${cls}">${mine ? '' : avatar(e.from)}<div class="chat-body"><div class="chat-head"><strong>${esc(names[e.from] || e.from)}</strong><span class="chat-to">→ ${esc(names[e.to] || e.to)}</span><span class="chat-type">${esc(evLabel(e.type))}</span><time>${time(e)}</time></div><div class="chat-bubble">${esc(e.summary)}</div>${details(e)}</div></article>`;
  }).join('') : `<div class="empty"><span class="empty-icon">◎</span><b>${esc(t('ui.timeline.emptyTitle'))}</b><span>${esc(t('ui.timeline.emptyText'))}</span></div>`;
  timeline.querySelectorAll('[data-view-prompt]').forEach(b => b.onclick = () => openCallPrompt(events.find(e => String(e.seq) === b.dataset.viewPrompt)));
  // Agent đang chạy: bong bóng "đang soạn" ba chấm.
  // Chỉ AI đang chạy cho đúng việc đang xem; việc khác cùng phiên đã hiện ở sơ đồ (viền đứt "đang làm việc khác").
  const sessionRuns = job ? runningOf(job).map(r => ({ ...r, job: job.id })) : [];
  for (const cur of sessionRuns) if (!filter || filter === cur.agent) timeline.insertAdjacentHTML('beforeend', `<article class="chat-msg typing">${avatar(cur.agent)}<div class="chat-body"><div class="chat-head"><strong>${esc(names[cur.agent] || cur.agent)}</strong><span class="chat-to">${cur.job !== job.id ? `#${esc(cur.job.slice(0, 8))} · ` : ''}${esc(t('ui.chat.typing', { stage: cur.task != null ? `${cur.stage} T${cur.task + 1}` : cur.stage }))}</span></div><div class="chat-bubble"><span class="dots"><i></i><i></i><i></i></span></div></div></article>`);
  if (atBottom) timeline.scrollTop = timeline.scrollHeight;
}
let memberView = store.get('memberView') || 'compact';
function setMemberView(mode) {
  memberView = mode === 'detailed' ? 'detailed' : 'compact';
  store.set('memberView', memberView);
  const compactEl = $('quota-compact'), cardsEl = $('quota-cards');
  if (compactEl) compactEl.hidden = memberView !== 'compact';
  if (cardsEl) cardsEl.hidden = memberView !== 'detailed';
  $('view-mode-compact')?.classList.toggle('selected', memberView === 'compact');
  $('view-mode-detailed')?.classList.toggle('selected', memberView === 'detailed');
}

function drawQuota() {
  $('demo-live-link').hidden = !state.demo;
  const check = state.quotaCheck;
  $('refresh-quota').textContent = check?.running ? t('ui.quota.checkingProgress', { done: check.done, total: check.total }) : t('ui.members.refreshQuota');
  $('refresh-quota').setAttribute('aria-busy', String(!!check?.running));
  const quotaChip = a => {
    const m = check?.members?.[a.id];
    if (!m) return '';
    const reason = String(m.reason || '');
    let text;
    switch (m.status) {
      case 'checking': text = t('ui.quota.st.checking'); break;
      case 'ok': text = t('ui.quota.st.ok') + ' · ' + clock(m.at); break;
      case 'error': text = t('ui.quota.st.error') + (reason ? ' · ' + reason.slice(0, 80) : ''); break;
      case 'timeout': text = t('ui.quota.st.timeout'); break;
      case 'skipped-busy': text = reason === 'no-reader' ? t('ui.quota.st.noReader') : t('ui.quota.st.busy', { time: m.observedAt ? clock(m.observedAt) : '—' }); break;
      default: return '';
    }
    return `<span class="quota-chip quota-chip-${esc(m.status)}"${m.status === 'error' ? ` title="${esc(reason)}"` : ''}>${esc(text)}</span>`;
  };

  // 1. Draw Compact 1-line rows
  $('quota-compact').innerHTML = state.agents.map(a => {
    const auth = a.auth || { status: 'unknown' }, connected = ['connected', 'cached'].includes(auth.status);
    const tag = a.provider === 'mock' ? t('ui.members.mock') : a.provider === 'antigravity' ? 'Gemini Pro' : a.provider;
    const info5h = quota5hInfo(a.quota);
    const w = info5h?.window;
    let remText, cls = '', subText, progressVal = 0;
    if (w && Number.isFinite(w.remaining)) {
      const rem = Math.max(0, Math.min(100, Math.round(w.remaining)));
      const used = Math.max(0, Math.min(100, Math.round(w.used != null ? w.used : (100 - rem))));
      remText = t('ui.quota.windowRemaining', { n: rem });
      cls = rem <= 15 ? 'danger' : rem <= 40 ? 'warning' : '';
      progressVal = rem;
      const resetPart = w.resetText || (w.resetsAt ? clock(w.resetsAt) + untilReset(w.resetsAt) : t('ui.quota.window', { time: duration(w.minutes || 300) }));
      const usedPart = t('ui.quota.used', { n: used });
      subText = [usedPart, resetPart].filter(Boolean).join(' · ');
    } else if (a.quota.error) {
      remText = 'Error'; cls = 'danger'; subText = a.quota.error; progressVal = 0;
    } else {
      remText = '—'; cls = 'unknown'; subText = t('ui.members.quotaNotMeasured'); progressVal = 0;
    }
    const factsShort = [a.model || t('ui.profile.modelDefault'), tierLabel(a.tier), a.speed?.samples && `~${duration(a.speed.avgMinutesPerCall)}/${a.speed.avgTokensPerCall >= 1000 ? Math.round(a.speed.avgTokensPerCall / 1000) + 'K' : a.speed.avgTokensPerCall} tok`].filter(Boolean).join(' · ');

    return `<article class="compact-row" data-agent-row="${esc(a.id)}">
      <div class="compact-col-agent">
        <div class="compact-title">
          <i class="dot ${connected ? 'green' : ''}"></i>
          <strong class="compact-name">${esc(a.label)}</strong>
          <span class="tag">${esc(tag)}</span>
          ${auth.sharedProfile ? `<span class="tag">shared</span>` : ''}
        </div>
        <div class="compact-sub" title="${esc(auth.account?.email || a.quota.account?.email || '')}">
          ${esc(auth.account?.email || a.quota.account?.email || rolesText(a.id))}
        </div>
      </div>
      <div class="compact-col-role">
        ${(rolesOf(a.id).length ? rolesOf(a.id) : ['none']).map(k => `<span class="badge-role ${k}">${esc(roleLabel(k))}</span>`).join(' ')}
        <div class="compact-sub">${esc(factsShort)}</div>
      </div>
      <div class="compact-col-quota">
        ${quotaChip(a)}
        <div class="quota-5h-bar">
          <div class="quota-5h-label">
            <span class="quota-5h-title">${esc(t('ui.members.quota5h'))}</span>
            <strong class="quota-5h-val ${cls}">${esc(remText)}</strong>
          </div>
          <progress max="100" value="${progressVal}" class="${cls}"></progress>
          <span class="quota-5h-sub">${esc(subText)}</span>
        </div>
      </div>
      <div class="compact-col-actions">
        <details class="actions-dropdown">
          <summary class="action-btn">
            <span>${esc(t('ui.members.actionsMenu'))}</span>
            <span class="caret">▾</span>
          </summary>
          <div class="actions-menu">
            <div class="actions-menu-header">
              <strong>${esc(a.label)}</strong>
              <small class="tag">${esc(tag)}</small>
            </div>
            <div class="actions-menu-divider"></div>
            <button class="menu-item" data-check="${esc(a.id)}">⚡ ${esc(t('ui.login.check'))}</button>
            <button class="menu-item" data-profile="${esc(a.id)}">👤 ${esc(t('ui.members.profile'))}</button>
            ${a.provider === 'claude' ? `
            <button class="menu-item" data-term="${esc(a.id)}">💻 ${esc(t('ui.members.openTerminal'))}</button>` : ''}
            <button class="menu-item" data-login="${esc(a.id)}">🔑 ${esc(t(state.demo ? 'ui.members.loginLive' : connected ? 'ui.members.relogin' : 'ui.login.start'))}</button>
            <div class="actions-menu-divider"></div>
            <div class="menu-role-select">
              <label>${esc(t('ui.members.roles'))}</label>
              ${roleChecks(a)}
            </div>
            <div class="actions-menu-divider"></div>
            <button class="menu-item" data-view-detail="${esc(a.id)}">🔍 ${esc(t('ui.members.viewDetailed'))}</button>
          </div>
        </details>
      </div>
    </article>`;
  }).join('');

  // 2. Draw Detailed cards
  $('quota-cards').innerHTML = state.agents.map(a => {
    const auth = a.auth || { status: 'unknown' }, connected = ['connected', 'cached'].includes(auth.status);
    const tag = a.provider === 'mock' ? t('ui.members.mock') : a.provider === 'antigravity' ? 'Gemini Pro' : a.provider;
    const actions = state.demo ? '' : `<button data-check="${esc(a.id)}">${esc(t('ui.login.check'))}</button><button data-profile="${esc(a.id)}">${esc(t('ui.members.profile'))}</button>${a.provider === 'claude' ? `<button data-term="${esc(a.id)}">${esc(t('ui.members.openTerminal'))}</button>` : ''}`;
    const model = a.provider === 'antigravity' && a.model;
    const rawBuckets = model ? a.quota.buckets?.filter(b => String(b.id).startsWith('3p-') !== /^gemini/i.test(model)) : a.quota.buckets;
    const cleanBuckets = dedupeBuckets(rawBuckets || []);
    const winItems = cleanBuckets.flatMap(b => (b.windows || []).map(w => {
      const raw = `${b.id || ''} ${b.name || ''} ${w.name || ''}`.toLowerCase();
      const is5h = w.minutes === 300 || /five[_\s-]*hour|session|\b5h\b/i.test(raw);
      const isWeekly = w.minutes === 10080 || /seven[_\s-]*day|week|\b7d\b/i.test(raw);
      const minutes = w.minutes ?? (is5h ? 300 : (isWeekly ? 10080 : null));
      let bName = b.name.replace(/-(5h|weekly|session)$/i, '').replace(/[:\s]+$/, '');
      return { b, w, minutes, bName, rank: is5h ? 1 : (isWeekly ? 2 : 3) };
    }));
    winItems.sort((x, y) => x.rank - y.rank);
    const windows = winItems.map(({ b, w, minutes, bName }) => {
      const winLabel = minutes ? `${esc(bName)} · ${esc(t('ui.quota.window', { time: duration(minutes) }))}` : (w.name && w.name !== 'used' && w.name !== 'quota' ? `${esc(bName)} · ${esc(w.name)}` : esc(bName));
      const remVal = w.remaining == null ? null : Math.max(0, Math.min(100, Math.round(w.remaining)));
      const usedVal = remVal == null ? null : Math.max(0, Math.min(100, Math.round(w.used != null ? w.used : (100 - remVal))));
      const remLabel = remVal == null ? '?' : `${t('ui.quota.windowRemaining', { n: remVal })} (${t('ui.quota.used', { n: usedVal })})`;
      return `<div class="quota-window"><label><span>${winLabel}</span><strong>${esc(remLabel)}</strong></label><progress max="100" value="${remVal ?? 0}"></progress><small>${esc(t('ui.quota.reset'))} ${w.resetText ? esc(w.resetText) : esc(clock(w.resetsAt) + untilReset(w.resetsAt))}</small></div>`;
    }).join('');
    const sp = a.speed?.samples ? t('ui.members.speed', { time: duration(a.speed.avgMinutesPerCall), tokens: a.speed.avgTokensPerCall >= 1000 ? Math.round(a.speed.avgTokensPerCall / 1000) + 'K' : a.speed.avgTokensPerCall, n: a.speed.samples }) : t('ui.members.speedUnknown');
    const mcpNames = Object.keys(a.mcp || {});
    const facts = [sp, mcpNames.length && 'MCP: ' + mcpNames.join(', '), t('ui.members.model', { model: (a.model || t('ui.profile.modelDefault')) + (a.effort ? ` · ${effortLabel(a.effort)}` : '') }), t('ui.members.tier', { tier: tierLabel(a.tier) }), !a.enabled && t('ui.members.disabled'), a.systemPrompt && t('ui.members.hasPrompt')].filter(Boolean).join(' · ');
    return `<article class="quota-card" data-agent-card="${esc(a.id)}"><h3>${esc(a.label)} <span class="tag">${esc(tag)}</span></h3><span class="muted">${esc(auth.account?.email || a.quota.account?.email || rolesText(a.id))}</span><div class="account-state ${connected ? 'connected' : ''}"><i class="dot ${connected ? 'green' : ''}"></i>${esc(auth.message || t('ui.members.notChecked'))}</div>${auth.sharedProfile ? `<span class="muted">${esc(t('ui.members.sharedProfile'))}</span>` : ''}${auth.cli ? `<span class="muted">CLI: ${esc(auth.cli)}</span>` : ''}<div class="member-actions"><button class="${connected ? '' : 'primary'}" data-login="${esc(a.id)}">${esc(t(state.demo ? 'ui.members.loginLive' : connected ? 'ui.members.relogin' : 'ui.login.start'))}</button>${actions}</div>${state.demo ? '' : roleChecks(a)}<span class="muted">${esc(facts)}</span><strong>${esc(quotaRemaining(a.quota))}</strong>${quotaChip(a)}${a.quota.error ? `<p class="error-box">${esc(a.quota.error)}</p>` : ''}${a.quota.note ? `<p class="muted">${esc(a.quota.note)}</p>` : ''}${a.quota.schemaUnknown ? `<p class="error-box">${esc(t('ui.quota.schemaUnknown'))}</p>` : ''}${windows}<span class="muted">${esc(t('ui.quota.updated', { time: clock(a.quota.checkedAt) }))}</span>${a.quota.raw ? `<details><summary>${esc(t('ui.quota.raw'))}</summary><pre>${esc(JSON.stringify(a.quota.raw, null, 2))}</pre></details>` : ''}</article>`;
  }).join('');

  setMemberView(memberView);

  $('view-mode-compact').onclick = () => setMemberView('compact');
  $('view-mode-detailed').onclick = () => setMemberView('detailed');
  document.querySelectorAll('[data-view-detail]').forEach(b => b.onclick = () => {
    setMemberView('detailed');
    const card = document.querySelector(`[data-agent-card="${b.dataset.viewDetail}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('highlight-pulse');
      setTimeout(() => card.classList.remove('highlight-pulse'), 1500);
    }
  });

  document.querySelectorAll('.actions-dropdown .menu-item').forEach(b => {
    b.addEventListener('click', () => {
      const d = b.closest('.actions-dropdown');
      if (d) d.removeAttribute('open');
    });
  });

  document.querySelectorAll('[data-login]').forEach(b => b.onclick = () => {
    if (state.demo) { location.href = 'http://127.0.0.1:3333/?members=1&member=' + encodeURIComponent(b.dataset.login); return; }
    loginId = b.dataset.login; drawLogin(); $('login-dialog').showModal(); recheckMembers([loginId]);
  });
  document.querySelectorAll('[data-check]').forEach(b => b.onclick = () => attempt(async () => { b.disabled = true; await api(`members/${b.dataset.check}/refresh`, {}); await refresh(); }));
  document.querySelectorAll('[data-term]').forEach(b => b.onclick = () => attempt(async () => { await api(`members/${b.dataset.term}/terminal`, {}); notice(t('ui.members.terminalOpened')); }));
  document.querySelectorAll('[data-profile]').forEach(b => b.onclick = () => attempt(() => openProfile(b.dataset.profile)));
  document.querySelectorAll('[data-role-toggle]').forEach(b => b.onchange = () => attempt(async () => { await api(`members/${b.dataset.roleToggle}/role`, { kind: b.value, on: b.checked }); await refresh(); }));
}
function drawLogin() {
  const member = state?.agents.find(a => a.id === loginId); if (!member) return;
  const auth = member.auth || { status: 'unknown' }, pending = ['starting', 'pending', 'terminal'].includes(auth.status);
  $('login-title').textContent = t('ui.login.title', { name: member.label });
  $('login-status').textContent = auth.message || t('ui.login.hint');
  $('login-detail').textContent = auth.account?.email || t(auth.sharedProfile ? 'ui.login.shared' : 'ui.login.private');
  $('start-login').disabled = pending || auth.installed === false; $('start-login').hidden = auth.status === 'pending';
  $('auth-link').hidden = !auth.authUrl; if (auth.authUrl) $('auth-link').href = auth.authUrl;
  $('install-link').hidden = auth.installed !== false; if (auth.installUrl) $('install-link').href = auth.installUrl;
  $('cancel-login').hidden = !pending;
}
function providerHint() {
  const provider = state?.providers?.find(p => p.id === $('member-provider').value);
  $('provider-hint').textContent = t(provider?.installed ? 'ui.addMember.installed' : 'ui.addMember.notInstalled') + ' ' + t($('member-provider').value === 'antigravity' ? 'ui.addMember.shared' : 'ui.addMember.private');
}
async function refresh() {
  if (rendering) { again = true; return; } rendering = true;
  try {
    state = await api('state');
    if (linkedJob) {
      const job = state.jobs.find(j => j.id === linkedJob);
      if (job) { curProject = job.project; curSession = job.sessionId || ''; selected = job.id; linkedJob = null; }
    }
    const inView = j => (!curProject || j.project === curProject) && (!curSession || j.sessionId === curSession);
    // Việc đã bị xóa, hoặc thuộc dự án/phiên khác (URL cũ, đổi dự án) → bỏ chọn để sơ đồ/inspector không hiện việc của dự án khác.
    if (selected && !state.jobs.some(j => j.id === selected && inView(j))) selected = undefined;
    if (!selected) selected = state.jobs.find(inView)?.id;
    if (state.language && state.language !== lang) await loadLanguage(state.language);
    if (eventsOf !== selected) { events = []; eventsOf = selected; }
    if (selected) {
      const sel = selected; let more;
      do { more = await api(`jobs/${sel}/events?after=${events.at(-1)?.seq || 0}`); if (selected !== sel) { again = true; return; } events.push(...more); } while (more.length === 2000);
    }
    drawState(); drawDecisions(); syncTab(); drawTimeline();
  } finally { rendering = false; if (again) { again = false; refresh(); } }
}
const openTask = () => { if (state.projects.some(p => p.id === curProject)) $('project').value = curProject; $('task-dialog').showModal(); attempt(loadBaseBranches); }; // mặc định giao việc cho dự án đang mở
$('project').onchange = () => attempt(loadBaseBranches);
['new-task', 'create-top'].forEach(id => $(id).onclick = openTask);
$('close-dialog').onclick = () => $('task-dialog').close(); $('close-diff').onclick = () => $('diff-dialog').close();
if ($('open-jobs-btn')) $('open-jobs-btn').onclick = openJobsDialog;
if ($('close-jobs')) $('close-jobs').onclick = () => $('jobs-dialog').close();
if ($('jobs-dialog-new')) $('jobs-dialog-new').onclick = () => { $('jobs-dialog').close(); openTask(); };
if ($('jobs-search')) $('jobs-search').oninput = e => { jobsSearchQuery = e.target.value; drawJobsDialog(); };
if ($('jobs-project')) $('jobs-project').onchange = e => { jobsProject = e.target.value; drawJobsDialog(); };
document.querySelectorAll('[data-job-filter]').forEach(b => {
  b.onclick = () => {
    jobsFilter = b.dataset.jobFilter;
    document.querySelectorAll('[data-job-filter]').forEach(x => x.classList.toggle('active', x === b));
    drawJobsDialog();
  };
});
$('compare-modes').onchange = () => { $('token-budget').required = $('call-budget').required = $('compare-modes').checked; };
$('task-form').onsubmit = e => { e.preventDefault(); attempt(async () => { $('submit-task').disabled = true; try { const comparing = $('compare-modes').checked, input = { project: $('project').value, baseBranch: $('base-branch').value || undefined, goal: $('goal').value, title: $('task-title').value.trim() || undefined, files: pending.goal, mode: $('task-mode').value, dialogueMode: $('dialogue-mode').value, planApproval: $('plan-approval').checked, tokenBudget: $('token-budget').value ? Number($('token-budget').value) : undefined, callBudget: $('call-budget').value ? Number($('call-budget').value) : undefined, sessionId: $('project').value === curProject ? curSession : undefined }, result = await api(comparing ? 'comparisons' : 'jobs', input), job = comparing ? result.jobs[0] : result; curProject = job.project; curSession = job.sessionId || ''; selected = job.id; events = []; $('task-dialog').close(); $('goal').value = ''; $('task-title').value = ''; pending.goal = []; drawAttach('goal'); await refresh(); } finally { $('submit-task').disabled = false; } }); };
let scoreTarget, obligationTarget;
$('close-claim-score').onclick = () => $('claim-score-dialog').close();
$('close-obligation').onclick = () => $('obligation-dialog').close();
$('claim-score-form').onsubmit = e => { e.preventDefault(); attempt(async () => { const label = id => $(id).value === 'unknown' ? null : $(id).value === 'true'; await api(`jobs/${scoreTarget.job}/control`, { action: 'score-claim', ...scoreTarget, before: label('claim-before'), after: label('claim-after'), evidence: [$('claim-evidence').value] }); $('claim-score-dialog').close(); await refresh(); }); };
$('obligation-form').onsubmit = e => { e.preventDefault(); attempt(async () => { const resolving = e.submitter?.id === 'obligation-resolve'; await api(`jobs/${obligationTarget.job}/control`, { ...obligationTarget, action: resolving ? 'resolve-discussion' : obligationTarget.imported ? 'adopt-discussion' : 'revisit-discussion', task: Number($('obligation-task').value), recipient: $('obligation-recipient').value, reason: $('obligation-reason').value, evidence: [$('obligation-evidence').value] }); $('obligation-dialog').close(); await refresh(); }); };
$('message-form').onsubmit = e => { e.preventDefault(); attempt(async () => { if (!selected) { const job = await api('jobs', { project: curProject, goal: $('message').value, files: pending.message, mode: $('task-mode').value, sessionId: curSession || undefined }); selected = job.id; $('message').value = ''; pending.message = []; drawAttach('message'); await refresh(); return; } await api(`jobs/${selected}/control`, { action: 'message', message: $('message').value, files: pending.message }); $('message').value = ''; pending.message = []; drawAttach('message'); await refresh(); }); };
$('clear-filter').onclick = () => { filter = null; drawState(); drawTimeline(); };
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('selected', x === b)); drawTimeline(); });
function view(name) {
  name = name === true ? 'members' : name || 'work';
  $('token-view').hidden = name !== 'token'; $('token-nav').classList.toggle('active', name === 'token');
  $('metrics').hidden = name === 'token'; document.querySelector('main > header').hidden = name === 'token';
  if (name === 'token') drawToken();
  $('work-view').hidden = name !== 'work'; $('quota-view').hidden = name !== 'members'; $('security-view').hidden = name !== 'security';
  $('overview').classList.toggle('active', name === 'work'); $('quota-nav').classList.toggle('active', name === 'members'); $('security-nav').classList.toggle('active', name === 'security');
  if (name === 'security') { drawSecurity(); drawAccess(); }
}
// Bảng quyền theo vai trò: ô ✓/✗ bấm được là trần quyền bạn đổi được (chạy lệnh, Internet, xóa file); ô còn lại là bất biến an toàn (🔒).
let capsDraft = null;
function drawSecurity() {
  const cols = ['manager', 'builder', 'reviewer', 'verifier', 'controller', 'you'], caps = capsDraft || state.caps || {};
  const rows = [
    ['read', 'Y Y Y Y Y Y'], ['edit', 'N Y N N N Y'], ['delete', 'N C N N N Y'], ['outside', 'N N N N N Y'], ['shell', 'C C C C Y Y'],
    ['network', 'C C C C N Y'], ['commit', 'N N N N Y Y'],
    ['merge', 'N N N N N Y'], ['push', 'N N N N N Y'], ['mcp', 'P P P P N Y'], ['secrets', 'N N N N N Y'], ['accounts', 'P P P P N Y'],
  ];
  const mark = { Y: ['ok', '✓'], N: ['no', '✗'], P: ['part', '~'] };
  const cell = (k, v, col) => {
    if (v !== 'C') return `<td class="${mark[v][0]}" title="${esc(t('ui.sec.locked'))}">${mark[v][1]}</td>`;
    const on = caps[col]?.[k] !== false;
    return `<td class="${on ? 'ok' : 'no'}"><button class="cap-toggle" data-cap="${col}:${k}" aria-pressed="${on}" title="${esc(t('ui.sec.toggle'))}">${on ? '✓' : '✗'}</button></td>`;
  };
  const head = cols.map(c => `<th>${esc(c === 'controller' ? 'Controller' : c === 'you' ? t('ui.who.user') : roleLabel(c))}</th>`).join('');
  $('security-matrix').innerHTML = `<h3>${esc(t('ui.sec.rolesTitle'))}</h3><p class="muted">${esc(t('ui.sec.rolesIntro'))}</p>
    <table class="sec-table"><thead><tr><th>${esc(t('ui.sec.capability'))}</th>${head}<th>${esc(t('ui.sec.how'))}</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><th>${esc(t('ui.sec.row.' + k))}</th>${v.split(' ').map((x, i) => cell(k, x, cols[i])).join('')}<td class="how">${esc(t('ui.sec.how.' + k))}</td></tr>`).join('')}</tbody></table>
    <div class="access-bar"><button id="caps-save" class="primary" ${capsDraft ? '' : 'disabled'}>${esc(t('ui.access.save'))}</button><button id="caps-undo" ${capsDraft ? '' : 'disabled'}>${esc(t('ui.access.undo'))}</button>
    <span class="muted">✓ ${esc(t('ui.sec.legendYes'))} · ~ ${esc(t('ui.sec.legendPart'))} · ✗ ${esc(t('ui.sec.legendNo'))} · ${esc(t('ui.sec.legendToggle'))}</span></div>`;
  document.querySelectorAll('[data-cap]').forEach(b => b.onclick = () => {
    const [role, k] = b.dataset.cap.split(':'); capsDraft = structuredClone(capsDraft || state.caps || {});
    capsDraft[role] = { ...capsDraft[role], [k]: capsDraft[role]?.[k] === false }; drawSecurity();
  });
  $('caps-undo').onclick = () => { capsDraft = null; drawSecurity(); };
  $('caps-save').onclick = () => attempt(async () => { await api('role-caps', capsDraft); capsDraft = null; await refresh(); drawSecurity(); notice(t('ui.access.saved')); });
  $('security-notes').innerHTML = `<h3>${esc(t('ui.sec.projects'))}</h3><ul>${state.projects.map(p => `<li><b>${esc(p.id)}</b> · ${esc(p.path)} · ${esc(t(p.network ? 'ui.sec.networkOn' : 'ui.sec.networkOff'))}${p.readDirs.length ? ' · ' + esc(t('ui.sec.readDirs')) + ': ' + esc(p.readDirs.join(', ')) : ''}</li>`).join('') || `<li>${esc(t('ui.task.noProject'))}</li>`}</ul><h3>${esc(t('ui.sec.dataTitle'))}</h3><ul>${['data1', 'data2', 'data3', 'data4'].map(k => `<li>${esc(t('ui.sec.' + k))}</li>`).join('')}</ul><h3>${esc(t('ui.sec.adviceTitle'))}</h3><ul>${['advice1', 'advice2', 'advice3'].map(k => `<li>${esc(t('ui.sec.' + k))}</li>`).join('')}</ul>`;
}
// Quyền theo dự án hoặc theo phiên, riêng từng AI: thư mục trong repo (Xem / Sửa / Sửa + Xóa), thư mục ngoài repo (chỉ đọc), repo sửa cùng, Internet, chạy lệnh.
let acc = null; const repoDirs = {};
function drawAccess(reset = false) {
  const projects = state.projects;
  if (!projects.length) { $('project-access').innerHTML = ''; return; }
  if (reset || !acc || !projects.some(p => p.id === acc.project)) {
    const p = projects.find(x => x.id === (acc?.project || curProject)) || projects[0];
    const ses = acc?.project === p.id && acc.scope ? state.sessions.find(s => s.id === acc.scope) : null, src = ses?.access || p.access;
    acc = { project: p.id, scope: ses ? ses.id : '', own: !!ses?.access, folders: structuredClone(src.folders), network: [...src.network], repos: structuredClone(src.repos || []),
      paths: structuredClone(src.paths || []), shell: [...(src.shell || ['*'])], dirty: false, proposal: null, busy: false };
    if (!repoDirs[p.id]) api(`projects/${p.id}/dirs`).then(r => { repoDirs[p.id] = r.dirs; if (acc?.project === p.id && $('acc-dirs')) $('acc-dirs').innerHTML = r.dirs.map(d => `<option value="${esc(d)}">`).join(''); }).catch(() => {});
  }
  const members = state.agents.filter(a => a.enabled), on = (list, id) => list.includes('*') || list.includes(id), span = members.length + 3;
  const cells = (list, key) => `<td><input type="checkbox" data-acc="${key}" data-m="*" ${list.includes('*') ? 'checked' : ''} aria-label="${esc(t('ui.access.all'))}"></td>` +
    members.map(a => `<td><input type="checkbox" data-acc="${key}" data-m="${esc(a.id)}" ${on(list, a.id) ? 'checked' : ''} ${list.includes('*') ? 'disabled' : ''} aria-label="${esc(a.label)}"></td>`).join('');
  const lv = (key, val, inherit, label) => `<select class="lv lv-${val || 'inherit'}" data-lv="${key}" aria-label="${esc(label)}">${inherit ? `<option value="" ${val ? '' : 'selected'}>${esc(t('ui.access.lvInherit'))}</option>` : ''}${['read', 'edit', 'delete'].map(l => `<option value="${l}" ${val === l ? 'selected' : ''}>${esc(t('ui.access.lv.' + l))}</option>`).join('')}</select>`;
  const builder = id => rolesOf(id).includes('builder');
  const others = projects.filter(p => p.id !== acc.project && !acc.folders.some(f => f.path === p.path));
  const sessions = state.sessions.filter(s => s.project === acc.project), pr = acc.proposal, why = w => w ? `<br><small class="muted">${esc(w)}</small>` : '';
  const head = (icon, title, hint) => `<tr class="sec-head"><th colspan="${span}">${icon} ${esc(t(title))} <small class="muted">${esc(t(hint))}</small></th></tr>`;
  $('project-access').innerHTML = `<h3>${esc(t('ui.access.title'))}</h3><p class="muted">${esc(t('ui.access.intro'))}</p>
    <div class="access-bar"><select id="acc-project">${projects.map(p => `<option value="${esc(p.id)}" ${p.id === acc.project ? 'selected' : ''}>${esc(p.id)}</option>`).join('')}</select>
      <select id="acc-scope"><option value="">${esc(t('ui.access.scopeProject'))}</option>${sessions.map(s => `<option value="${esc(s.id)}" ${s.id === acc.scope ? 'selected' : ''}>${esc(t('ui.access.scopeSession', { 0: s.name }))}${s.access ? ' ★' : ''}</option>`).join('')}</select>
      <button id="acc-propose" ${acc.busy ? 'disabled' : ''}>${esc(t(acc.busy ? 'ui.access.proposing' : 'ui.access.propose'))}</button>
      <button id="acc-save" class="primary" ${acc.dirty ? '' : 'disabled'}>${esc(t('ui.access.save'))}</button><button id="acc-undo" ${acc.dirty ? '' : 'disabled'}>${esc(t('ui.access.undo'))}</button>
      ${acc.scope && acc.own ? `<button id="acc-inherit">${esc(t('ui.access.useProject'))}</button>` : ''}</div>
    ${acc.scope && !acc.own ? `<div class="notice">${esc(t('ui.access.inherit'))}</div>` : ''}
    ${pr ? `<div class="notice">${esc(t('ui.access.proposed'))} ${esc(pr.summary)}${pr.networkWhy ? `\n🌐 ${esc(pr.networkWhy)}` : ''}${pr.notes.length ? '\n• ' + pr.notes.map(esc).join('\n• ') : ''}</div>` : ''}
    <div class="sec-wrap"><table class="sec-table access-table"><thead><tr><th>${esc(t('ui.access.folder'))}</th><th>${esc(t('ui.access.all'))}</th>${members.map(a => `<th title="${esc(rolesText(a.id))}">${esc(a.label)}<br><small>${esc(rolesText(a.id))}</small></th>`).join('')}<th></th></tr></thead><tbody>
      ${head('📂', 'ui.access.inRepo', 'ui.access.inRepoHint')}
      ${acc.paths.map((x, i) => `<tr><th class="path">📂 ${esc(x.path === '.' ? t('ui.access.wholeRepo') : x.path)}${why(x.why)}</th><td>${lv(`${i}:*`, x.grant['*'] || 'read', false, t('ui.access.all'))}</td>${members.map(a => `<td class="${builder(a.id) ? '' : 'dim'}" title="${builder(a.id) ? '' : esc(t('ui.access.onlyBuilder'))}">${lv(`${i}:${a.id}`, x.grant[a.id], true, a.label)}</td>`).join('')}<td><button class="icon-btn" data-acc-path-del="${i}" aria-label="${esc(t('ui.inspector.delete'))}">✕</button></td></tr>`).join('') || `<tr><td colspan="${span}" class="muted">${esc(t('ui.access.noPaths'))}</td></tr>`}
      ${head('📁', 'ui.access.outside', 'ui.access.readOnly')}
      ${acc.folders.map((f, i) => `<tr><th class="path">📁 ${esc(f.path)}${why(f.why)}</th>${cells(f.members, 'f' + i)}<td><button class="icon-btn" data-acc-del="${i}" aria-label="${esc(t('ui.inspector.delete'))}">✕</button></td></tr>`).join('') || `<tr><td colspan="${span}" class="muted">${esc(t('ui.access.noFolders'))}</td></tr>`}
      ${acc.repos.map((r, i) => `<tr class="repo-row"><th class="path">🔗 ${esc(r.project)} · ${esc(projects.find(p => p.id === r.project)?.path || '')}${why(r.why)}<br><small class="warn">${esc(t('ui.access.editTogether'))}</small></th>${cells(r.members, 'r' + i)}<td><button class="icon-btn" data-acc-repo-del="${i}" aria-label="${esc(t('ui.inspector.delete'))}">✕</button></td></tr>`).join('')}
      ${head('⚙️', 'ui.access.actions', 'ui.access.actionsHint')}
      <tr><th class="path">⌨️ ${esc(t('ui.access.shell'))}<br><small class="muted">${esc(t('ui.access.shellHint'))}</small></th>${cells(acc.shell, 'sh')}<td></td></tr>
      <tr><th class="path">🌐 ${esc(t('ui.access.network'))}</th>${cells(acc.network, 'net')}<td></td></tr></tbody></table></div>
    <div class="access-bar"><input id="acc-rel" list="acc-dirs" placeholder="${esc(t('ui.access.relPlaceholder'))}"><datalist id="acc-dirs">${(repoDirs[acc.project] || []).map(d => `<option value="${esc(d)}">`).join('')}</datalist><button id="acc-add-rel">${esc(t('ui.access.addRel'))}</button></div>
    <div class="access-bar"><input id="acc-path" placeholder="D:\\other\\project\\docs"><button id="acc-pick">${esc(t('ui.project.pick'))}</button><button id="acc-add">${esc(t('ui.access.add'))}</button>
      ${projects.some(p => p.id !== acc.project && !acc.repos.some(r => r.project === p.id)) ? `<select id="acc-repo"><option value="">${esc(t('ui.access.addRepo'))}</option>${projects.filter(p => p.id !== acc.project && !acc.repos.some(r => r.project === p.id)).map(p => `<option value="${esc(p.id)}">${esc(p.id)} · ${esc(p.path)}</option>`).join('')}</select>` : ''}
      ${others.length ? `<select id="acc-other"><option value="">${esc(t('ui.access.addProject'))}</option>${others.map(p => `<option value="${esc(p.path)}">${esc(p.id)} · ${esc(p.path)}</option>`).join('')}</select>` : ''}</div>`;
  const touch = () => { acc.dirty = true; drawAccess(); };
  const leave = async () => !acc.dirty || await ask(t('ui.access.discard'), { danger: true });
  $('acc-project').onchange = async () => { if (!await leave()) { $('acc-project').value = acc.project; return; } acc = { project: $('acc-project').value }; drawAccess(true); };
  $('acc-scope').onchange = async () => { if (!await leave()) { $('acc-scope').value = acc.scope; return; } acc = { project: acc.project, scope: $('acc-scope').value }; drawAccess(true); };
  document.querySelectorAll('[data-acc]').forEach(x => x.onchange = () => {
    const key = x.dataset.acc, list = key === 'net' ? acc.network : key === 'sh' ? acc.shell : (key[0] === 'r' ? acc.repos : acc.folders)[+key.slice(1)].members, m = x.dataset.m;
    const next = m === '*' ? (x.checked ? ['*'] : []) : x.checked ? [...new Set([...list.filter(v => v !== '*'), m])] : list.filter(v => v !== m);
    if (key === 'net') acc.network = next; else if (key === 'sh') acc.shell = next; else (key[0] === 'r' ? acc.repos : acc.folders)[+key.slice(1)].members = next; touch();
  });
  document.querySelectorAll('[data-lv]').forEach(x => x.onchange = () => { const [i, m] = x.dataset.lv.split(':'), g = acc.paths[+i].grant; if (x.value) g[m] = x.value; else delete g[m]; touch(); });
  document.querySelectorAll('[data-acc-path-del]').forEach(x => x.onclick = () => { acc.paths.splice(+x.dataset.accPathDel, 1); touch(); });
  document.querySelectorAll('[data-acc-del]').forEach(x => x.onclick = () => { acc.folders.splice(+x.dataset.accDel, 1); touch(); });
  document.querySelectorAll('[data-acc-repo-del]').forEach(x => x.onclick = () => { acc.repos.splice(+x.dataset.accRepoDel, 1); touch(); });
  if ($('acc-repo')) $('acc-repo').onchange = () => { if ($('acc-repo').value) { acc.repos.push({ project: $('acc-repo').value, members: [] }); touch(); } };
  $('acc-add-rel').onclick = () => {
    const path = $('acc-rel').value.trim().replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '') || '.';
    if (/(^|\/)\.\.(\/|$)|^[a-z]:/i.test(path)) return notice(t('ui.access.relInvalid'));
    if (!acc.paths.some(x => x.path.toLowerCase() === path.toLowerCase())) { acc.paths.push({ path, grant: { '*': 'read' } }); touch(); }
  };
  const add = path => { path = path.trim().replace(/^"|"$/g, ''); if (!path || acc.folders.some(f => f.path === path)) return; acc.folders.push({ path, members: [] }); touch(); };
  $('acc-add').onclick = () => add($('acc-path').value);
  if ($('acc-other')) $('acc-other').onchange = () => add($('acc-other').value);
  $('acc-pick').onclick = () => attempt(async () => { const r = await api('projects/pick', {}); if (r.path) add(r.path); });
  $('acc-undo').onclick = () => drawAccess(true);
  const keep = () => { acc = { project: acc.project, scope: acc.scope }; };
  $('acc-save').onclick = () => attempt(async () => {
    const body = { folders: acc.folders, network: acc.network, repos: acc.repos, paths: acc.paths, shell: acc.shell };
    if (acc.scope) await api(`sessions/${acc.scope}/access`, { access: body }); else await api(`projects/${acc.project}/access`, body);
    keep(); await refresh(); drawAccess(true); notice(t('ui.access.saved'));
  });
  if ($('acc-inherit')) $('acc-inherit').onclick = () => attempt(async () => { await api(`sessions/${acc.scope}/access`, { access: null }); keep(); await refresh(); drawAccess(true); notice(t('ui.access.saved')); });
  $('acc-propose').onclick = () => attempt(async () => {
    acc.busy = true; drawAccess();
    try { const r = await api(`projects/${acc.project}/access/propose`, { candidates: acc.folders.map(f => f.path) }); Object.assign(acc, { folders: r.draft.folders, network: r.draft.network, repos: r.draft.repos || [], paths: r.draft.paths || [], shell: r.draft.shell || ['*'], proposal: r, dirty: true }); }
    finally { acc.busy = false; drawAccess(); }
  });
}
// Bộ nhớ của dự án/phiên + sao lưu: bạn thấy đúng thứ AI được nhắc lại, sửa/xóa được.
let memoryQuery = '', memoryHistory = false;
async function drawMemory() {
  const [m, b] = await Promise.all([api(`memory?project=${encodeURIComponent(curProject)}&session=${encodeURIComponent(curSession)}${memoryHistory ? '&history=1' : ''}`), api('backups')]);
  if (memoryQuery.trim()) m.facts = (await api(`memory/search?project=${encodeURIComponent(curProject)}&query=${encodeURIComponent(memoryQuery)}`)).results;
  const ses = state.sessions.find(x => x.id === curSession);
  $('memory-body').innerHTML = `<p class="muted">${esc(t('ui.mem.intro'))}</p>
    <div class="row-input"><input id="mem-query" value="${esc(memoryQuery)}" placeholder="${esc(t('ui.mem.search'))}" aria-label="${esc(t('ui.mem.search'))}"><button id="mem-search">${esc(t('ui.mem.search'))}</button></div>
    <label><input type="checkbox" id="mem-history" ${memoryHistory ? 'checked' : ''}> ${esc(t('ui.mem.history'))}</label>
    <div class="row-input"><button id="mem-export">${esc(t('ui.mem.exportMemory'))}</button><label>${esc(t('ui.mem.import'))}<input type="file" id="mem-import" accept=".json,application/json"></label></div><p id="mem-result" role="status"></p>
    <h3>${esc(t('ui.mem.facts', { project: curProject, n: m.facts.length }))}</h3>
    <ul class="mem-list">${m.facts.filter(f => f.kind === 'fact').map(f => `<li><span>${esc(f.text)}<br><small class="muted">M${esc(f.id)} · ${esc(f.source)} · ${esc(t('ui.mem.' + f.scope))} · ${esc(t('ui.mem.' + f.status))} · ${esc(f.commitSha?.slice(0, 8) || '')} · ${esc(clock(f.at))}</small></span>${f.status === 'active' ? `<button type="button" data-mem-stale="${esc(f.id)}" data-mem-revision="${esc(f.revision)}">${esc(t('ui.mem.stale'))}</button><button class="icon-btn" data-mem-del="${esc(f.id)}" data-mem-revision="${esc(f.revision)}" aria-label="${esc(t('ui.inspector.delete'))}">✕</button>` : ''}</li>`).join('') || `<li class="muted">${esc(t('ui.mem.none'))}</li>`}</ul>
    <div class="row-input"><input id="mem-add" maxlength="300" placeholder="${esc(t('ui.mem.addPlaceholder'))}"><button id="mem-add-btn">${esc(t('ui.mem.add'))}</button></div>
    <h3>${esc(t('ui.mem.session', { name: ses?.name || '—' }))}</h3>
    <textarea id="mem-summary" rows="4" maxlength="1500">${esc(m.summary)}</textarea><button id="mem-summary-save">${esc(t('ui.mem.saveSummary'))}</button>
    <details><summary>${esc(t('ui.mem.log', { n: m.log.length }))}</summary><ul class="mem-log">${m.log.map(l => `<li>${esc(l.text)}</li>`).join('')}</ul></details>
    <h3>${esc(t('ui.mem.backups'))}</h3><p class="muted">${esc(b.dir)}</p>
    <ul class="mem-log">${b.list.slice(0, 5).map(x => `<li>${esc(x.file.split(/[\\/]/).pop())} · ${esc(clock(x.at))} · ${Math.round(x.bytes / 1024)} KB</li>`).join('') || `<li class="muted">${esc(t('ui.mem.noBackup'))}</li>`}</ul>
    <div class="cleanup-actions"><button id="backup-now">${esc(t('ui.mem.backupNow'))}</button>${cleanupButtons('memory')}</div>`;
  const edit = body => attempt(async () => { await api('memory', { project: curProject, session: curSession, ...body }); await drawMemory(); });
  wireCleanup('memory');
  document.querySelectorAll('[data-mem-stale]').forEach(x => x.onclick = () => edit({ stale: Number(x.dataset.memStale), revision: Number(x.dataset.memRevision) }));
  document.querySelectorAll('[data-mem-del]').forEach(x => x.onclick = () => edit({ remove: x.dataset.memDel, revision: Number(x.dataset.memRevision) }));
  $('mem-search').onclick = () => attempt(async () => { memoryQuery = $('mem-query').value; await drawMemory(); });
  $('mem-query').onkeydown = e => { if (e.key === 'Enter') $('mem-search').click(); };
  $('mem-history').onchange = () => attempt(async () => { memoryHistory = $('mem-history').checked; memoryQuery = ''; await drawMemory(); });
  $('mem-export').onclick = () => { location.href = `/api/memory/export?project=${encodeURIComponent(curProject)}`; };
  $('mem-import').onchange = () => attempt(async () => {
    const file = $('mem-import').files[0]; if (!file) return;
    if (file.size > 160e6) throw new Error(t('ui.mem.tooLarge'));
    const pack = JSON.parse(await file.text()), transfer = pack.format === 'ai-team-transfer';
    const result = await api(transfer ? 'transfer/import' : 'memory/import', { project: curProject, package: pack });
    if (transfer) { selected = result.job.id; curSession = result.job.sessionId; }
    await refresh(); await drawMemory();
    const counts = transfer ? result.memory : result;
    $('mem-result').textContent = t('ui.mem.imported', { n: counts.added, conflicts: counts.conflicts }) + (transfer ? ' ' + t('ui.mem.importPaused') : '');
  });
  $('mem-add-btn').onclick = () => $('mem-add').value.trim() && edit({ add: $('mem-add').value });
  $('mem-summary-save').onclick = () => edit({ summary: $('mem-summary').value });
  $('backup-now').onclick = () => attempt(async () => { $('backup-now').disabled = true; await api('backup', {}); await drawMemory(); });
}
$('memory-open').onclick = () => attempt(async () => { await drawMemory(); $('memory-dialog').showModal(); });
$('close-memory').onclick = () => $('memory-dialog').close();
$('token-nav').onclick = () => view('token');
$('overview').onclick = () => view('work');
$('security-nav').onclick = () => view('security');
$('quota-nav').onclick = () => attempt(async () => { view('members'); recheckMembers(); $('quota-history').textContent = JSON.stringify(await api('quota-history'), null, 2); });
$('refresh-quota').onclick = () => attempt(async () => { await api('quota', {}); });
$('add-member').onclick = () => { if (state.demo) { location.href = 'http://127.0.0.1:3333/?members=1&add=1'; return; } providerHint(); $('member-dialog').showModal(); };
$('member-provider').onchange = providerHint;
$('close-member').onclick = () => $('member-dialog').close();
$('member-form').onsubmit = e => {
  e.preventDefault(); attempt(async () => {
    $('save-member').disabled = true;
    try { const member = await api('members', { provider: $('member-provider').value, label: $('member-name').value, kind: $('member-role').value }); await api(`members/${member.id}/profile`, { tier: $('member-tier').value }); $('member-dialog').close(); $('member-name').value = ''; await refresh(); loginId = member.id; drawLogin(); $('login-dialog').showModal(); }
    finally { $('save-member').disabled = false; }
  });
};
$('close-profile').onclick = () => $('profile-dialog').close();
$('profile-model').onchange = () => { $('profile-model-custom').hidden = $('profile-model').value !== '__custom'; fillEfforts($('profile-effort').value); };
$('profile-form').onsubmit = e => {
  e.preventDefault(); attempt(async () => {
    const model = $('profile-model').value === '__custom' ? $('profile-model-custom').value.trim() : $('profile-model').value;
    const cli = $('profile-cli').value.trim(), changed = cli !== $('profile-cli').dataset.initial;
    await api(`members/${profileId}/profile`, { label: $('profile-name').value, model, ...($('profile-effort-box').hidden ? {} : { effort: $('profile-effort').value }), tier: $('profile-tier').value, enabled: $('profile-enabled').checked, systemPrompt: $('profile-prompt').value, mcp: $('profile-mcp').value, ...(changed ? { cliPath: cli } : {}) });
    if (changed) await api(`members/${profileId}/refresh`, {});
    $('profile-dialog').close(); await refresh();
  });
};
const toggleChat = open => { const p = document.querySelector('.communication'); p.classList.toggle('expanded', open ?? !p.classList.contains('expanded')); document.body.classList.toggle('chat-open', p.classList.contains('expanded')); $('chat-expand').textContent = p.classList.contains('expanded') ? '✕' : '⤢'; $('timeline').scrollTop = $('timeline').scrollHeight; };
$('chat-expand').onclick = () => toggleChat();
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('chat-open') && !document.querySelector('dialog[open]')) toggleChat(false); });
function projectList() {
  const quote = w => /\s/.test(w) ? `"${w}"` : w;
  $('project-list').innerHTML = state.projects.length ? `<b>${esc(t('ui.project.registered'))}</b>${state.projects.map(p => `<div class="project-row"><span><b>${esc(p.id)}</b> · ${esc(p.path)}${p.tests.length ? '' : ' · ' + esc(t('ui.project.noTests'))}</span><button type="button" data-remove-project="${esc(p.id)}">${esc(t('ui.project.remove'))}</button><details class="read-dirs"><summary>${esc(t('ui.project.edit'))}</summary>
    <label>${esc(t('ui.project.tests'))}</label><textarea rows="2" data-tests="${esc(p.id)}">${esc(p.tests.map(c => c.map(quote).join(' ')).join('\n'))}</textarea>
    <label>${esc(t('ui.results.previewConfig'))}</label><textarea rows="7" data-preview="${esc(p.id)}" aria-label="${esc(t('ui.results.previewConfig'))}">${esc(p.preview ? JSON.stringify(p.preview, null, 2) : '')}</textarea><p class="muted">${esc(t('ui.results.previewHint'))}</p>
    <div class="controls"><button type="button" data-preview-save="${esc(p.id)}">${esc(t('ui.project.saveChanges'))}</button><button type="button" data-preview-clear="${esc(p.id)}">${esc(t('ui.inspector.delete'))}</button><button type="button" data-preview-propose="${esc(p.id)}">${esc(t('ui.access.propose'))}</button></div><p data-preview-note="${esc(p.id)}" class="muted"></p>
    <label class="profile-check"><input type="checkbox" data-net="${esc(p.id)}" ${p.network ? 'checked' : ''}> ${esc(t('ui.project.network'))}</label>
    <label>${esc(t('ui.project.readDirs'))} (${p.readDirs.length})</label><textarea rows="2" data-dirs="${esc(p.id)}">${esc(p.readDirs.join('\n'))}</textarea>
    <button type="button" data-save-project="${esc(p.id)}">${esc(t('ui.project.saveChanges'))}</button></details></div>`).join('')}` : '';
  const q = (attr, id) => document.querySelector(`[${attr}="${id}"]`);
  document.querySelectorAll('[data-preview-save], [data-preview-clear]').forEach(b => b.onclick = () => attempt(async () => {
    const id = b.dataset.previewSave || b.dataset.previewClear;
    const value = q('data-preview', id).value.trim();
    const preview = b.dataset.previewClear || !value ? null : JSON.parse(value);
    await api('projects/' + encodeURIComponent(id) + '/update', { preview }); await refresh(); projectList();
  }));
  document.querySelectorAll('[data-preview-propose]').forEach(b => b.onclick = () => attempt(async () => {
    b.disabled = true;
    try {
      const id = b.dataset.previewPropose, result = await api('projects/' + encodeURIComponent(id) + '/preview/propose', {});
      q('data-preview', id).value = JSON.stringify(result.draft, null, 2);
      q('data-preview-note', id).textContent = [t('ui.access.proposed'), result.summary, ...(Array.isArray(result.notes) ? result.notes : [result.notes || ''])].join(' · ');
    } finally { b.disabled = false; }
  }));
  document.querySelectorAll('[data-save-project]').forEach(b => b.onclick = () => attempt(async () => {
    const id = b.dataset.saveProject;
    const r = await api(`projects/${id}/update`, { tests: q('data-tests', id).value, network: q('data-net', id).checked, readDirs: q('data-dirs', id).value });
    await refresh(); projectList(); if (r.warnings?.length) throw new Error(r.warnings.join('\n'));
  }));
  document.querySelectorAll('[data-remove-project]').forEach(b => b.onclick = () => attempt(async () => {
    const id = b.dataset.removeProject; if (!await ask(t('ui.project.confirmRemove', { id }), { ok: t('ui.inspector.delete'), danger: true })) return;
    try { await api(`projects/${id}/remove`, {}); }
    catch (e) { if (e.status !== 409 || !await ask(e.message + '\n\n' + t('ui.project.cancelJobsAndRemove'), { danger: true })) throw e; await api(`projects/${id}/remove`, { cancelJobs: true }); }
    await refresh(); projectList();
  }));
}
$('open-project').onclick = () => { projectList(); $('project-dialog').showModal(); };
$('close-project').onclick = () => $('project-dialog').close();
$('pick-folder').onclick = () => attempt(async () => { $('pick-folder').disabled = true; try { const r = await api('projects/pick', {}); if (r.path) { $('project-path').value = r.path; if (!$('project-id').value) $('project-id').value = r.path.split(/[\\/]/).filter(Boolean).pop().toLowerCase().replace(/[^a-z0-9-]+/g, '-'); } } finally { $('pick-folder').disabled = false; } });
$('project-form').onsubmit = e => {
  e.preventDefault(); attempt(async () => {
    const r = await api('projects', { path: $('project-path').value, id: $('project-id').value, tests: $('project-tests').value, init: $('project-init').checked, network: $('project-network').checked, readDirs: $('project-readdirs').value });
    $('project-dialog').close(); $('project-form').reset(); await refresh(); $('project').value = r.id;
  });
};
wireAttach('goal', $('goal-files'), $('goal')); wireAttach('message', $('message-files'), $('message'));
$('import-mcp').onclick = () => attempt(async () => {
  const servers = await api('mcp/claude'); if (!Object.keys(servers).length) throw new Error(t('ui.profile.mcpNone'));
  let current = {}; try { current = JSON.parse($('profile-mcp').value || '{}'); } catch { }
  $('profile-mcp').value = JSON.stringify({ ...servers, ...current }, null, 2);
});
async function drawSkills(refresh) {
  const list = await api('skills' + (refresh ? '?refresh=1' : ''));
  $('skills-count').textContent = `(${list.length})`;
  $('skills-list').innerHTML = list.map(s => `<div class="skill-row"><b>${esc(s.name)}</b><span>${esc(s.description)}</span><small class="muted">${esc(s.source)}</small></div>`).join('') || `<p class="muted">${esc(t('ui.skills.empty'))}</p>`;
}
$('skills-box').ontoggle = () => { if ($('skills-box').open) attempt(() => drawSkills()); };
$('skills-refresh').onclick = () => attempt(() => drawSkills(true));
const applyNav = () => document.body.classList.toggle('nav-collapsed', store.get('nav') === 'min');
$('nav-toggle').onclick = () => { store.set('nav', store.get('nav') === 'min' ? '' : 'min'); applyNav(); }; applyNav();
const applyFlow = () => { const min = store.get('flow') === 'min'; document.querySelector('.network').classList.toggle('collapsed', min); $('flow-toggle').textContent = min ? '▸' : '▾'; $('flow-summary').hidden = !min; };
$('flow-toggle').onclick = () => { store.set('flow', store.get('flow') === 'min' ? '' : 'min'); applyFlow(); }; applyFlow();
// Đổi phiên: khung chat chỉ hiện công việc của phiên đó (phiên mới thì trống).
function gotoJob(id) {
  const j = state.jobs.find(x => x.id === id); if (!j) return;
  curProject = j.project; curSession = j.sessionId || ''; selected = j.id; events = []; filter = null;
  view('work'); // chọn việc = xem điều phối; Token/Quota/Quyền là trang chung, không gắn với việc
  store.set('project', curProject); store.set('session', curSession); drawSessions(); attempt(refresh);
}
function selectSessionJob() {
  const own = state.jobs.filter(j => j.project === curProject && (!curSession || j.sessionId === curSession));
  if (!own.some(j => j.id === selected)) { selected = own[0]?.id; events = []; filter = null; }
  refresh();
}
$('session-project').onchange = () => { if ($('session-project').value === '__add') { $('session-project').value = curProject; $('open-project').click(); return; } curProject = $('session-project').value; curSession = ''; store.set('project', curProject); view('work'); drawSessions(); selectSessionJob(); };
$('session-tab').onclick = () => window.open(location.pathname + '#' + new URLSearchParams({ p: curProject }), '_blank');
$('session-new').onclick = () => attempt(async () => { const name = await ask(t('ui.session.newPrompt'), { input: true }); if (name === null) return; const s = await api('sessions', { project: curProject, name }); curSession = s.id; store.set('session', s.id); selected = undefined; events = []; await refresh(); });
$('session-rename').onclick = () => attempt(async () => { if (!curSession) return; const name = await ask(t('ui.session.renamePrompt'), { input: true, value: state.sessions.find(x => x.id === curSession)?.name || '' }); if (name) { await api(`sessions/${curSession}/rename`, { name }); await refresh(); } });
$('close-slot').onclick = () => $('slot-dialog').close();
$('slot-member').onchange = slotMember;
$('slot-form').onsubmit = e => { e.preventDefault(); attempt(saveSlot); };
$('slot-remove').onclick = () => attempt(async () => { await api(`members/${slot.current}/role`, { kind: slot.kind, on: false }); $('slot-dialog').close(); await refresh(); });
$('slot-profile').onclick = () => { $('slot-dialog').close(); attempt(() => openProfile(slot.current)); };
$('slot-filter').onclick = () => { filter = slot.current; $('slot-dialog').close(); drawState(); drawTimeline(); };
$('close-merge').onclick = () => $('merge-dialog').close();
$('merge-dialog').addEventListener('close', () => { ++mergeRequest; mergeCheck = null; });
$('merge-target').onchange = () => attempt(refreshMergeCheck);
$('merge-new-branch').oninput = () => attempt(refreshMergeCheck);
$('merge-confirm').oninput = updateMergeButton;
$('merge-view-diff').onclick = () => attempt(showDiff);
$('merge-go').onclick = () => attempt(async () => {
  if ($('merge-go').disabled || !mergeCheck) return;
  const id = mergeJob, approval = mergeCheck.pendingMerge?.commit;
  mergeSending = true; $('merge-target').disabled = true; updateMergeButton();
  try {
    const result = await api(`jobs/${encodeURIComponent(id)}/merge`, { confirm: $('merge-confirm').value.trim(), target: mergeTarget(), ...(approval ? { approveMerge: approval } : {}) });
    await refresh();
    const job = state?.jobs?.find(j => j.id === id);
    if (job?.pendingMerge || result?.pendingMerge || result?.job?.pendingMerge) await refreshMergeCheck();
    else if (job?.status === 'ready' || result?.job?.status === 'ready' || result?.status === 'ready') throw new Error(t('ui.merge.notStarted'));
    else $('merge-dialog').close();
  } catch (e) {
    $('merge-error').textContent = e.message; $('merge-error').hidden = false;
  } finally { mergeSending = false; $('merge-target').disabled = false; updateMergeButton(); }
});
$('close-login').onclick = () => $('login-dialog').close();
$('start-login').onclick = () => attempt(async () => { $('start-login').disabled = true; try { await api(`members/${loginId}/login`, {}); await refresh(); } finally { drawLogin(); } });
$('check-login').onclick = () => attempt(async () => { await api(`members/${loginId}/refresh`, {}); await refresh(); });
$('cancel-login').onclick = () => attempt(async () => { await api(`members/${loginId}/cancel-login`, {}); await refresh(); });
$('theme-select').onchange = () => { store.set('theme', $('theme-select').value); applyTheme($('theme-select').value); };
$('oracle-toggle').onchange = async () => {
  const toggle = $('oracle-toggle'), previous = !!state?.oracle?.enabled;
  toggle.disabled = true;
  try {
    const result = await api('settings', { oracle: toggle.checked });
    state.oracle = result.oracle;
    toggle.checked = !!state.oracle?.enabled;
  } catch (e) { notice(e.message); toggle.checked = previous; }
  finally { toggle.disabled = !state?.oracle?.accounts; }
};
// Ngôn ngữ lưu ở server (team.config.json) để thông báo do server tạo cũng đổi theo.
$('lang-select').onchange = () => attempt(async () => {
  const next = $('lang-select').value; store.set('lang', next);
  await api('settings', { language: next }).catch(e => notice(e.message));
  await loadLanguage(next); notice(''); if (state) { drawState(); drawTimeline(); if (!$('token-view').hidden) drawToken(); }
});
document.addEventListener('click', e => {
  const check = e.target.closest('[data-activity-check]'), pause = e.target.closest('[data-activity-pause]');
  if (check) {
    const job = state.jobs.find(j => j.id === check.dataset.activityJob), run = runningOf(job).find(r => activityRunKey(r) === check.dataset.activityCheck);
    if (run) {
      if (!$('slot-dialog').open || slot?.current !== run.agent || slot?.job !== job.id || slot?.run !== activityRunKey(run)) openSlot(['implement', 'research'].includes(run.stage) ? 'builder' : nodeOfRun(run) || 'manager', run.agent, run.task, job.id, activityRunKey(run));
      const log = $('slot-live').querySelector('.live-log');
      if (log) { const last = log.lastElementChild; if (last?.tagName === 'DETAILS') last.open = true; log.scrollTop = log.scrollHeight; log.scrollIntoView({ block: 'nearest' }); }
      else if (slot.task == null) { $('slot-dialog').close(); filter = run.agent; tab = 'activity'; drawState(); drawTimeline(); $('timeline').scrollTop = $('timeline').scrollHeight; }
    }
  }
  if (pause) attempt(async () => {
    pause.disabled = true;
    try { await api(`jobs/${pause.dataset.activityPause}/control`, { action: 'pause' }); await refresh(); } finally { pause.disabled = false; }
  });
  if (!e.target.closest('.actions-dropdown')) {
    document.querySelectorAll('.actions-dropdown[open]').forEach(d => d.removeAttribute('open'));
  }
});

// Shared and project prompt controls stay separate from member profile prompts.
let promptRequest = 0;
function openPrompt(title) {
  promptRequest++;
  $('prompt-title').textContent = title;
  $('prompt-body').textContent = t('ui.prompt.loading');
  if (!$('prompt-dialog').open) $('prompt-dialog').showModal();
  return promptRequest;
}
function promptCounter(text, budget) {
  return t('ui.prompt.count', { chars: text.length, tokens: Math.ceil(text.length / 4), budget });
}
function wirePromptCounter(budget) {
  const input = $('prompt-text'), count = $('prompt-count');
  const update = () => { count.textContent = promptCounter(input.value, budget); count.classList.toggle('prompt-over', input.value.length > budget); };
  input.oninput = update; update();
}
async function openSystemPrompt() {
  const request = openPrompt(t('ui.prompt.system'));
  const data = await api('system-prompt');
  if (request !== promptRequest || !$('prompt-dialog').open) return;
  $('prompt-body').innerHTML = `<p class="muted">${esc(t('ui.prompt.version'))} ${esc(data.version)}${data.isDefault ? ' · ' + esc(t('ui.prompt.default')) : ''}</p><form id="system-prompt-form"><label for="prompt-text">${esc(t('ui.prompt.system'))}</label><textarea id="prompt-text" rows="10" maxlength="4000" required></textarea><p id="prompt-count" class="muted" aria-live="polite"></p><div class="prompt-actions"><button type="submit" class="primary">${esc(t('ui.prompt.save'))}</button><button type="button" id="prompt-default">${esc(t('ui.prompt.restore'))}</button></div></form><h3>${esc(t('ui.prompt.history'))}</h3><div class="prompt-history">${(data.history || []).map((v, i) => `<details><summary>${esc(t('ui.prompt.version'))} ${esc(v.version)} · ${esc(clock(v.at))}</summary><pre>${esc(v.text)}</pre><button type="button" data-prompt-version="${i}">${esc(t('ui.prompt.reuse'))}</button></details>`).join('')}</div>`;
  $('prompt-text').value = data.text;
  wirePromptCounter(4000);
  let saving = false;
  const save = async text => {
    if (saving) return;
    if (text.length > 4000) throw new Error(t('ui.prompt.tooLong'));
    saving = true;
    const buttons = [...$('prompt-body').querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
    try { await api('system-prompt', { text }); if (request === promptRequest && $('prompt-dialog').open) await openSystemPrompt(); }
    finally { saving = false; buttons.forEach(b => b.disabled = false); }
  };
  $('system-prompt-form').onsubmit = e => { e.preventDefault(); attempt(() => save($('prompt-text').value)); };
  $('prompt-default').onclick = () => attempt(() => save(data.default));
  $('prompt-body').querySelectorAll('[data-prompt-version]').forEach(b => b.onclick = () => attempt(() => save(data.history[+b.dataset.promptVersion].text)));
}
async function openProjectPrompt(project = curProject) {
  if (!project) return notice(t('ui.prompt.noProject'));
  const request = openPrompt(`${t('ui.prompt.project')} · ${project}`);
  const path = `projects/${encodeURIComponent(project)}/prompt`, data = await api(path);
  if (request !== promptRequest || !$('prompt-dialog').open) return;
  if (data.exists) {
    $('prompt-body').innerHTML = `<p class="${data.chars > data.budget ? 'prompt-warning' : 'muted'}">${esc(t('ui.prompt.projectCount', { chars: data.chars, budget: data.budget }))}${data.chars > data.budget ? ' · ' + esc(t('ui.prompt.over')) : ''}</p><p class="muted">${esc(t('ui.prompt.readonly'))}</p><pre class="prompt-content">${esc(data.text)}</pre>`;
    return;
  }
  const key = `prompt-draft:${project}`, draftId = store.get(key);
  $('prompt-body').innerHTML = `<p class="muted">${esc(t('ui.prompt.missing'))}</p><button type="button" id="prompt-draft">${esc(t('ui.prompt.create'))}</button><p id="prompt-draft-status" role="status"></p><button type="button" id="prompt-draft-check" ${draftId ? '' : 'hidden'}>${esc(t('ui.prompt.checkDraft'))}</button><form id="project-prompt-form" hidden><label for="prompt-text">${esc(t('ui.prompt.draftText'))}</label><textarea id="prompt-text" rows="10" required></textarea><p id="prompt-count" class="muted" aria-live="polite"></p><button type="submit" class="primary">${esc(t('ui.prompt.approve'))}</button></form>`;
  let currentDraft = draftId;
  const extractDraft = text => (text.match(/^\s*```(?:markdown|md)[ \t]*\r?\n([\s\S]*)\r?\n```[ \t]*(?:\r?\n|$)/i)?.[1] ?? text).trim();
  const resetDraft = () => {
    if (request !== promptRequest || !$('prompt-dialog').open) return;
    const id = currentDraft;
    store.set(key, '');
    currentDraft = null;
    $('prompt-draft').disabled = false;
    $('prompt-draft-check').hidden = true;
    $('prompt-draft-status').textContent = t('ui.prompt.draftFailed', { id });
  };
  const checkDraft = async () => {
    let job;
    try { job = await api(`jobs/${encodeURIComponent(currentDraft)}`); }
    catch { resetDraft(); return; }
    if (request !== promptRequest || !$('prompt-dialog').open) return;
    if (['cancelled', 'failed', 'blocked'].includes(job.status) || (job.status === 'done' && !job.conclusion)) { resetDraft(); return; }
    $('prompt-draft-status').textContent = t(job.conclusion ? 'ui.prompt.draftReady' : 'ui.prompt.draftCreated', { id: currentDraft });
    if (job.conclusion) {
      $('project-prompt-form').hidden = false;
      $('prompt-draft').disabled = true;
      $('prompt-draft-check').hidden = true;
      if (!$('prompt-text').value) $('prompt-text').value = extractDraft(job.conclusion.conclusion || job.conclusion.summary || '');
      wirePromptCounter(data.budget);
    }
  };
  $('prompt-draft').onclick = () => attempt(async () => {
    const button = $('prompt-draft'); button.disabled = true;
    try {
      const result = await api(path + '/draft', {});
      currentDraft = result.job.id; store.set(key, currentDraft);
      if (request !== promptRequest || !$('prompt-dialog').open) return;
      $('prompt-draft-status').textContent = t('ui.prompt.draftCreated', { id: currentDraft });
      $('prompt-draft-check').hidden = false;
    } catch (e) { button.disabled = false; throw e; }
  });
  $('prompt-draft-check').onclick = () => attempt(checkDraft);
  $('project-prompt-form').onsubmit = e => { e.preventDefault(); attempt(async () => {
    if (!await ask(t('ui.prompt.confirm'))) return;
    const button = e.target.querySelector('button'); button.disabled = true;
    try { await api(path, { text: $('prompt-text').value, approved: true, job: currentDraft || undefined }); store.set(key, ''); if (request === promptRequest && $('prompt-dialog').open) await openProjectPrompt(project); }
    finally { button.disabled = false; }
  }); };
  if (currentDraft) { $('prompt-draft').disabled = true; try { await checkDraft(); } catch { resetDraft(); } }
}
function openCallPrompt(event) {
  if (!event?.details?.prompt) return;
  openPrompt(t('ui.prompt.view'));
  $('prompt-body').innerHTML = `<div class="prompt-table-wrap"><table class="prompt-table"><thead><tr>${['part', 'chars', 'tokens', 'budget'].map(k => `<th scope="col">${esc(t('ui.prompt.' + k))}</th>`).join('')}</tr></thead><tbody>${(event.details.promptParts || []).map(p => `<tr class="${p.over ? 'prompt-over' : ''}"><th scope="row">${esc(p.name)}${p.over ? ' · ' + esc(t('ui.prompt.over')) : ''}</th><td>${esc(p.chars)}</td><td>${esc(p.tokens)}</td><td>${esc(p.budget ?? '—')}</td></tr>`).join('')}</tbody></table></div><pre class="prompt-content">${esc(event.details.prompt)}</pre>`;
}
$('system-prompt-open').onclick = () => attempt(openSystemPrompt);
$('project-prompt-open').onclick = () => attempt(() => openProjectPrompt());
$('prompt-close').onclick = () => $('prompt-dialog').close();
$('prompt-dialog').addEventListener('close', () => { promptRequest++; });

await loadLanguage(store.get('lang') || 'vi');
await attempt(reconcileAndRefresh);
const query = new URLSearchParams(location.search);
if (query.has('members')) { view(true); recheckMembers(); }
if (query.has('add') && state && !state.demo) { providerHint(); $('member-dialog').showModal(); }
if (query.has('member') && state?.agents.some(a => a.id === query.get('member'))) { loginId = query.get('member'); drawLogin(); $('login-dialog').showModal(); }
// Trình duyệt chỉ mở ~6 kết nối HTTP/1.1 tới một host; mỗi tab giữ 1 luồng SSE. Nhiều tab → hết kết nối, request treo (pending).
// Tab bị ẩn thì đóng luồng, hiện lại thì mở và tải lại ngay.
let stream = null;
function openStream() {
  if (stream || document.hidden) return;
  stream = new EventSource('/api/stream'); stream.onmessage = () => attempt(refresh); stream.onerror = () => { $('connection').textContent = t('ui.nav.reconnecting'); };
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stream?.close(); stream = null; } else { openStream(); attempt(reconcileAndRefresh); }
});
window.addEventListener('focus', () => { if (!document.hidden) attempt(reconcileAndRefresh); });
openStream();
setInterval(() => { if (!document.hidden) attempt(refresh); }, 10000);
setInterval(updateActivities, 30000);
