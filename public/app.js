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
async function api(path, data) {
  const r = await fetch('/api/' + path, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Team-Request': '1' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await r.json().catch(() => ({}));
  if (r.status === 404 && path.startsWith('members/') || r.status === 404 && path === 'settings') throw new Error(t('ui.error.oldServer'));
  if (!r.ok) throw Object.assign(new Error(result.error || r.statusText), { status: r.status }); return result;
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
function badge(job) { return `<span class="status ${esc(job.status)}">${esc(statusLabel(job.status))}</span>`; }
function duration(minutes) {
  const m = Math.max(0, Math.round(minutes)), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), r = m % 60;
  return [d && t('ui.time.days', { n: d }), h && t('ui.time.hours', { n: h }), r && t('ui.time.minutes', { n: r })].filter(Boolean).join(' ') || t('ui.time.minutes', { n: 0 });
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
    if (/five[_\s-]*hour|session|\b5h\b/i.test(raw)) return 'claude-session';
    if (/seven[_\s-]*day|week|\b7d\b/i.test(raw)) return 'claude-weekly';
    return (b.id || b.name || '').toLowerCase().replace(/[:\s]+$/, '');
  };
  const map = new Map();
  for (const b of buckets) {
    const key = canonicalKey(b);
    if (!map.has(key)) map.set(key, b);
  }
  return Array.from(map.values());
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
  const tl = useTextLength ? ` textLength="${maxW}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<text x="${x}" y="${y}" class="${cls}"${style}${tl}>${esc(str)}</text>`;
}

// Các lượt đang chạy của một công việc (song song); dữ liệu cũ chỉ có job.current.
const runningOf = j => j?.status === 'running' ? (j.running?.length ? j.running : j.current ? [j.current] : []) : [];
const nodeOfRun = r => ({ plan: 'manager', final: 'manager', implement: 'b:' + r.agent, research: 'b:' + r.agent, review: 'reviewer', verify: 'verifier' })[r.stage] || null;
function drawState() {
  names = { controller: 'Controller', user: t('ui.who.user'), team: t('ui.who.team'), ...Object.fromEntries(state.agents.map(a => [a.id, a.label])) };
  $('stale').hidden = !state.stale;
  $('mode').textContent = state.demo ? t('ui.header.demo') : 'LIVE · LOCAL';
  $('connection').textContent = t('ui.nav.connected');
  if (state.demo && !$('notice').textContent) notice(t('ui.header.demoNotice'));
  const ready = state.jobs.filter(j => j.status === 'ready').length;
  $('metrics').innerHTML = [
    [t('ui.metric.agents'), `${state.resources.active} <small>/ ${state.resources.slots ?? 1}</small>`, state.resources.waitingReason || t('ui.metric.onDemand')],
    [t('ui.metric.jobs'), state.jobs.length, t('ui.metric.jobsNote', { running: state.jobs.filter(j => ['queued', 'running'].includes(j.status)).length, ready })],
    [t('ui.metric.ram'), `${state.resources.ramPercent}%`, t('ui.metric.ramNote', { total: state.resources.totalGB, controller: state.resources.controllerMB })],
    [t('ui.metric.cpu'), `${state.resources.cpuPercent}%`, t('ui.metric.cpuNote')],
  ].map(([label, value, note]) => `<div class="metric"><span>${esc(label)}</span><strong>${value}</strong><small>${esc(note)}</small></div>`).join('');
  drawSessions(); syncTab();
  { const j = state.jobs.find(x => x.id === selected); $('flow-summary').textContent = j ? `${cut(j.goal, 80)} · ${statusLabel(j.status)}${runningOf(j).map(r => ' · ' + (names[r.agent] || r.agent) + ' → ' + r.stage).join('')}${j.eta != null ? ' · ' + t('ui.eta', { time: duration(j.eta) }) : ''}` : t('ui.flow.summaryIdle'); }
  drawJobsList();
  drawJobsDialog();
  drawFlow();
  if ($('slot-dialog').open && slot?.current) refreshSlotLive();
  document.querySelectorAll('[data-slot]').forEach(b => b.onclick = () => openSlot(b.dataset.slot, b.dataset.agent || null));
  document.querySelectorAll('[data-bench]').forEach(b => b.onclick = () => attempt(() => openProfile(b.dataset.bench)));
  $('running-label').textContent = t('ui.team.running', { n: state.resources.active });
  $('project').innerHTML = state.projects.map(p => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join('');
  $('project-help').textContent = t(state.projects.length ? 'ui.task.projectHelp' : 'ui.task.noProject');
  $('submit-task').disabled = !state.projects.length;
  drawInspector(); drawQuota(); drawLogin();
}

let jobsFilter = 'all', jobsSearchQuery = '';

function drawJobsList() {
  const sessionJobs = state.jobs.filter(j => !curProject || j.project === curProject && (!curSession || j.sessionId === curSession));
  const maxSidebar = 3;
  const showList = sessionJobs.slice(0, maxSidebar);
  const hasMore = sessionJobs.length > maxSidebar;

  $('job-list').innerHTML = (showList.length ? showList.map(j => `
    <button class="job-button ${j.id === selected ? 'selected' : ''}" data-job="${esc(j.id)}" title="${esc(j.goal)}">
      <span class="job-dot-status ${j.status}"></span>
      <div class="job-button-content">
        <strong>${esc(j.goal)}</strong>
        <small><span class="job-id">#${esc(j.id.slice(0, 8))}</span> · <span class="job-status-tag ${j.status}">${esc(statusLabel(j.status))}</span></small>
      </div>
    </button>
  `).join('') : `<p class="muted">${esc(t('ui.nav.noJobs'))}</p>`)
  + (hasMore ? `<button type="button" class="sidebar-more-jobs" id="sidebar-more-jobs"><span>⤢</span> ${esc(t('ui.jobs.viewAll', { n: sessionJobs.length }))}</button>` : '');

  document.querySelectorAll('[data-job]').forEach(b => b.onclick = () => attempt(async () => {
    selected = b.dataset.job;
    events = [];
    if ($('jobs-dialog')?.open) $('jobs-dialog').close();
    await refresh();
  }));

  const moreBtn = $('sidebar-more-jobs');
  if (moreBtn) moreBtn.onclick = () => openJobsDialog();
}

function openJobsDialog() {
  $('jobs-dialog').showModal();
  drawJobsDialog();
}

function drawJobsDialog() {
  if (!$('jobs-dialog')?.open) return;
  const allJobs = state.jobs || [];
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

  const filtered = allJobs.filter(j => {
    if (jobsFilter === 'running' && !['running', 'queued'].includes(j.status)) return false;
    if (jobsFilter === 'ready' && j.status !== 'ready') return false;
    if (jobsFilter === 'done' && !['done', 'merged'].includes(j.status)) return false;
    if (jobsFilter === 'cancelled' && !['cancelled', 'blocked', 'failed'].includes(j.status)) return false;
    if (q) {
      const matchGoal = (j.goal || '').toLowerCase().includes(q);
      const matchId = (j.id || '').toLowerCase().includes(q);
      const matchBranch = (j.branch || '').toLowerCase().includes(q);
      const matchProject = (j.project || '').toLowerCase().includes(q);
      const matchAgent = (names[j.current?.agent] || j.current?.agent || '').toLowerCase().includes(q);
      if (!matchGoal && !matchId && !matchBranch && !matchProject && !matchAgent) return false;
    }
    return true;
  });

  const listEl = $('jobs-dialog-list');
  if (!listEl) return;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty"><span class="empty-icon">⌁</span><b>${esc(t('ui.jobs.noMatch'))}</b></div>`;
    return;
  }

  listEl.innerHTML = filtered.map(j => {
    const isSelected = j.id === selected;
    const curAgent = j.current ? (names[j.current.agent] || j.current.agent) : null;
    const tasksDone = j.taskIndex ?? 0;
    const tasksTotal = j.tasks?.length ?? 0;
    return `
      <div class="job-card ${isSelected ? 'selected' : ''}" data-job-select="${esc(j.id)}">
        <div class="job-card-head">
          <div class="job-card-tags">
            <span class="tag">#${esc(j.id.slice(0, 8))}</span>
            ${j.project ? `<span class="tag">📁 ${esc(j.project)}</span>` : ''}
            <span class="status ${esc(j.status)}">${esc(statusLabel(j.status))}</span>
            ${isSelected ? `<span class="tag tag-on">✓ ${esc(t('ui.jobs.selected'))}</span>` : ''}
          </div>
          <time class="muted">${clock(j.createdAt)}</time>
        </div>
        <h3 class="job-card-goal">${esc(j.goal)}</h3>
        <div class="job-card-meta">
          <span>⎇ <b>${esc(j.branch || 'main')}</b></span>
          ${j.stage ? `<span>⚙ ${esc(j.stage)}</span>` : ''}
          ${curAgent ? `<span>👤 <b>${esc(curAgent)}</b></span>` : ''}
          ${tasksTotal ? `<span>📋 ${tasksDone}/${tasksTotal} tasks</span>` : ''}
          ${j.round ? `<span>↺ R${esc(j.round)}</span>` : ''}
        </div>
        <div class="job-card-actions">
          <button type="button" class="${isSelected ? 'primary-ghost' : 'primary'}" data-job-open="${esc(j.id)}">
            ${isSelected ? esc(t('ui.jobs.selected')) : esc(t('ui.jobs.select'))} →
          </button>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('[data-job-open], [data-job-select]').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      const id = el.dataset.jobOpen || el.dataset.jobSelect;
      if (id) {
        attempt(async () => {
          selected = id;
          events = [];
          $('jobs-dialog').close();
          view('work');
          await refresh();
        });
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
if (tabHash.get('j')) selected = tabHash.get('j');
function syncTab() {
  const q = new URLSearchParams({ p: curProject, s: curSession, ...(selected ? { j: selected } : {}) });
  if (location.hash.slice(1) !== q.toString()) history.replaceState(null, '', '#' + q);
  const s = state.sessions.find(x => x.id === curSession);
  document.title = `${s ? s.name + ' · ' : ''}${curProject || 'AI Team'} · Control Room`;
}
function drawSessions() {
  if (!state.projects.some(p => p.id === curProject)) curProject = state.projects[0]?.id || '';
  const list = state.sessions.filter(x => x.project === curProject);
  if (!list.some(x => x.id === curSession)) curSession = list.at(-1)?.id || '';
  $('session-project').innerHTML = state.projects.map(p => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join('');
  $('session-project').value = curProject;
  $('session-select').innerHTML = list.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('') || `<option value="">${esc(t('ui.session.none'))}</option>`;
  $('session-select').value = curSession;
}
// Bảng "node đang làm gì": dựng từ events đã có, không gọi thêm AI.
function slotLive(id) {
  const job = state.jobs.find(j => j.id === selected);
  if (!id || !job) return '';
  const mine = events.filter(e => e.from === id);
  // Codex gửi in_progress rồi completed cho cùng item: giữ bản mới nhất.
  const last = new Map(); for (const e of mine.filter(e => e.type === 'ACTIVITY')) last.set(e.details?.id ? e.details.id + (e.details.command || e.details.text || "") : e.seq, e); // id (item_1…) lặp lại giữa các lượt
  const acts = [...last.values()].slice(-40), res = mine.filter(e => ['RESULT', 'REVIEW_RESULT', 'CONCLUSION', 'BLOCKER'].includes(e.type)).at(-1);
  const cur = job.current?.agent === id ? job.current : null;
  return `<b>${esc(t(cur ? 'ui.slot.liveNow' : 'ui.slot.liveIdle', { stage: cur?.stage || '', time: cur ? duration((Date.now() - Date.parse(cur.startedAt)) / 60000) : '' }))}</b>${acts.length ? `<div class="live-log">${acts.map((e, i) => actView(e, i === acts.length - 1)).join('')}</div>` : ''}${res ? `<p class="muted">${esc(t('ui.slot.lastResult'))}</p><div class="chat-bubble">${esc(cut(res.summary, 800))}</div>` : ''}`;
}
const shortCmd = c => String(c || '').replace(/^"?[^"]*powershell(\.exe)?"?\s+(-NoProfile\s+)?-Command\s+/i, '');
function actView(e, open) {
  const d = e.details || {}, pre = (head, body) => `<details data-seq="${e.seq}" ${open ? 'open' : ''}><summary>${head}</summary><pre>${esc(String(body).slice(-6000))}</pre></details>`;
  if (d.type === 'command_execution') return pre(`<code>$ ${esc(cut(shortCmd(d.command), 160))}</code> <span class="muted">${d.status === 'in_progress' ? '…' : 'exit ' + d.exit_code}</span>`, shortCmd(d.command) + '\n\n' + (d.aggregated_output || ''));
  if (d.type === 'file_change') return `<div class="live-file">✎ ${(d.changes || []).map(c => esc(c.kind + ' ' + c.path)).join('<br>')}</div>`;
  if (d.type === 'agent_message') return `<div class="chat-bubble">${esc(cut(d.text, 3000))}</div>`;
  if (d.type === 'tool_result') return pre(`<span class="muted">↳ output${d.is_error ? ' (error)' : ''}</span>`, d.output);
  if (d.name) return pre(`<code>${esc(d.name)}</code> <span class="muted">${esc(cut(JSON.stringify(d.input || {}), 120))}</span>`, JSON.stringify(d.input || {}, null, 2));
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
function openSlot(kind, current) {
  slot = { kind, current };
  $('slot-live').innerHTML = slotLive(current); const lg = $('slot-live').querySelector('.live-log'); if (lg) lg.scrollTop = lg.scrollHeight;
  $('slot-title').textContent = t(current || kind !== 'builder' ? 'ui.slot.title' : 'ui.slot.addBuilderTitle', { role: roleLabel(kind) });
  $('slot-member').innerHTML = (current ? '' : `<option value="">${esc(t('ui.slot.none'))}</option>`) + state.agents.map(a => {
    const h = agentHealth(a);
    const healthText = h ? ` · ${h.label}${h.rem != null ? ' ' + h.rem + '%' : ''}` : '';
    return `<option value="${esc(a.id)}" ${a.id === current ? 'selected' : ''} ${kind === 'builder' && a.provider === 'antigravity' ? 'disabled' : ''}>${esc(a.label)} · ${esc(a.provider)} · ${esc(tierLabel(a.tier))}${healthText}</option>`;
  }).join('');
  $('slot-remove').hidden = !current; $('slot-filter').hidden = !current; $('slot-profile').hidden = !current;
  slotMember(); $('slot-dialog').showModal();
}
function slotMember() {
  const a = state.agents.find(x => x.id === $('slot-member').value);
  $('slot-prompt').value = a?.systemPrompt || ''; $('slot-prompt').disabled = !a;
  $('slot-info').textContent = a ? t('ui.slot.info', { roles: rolesText(a.id), model: (a.model || t('ui.profile.modelDefault')) + (a.effort ? ' · ' + effortLabel(a.effort) : '') }) : '';
}
async function saveSlot() {
  const { kind, current } = slot, next = $('slot-member').value;
  if (next && next !== current) {
    if (kind === 'builder' && current) await api(`members/${current}/role`, { kind, on: false });
    await api(`members/${next}/role`, { kind, on: true });
  }
  const a = state.agents.find(x => x.id === next);
  if (a && $('slot-prompt').value !== (a.systemPrompt || '')) await api(`members/${next}/profile`, { systemPrompt: $('slot-prompt').value });
  $('slot-dialog').close(); await refresh();
}
// Sơ đồ dựng lại từ roster + plan của task đang chọn: thêm member hay Manager đổi người là tự vẽ lại.
function drawFlow() {
  const job = state.jobs.find(j => j.id === selected), r = job?.roster || state.roster;
  const byId = Object.fromEntries(state.agents.map(a => [a.id, a]));
  const graph = !!job?.tasks?.some(x => x.kind === 'review'), gtasks = graph ? job.tasks : [];
  const depsOf = (x, i) => Array.isArray(x.dependsOn) ? x.dependsOn : i ? [i - 1] : [];
  // Task sửa tự động nằm cuối danh sách nhưng chạy trước node review của nó → tính độ sâu theo phụ thuộc, không theo chỉ số.
  const level = [], lv = (i, seen = new Set()) => level[i] ?? (seen.has(i) ? 0 : (seen.add(i), level[i] = depsOf(gtasks[i], i).filter(d => gtasks[d]).reduce((m, d) => Math.max(m, lv(d, seen) + 1), 0)));
  gtasks.forEach((x, i) => lv(i));
  const cols = graph ? Math.max(...level) + 1 : 1, colW = 190, shift = (cols - 1) * colW;
  const perCol = Array.from({ length: cols }, (_, c) => level.filter(l => l === c).length);
  const builders = graph ? [] : r.builders.filter(id => byId[id]), rowH = 68, top = 34;
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
  const runs = runningOf(job), live = new Set(runs.map(x => graph && x.task != null ? 't:' + x.task : nodeOfRun(x)));
  const active = new Set(job?.status === 'running' ? (job.stage === 'implement' ? runs.map(r => 'manager>b:' + r.agent) : [{ plan: job.round ? 'rework' : 'user>manager', test: 'b>tests', review: 'tests>reviewer', verify: 'reviewer>verifier', final: 'verifier>merge' }[job.stage]]) : []);
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
  const box = (key, title, subtitle, agentId, slot) => {
    const n = nodes[key], a = agentId && byId[agentId];
    const h = a ? agentHealth(a) : null;
    const cls = [
      (job ? live.has(key) : a?.state === 'working') && 'working',
      job && !live.has(key) && a?.state === 'working' && 'elsewhere',
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
    return `<g class="node ${cls}" ${slot ? `data-slot="${slot}" ${a ? `data-agent="${esc(agentId)}"` : ''} role="button" tabindex="0"` : ''} transform="translate(${n.x},${n.y - 24})"><title>${esc(tip)}</title><rect width="${n.w}" height="48" rx="8"/><rect class="ring" width="${n.w}" height="48" rx="8" pathLength="100" style="animation-delay:-${(Date.now() % 2000) / 1000}s"/>${healthDot}${titleEl}${subEl}</g>`;
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
  edges += edge('tests', 'reviewer', 'used') + edge('reviewer', 'verifier', 'used') + edge('verifier', 'merge', 'used');
  edges += `<path class="edge rework ${job?.round ? 'used' : ''} ${active.has('rework') ? 'active' : ''}" d="M${rv.x + rv.w / 2} ${rv.y - 24} C${rv.x + rv.w / 2} 4 ${mg.x + mg.w / 2} 4 ${mg.x + mg.w / 2} ${mg.y - 24}"/><text class="edge-label" x="${(rv.x + mg.x + mg.w) / 2}" y="14" text-anchor="middle">${esc(job?.round ? t('ui.flow.reworkRound', { n: job.round }) : t('ui.flow.rework'))}</text>`;
  // Người review/verify thực tế của job: đã chạy → Manager chọn (flow) → mặc định đội. Bước bị controller ép thêm ghi "bị ép".
  const rvId = job?.checkers?.reviewer || job?.flow?.reviewer || r.reviewer, vfId = job?.checkers?.verifier || job?.flow?.verifier || r.verifier;
  const forced = step => { const o = job?.flow?.overrides?.find(x => x.step === step); return o ? t('ui.flow.forced', { why: o.reasons.join('; ') }) : ''; };
  const named = (role, id) => `${role} · ${byId[id]?.label || '—'}`;
  const nodesSvg = box('user', t('ui.who.user'), t('ui.flow.goal')) + box('manager', named('Manager', r.manager), skipped('plan') ? t('ui.flow.fastPath') : sub(r.manager), r.manager || null, 'manager')
    + builders.map(id => box('b:' + id, named('Builder', id), sub(id), id, 'builder')).join('')
    + gtasks.map((x, i) => { const who = x.ranBy || x.agent; return box('t:' + i, `T${i + 1} · ${x.kind === 'review' ? 'Review' : x.auto ? t('ui.flow.fix') : 'Build'} · ${byId[who]?.label || '—'}`,
      x.done ? (x.kind === 'review' ? '✓ ' + (x.note || x.verdict || '') : '✓') + (x.attempts ? ' · ' + t('ui.flow.attempts', { n: x.attempts }) : '') : live.has('t:' + i) ? t('ui.flow.running') : x.attempts ? t('ui.flow.attempts', { n: x.attempts }) : cut(x.instruction, 40), who || null, x.kind === 'review' ? 'reviewer' : 'builder'); }).join('')
    + box('tests', 'Tests', research ? t('ui.flow.skipped') : t('ui.flow.testsBy')) + box('reviewer', named('Review', rvId), skipped('review') ? t('ui.flow.skipped') : forced('review') || sub(rvId), rvId || null, 'reviewer')
    + box('verifier', named('Verify', vfId), skipped('verify') ? t('ui.flow.skipped') : forced('verify') || sub(vfId), vfId || null, 'verifier') + box('merge', research ? t('ui.flow.conclusion') : t('ui.flow.approve'), job ? statusLabel(job.status) : 'merge');
  $('flow').innerHTML = builders.length || r.manager ? `<svg class="flow" viewBox="0 0 ${W} ${top + H + 6}" role="img" aria-label="${esc(t('ui.flow.aria'))}">${edges}${nodesSvg}</svg>` : `<p class="muted">${esc(t('ui.flow.empty'))}</p>`;
  const inRoster = new Set([r.manager, r.reviewer, r.verifier, ...r.builders]);
  const bench = state.agents.filter(a => !inRoster.has(a.id));
  $('bench').innerHTML = `<button data-slot="builder" class="primary-ghost">${esc(t('ui.slot.addBuilder'))}</button>${bench.length ? `<span>${esc(t('ui.flow.bench'))}</span>${bench.map(a => {
    const h = agentHealth(a);
    return `<button data-bench="${esc(a.id)}" class="${a.state} bench-chip ${h ? 'health-' + h.cls : ''}" title="${esc(h ? h.title : a.label)}">${h ? `<span class="health-dot-inline ${h.cls}"></span>` : ''}<span>${esc(a.label)} · ${esc(tierLabel(a.tier))}</span>${h ? `<small class="bench-health ${h.cls}">${h.label}${h.rem != null ? ' ' + h.rem + '%' : ''}</small>` : ''}</button>`;
  }).join('')}` : ''}`;
  document.querySelectorAll('g[data-slot]').forEach(g => g.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); g.onclick(); } });
}
function drawInspector() {
  const job = state.jobs.find(j => j.id === selected);
  $('message').disabled = !!job && ['merged', 'cancelled'].includes(job.status) || !job && !curProject;
  if (!job) { $('inspector').innerHTML = `<div class="empty"><span class="empty-icon">⌁</span><b>${esc(t('ui.inspector.emptyTitle'))}</b><span>${esc(t('ui.inspector.emptyText'))}</span></div>`; return; }
  const stopped = ['blocked', 'paused'].includes(job.status), finished = ['merged', 'cancelled'].includes(job.status), idle = ['paused', 'blocked', 'ready'].includes(job.status);
  const research = job.kind === 'research';
  const facts = [['Task', job.id], ...(job.kind ? [[t('ui.inspector.mode'), `${t('ui.kind.' + job.kind)} · ${t('ui.rigor.' + (job.rigor || 'standard'))}`]] : []), [t('ui.inspector.stage'), job.stage], ['Branch', job.branch], ['Commit', job.revision.slice(0, 12)], ['Worktree', job.worktree], [t('ui.inspector.round'), job.round], [t('ui.inspector.started'), clock(job.createdAt)], ...(job.metrics ? [[t('ui.inspector.debate'), Object.entries(job.metrics).map(([k, v]) => t('ui.metric.' + k) + ' ' + v).join(' · ')]] : []), ...(job.flow?.requested?.steps ? [[t('ui.inspector.flow'), job.flow.requested.steps.join(' → ') || '—']] : [])];
  // Tiến độ: bước đang chạy + ước tính dựa trên thời gian trung bình các bước agent trước đó.
  const progress = (() => {
    if (!['running', 'queued'].includes(job.status)) return '';
    const left = job.tasks.filter(x => !x.done).length, research = job.kind === 'research', light = job.rigor === 'light';
    const after = research ? (light ? 0 : 1) + (job.rigor === 'strict' ? 1 : 0) + 1 : 1 + (light ? 0 : 1) + 1;
    const steps = job.stage === 'plan' ? null : ({ implement: left + after, test: after, review: after, verify: 2, final: 1 })[job.stage] ?? after;
    const avg = job.durations?.length ? job.durations.reduce((a, b) => a + b, 0) / job.durations.length / 60000 : null;
    const cur = job.current, elapsed = cur ? (Date.now() - Date.parse(cur.startedAt)) / 60000 : null;
    const runs = runningOf(job);
    const lines = runs.length ? runs.map(r => t('ui.progress.now', { stage: r.task != null ? `${t(research ? 'ui.kind.research' : 'ui.kind.code')} T${r.task + 1}/${job.tasks.length}` : r.stage, who: names[r.agent] || r.agent, time: duration((Date.now() - Date.parse(r.startedAt)) / 60000) })) : [t('ui.progress.queued')];
    const eta = job.eta != null ? t('ui.eta', { time: duration(Math.max(1, job.eta)) }) : steps == null ? t('ui.progress.planning') : avg ? t('ui.progress.eta', { time: duration(Math.max(1, avg * steps - (elapsed || 0))), n: steps, avg: duration(avg) }) : t('ui.progress.noEta', { n: steps });
    return `<div class="progress-box"><span class="dot green"></span><div>${lines.map(l => `<b>${esc(l)}</b>`).join('<br>')}<br><span class="muted">${esc(eta)}</span>${job.waiting || state.resources.waitingReason ? `<br><span class="muted">${esc(job.waiting || state.resources.waitingReason)}</span>` : ''}</div></div>`;
  })();
  const attachments = job.attachments?.length ? `<p class="muted">📎 ${job.attachments.map(a => esc(a.split('/').pop())).join(', ')}</p>` : '';
  const waiting = job.status === 'waiting' ? `<div class="questions"><b>${esc(t('ui.question.title'))}</b><ol>${(job.questions || []).map(q => `<li>${esc(q)}</li>`).join('')}</ol><textarea id="answer" rows="4" placeholder="${esc(t('ui.question.placeholder'))}"></textarea><button class="primary" id="send-answer">${esc(t('ui.question.send'))}</button></div>` : '';
  const tasks = job.tasks.length ? `<ul class="task-list">${job.tasks.map((x, i) => `<li class="${runningOf(job).some(r => r.task === i) ? 'current' : ''} ${x.done ? 'done' : ''}"><b>${x.done ? '✓ ' : ''}T${i + 1} · ${esc(t('ui.inspector.difficulty', { n: x.difficulty ?? '?' }))}${x.estMinutes ? ' · ~' + esc(duration(x.estMinutes)) : ''}${x.dependsOn?.length ? ' · ' + esc(t('ui.inspector.after', { list: x.dependsOn.map(d => 'T' + (d + 1)).join(', ') })) : ''}</b> → ${esc(names[x.ranBy || x.agent] || x.ranBy || x.agent || t('ui.inspector.controllerPicks'))}${x.ranBy && x.agent && x.ranBy !== x.agent ? ` <span class="muted">(${esc(t('ui.inspector.plannedFor', { name: names[x.agent] || x.agent }))})</span>` : ''}${x.why ? `<br><span class="muted">${esc(cut(x.why, 160))}</span>` : ''}${x.skills?.length ? `<br><span class="skill-tags">${x.skills.map(n => `<span class="tag">${esc(n)}</span>`).join(' ')}</span>` : ''}${x.contextGaps?.length ? `<details><summary class="muted">${esc(t('ui.inspector.contextGaps', { n: x.contextGaps.length }))}</summary><ul>${x.contextGaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul></details>` : ''}</li>`).join('')}</ul>` : '';
  const risk = job.risk ? `<p class="muted">${esc(t('ui.inspector.risk'))} <b class="${job.risk === 'high' ? 'risk-high' : ''}">${esc(t('ui.risk.' + job.risk))}</b>${job.riskReasons?.length ? ' · ' + esc(job.riskReasons.join('; ')) : ''}</p>` : '';
  const steps = research ? [['Plan', job.tasks.length], [t('ui.kind.research'), job.taskIndex >= job.tasks.length && job.tasks.length], ['Review', job.reviewed === job.revision || job.skipped?.includes('review')], [t('ui.flow.conclusion'), job.status === 'done']]
    : [['Plan', job.tasks.length], ['Code', job.revision !== job.base], ['Tests', job.tested === job.revision], ['Review', job.reviewed === job.revision || job.skipped?.includes('review')], ['Verify', job.verified === job.revision || job.skipped?.includes('verify')], ['Merge', job.status === 'merged']];
  const c = job.conclusion, conclusion = c ? `<div class="conclusion"><b>${esc(t('ui.inspector.conclusion'))}</b>${c.confidence ? ` <span class="tag">${esc(t('ui.inspector.confidence', { n: c.confidence }))}</span>` : ''}<p>${esc(c.conclusion)}</p>${c.sources?.length ? `<details><summary>${esc(t('ui.inspector.sources'))} (${c.sources.length})</summary><ul>${c.sources.map(s => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}${c.openQuestions?.length ? `<details><summary>${esc(t('ui.inspector.open'))} (${c.openQuestions.length})</summary><ul>${c.openQuestions.map(s => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}</div>` : '';
  $('inspector').innerHTML = `<p class="task-goal">${esc(job.goal)}</p>${badge(job)}${progress}${attachments}${waiting}${conclusion}<dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${tasks}${risk}<div class="pipeline">${steps.map(([label, done]) => { const sk = job.skipped?.includes(String(label).toLowerCase()); return `<span class="step ${done ? 'done' : ''} ${sk ? 'skipped' : ''}">${sk ? '–' : done ? '✓' : '○'} ${label}${sk ? ' · ' + esc(t('ui.flow.skipped')) : ''}</span>`; }).join('')}</div>${job.error ? `<p class="error-box">${esc(job.error)}</p>` : ''}<div class="controls"><button data-action="${stopped ? 'resume' : 'pause'}" ${finished ? 'disabled' : ''}>${esc(t(stopped ? 'ui.inspector.resume' : 'ui.inspector.pause'))}</button><button data-action="cancel" ${finished ? 'disabled' : ''}>${esc(t('ui.inspector.cancel'))}</button><button id="view-diff">${esc(t('ui.common.viewDiff'))}</button><button data-action="review" ${idle ? '' : 'disabled'}>${esc(t('ui.inspector.rereview'))}</button>${research ? '' : `<button data-action="sync" ${idle ? '' : 'disabled'} title="${esc(t('ui.inspector.syncTitle', { branch: job.baseBranch }))}">${esc(t('ui.inspector.sync'))}</button>`}<select id="reassign" aria-label="${esc(t('ui.inspector.reassign'))}" ${!stopped ? 'disabled' : ''}><option value="">${esc(t('ui.inspector.reassign'))}…</option>${(job.roster || state.roster).builders.map(id => `<option value="${esc(id)}">${esc(names[id] || id)}</option>`).join('')}</select></div>${research ? '' : `<button id="merge" class="primary merge-button" ${job.status !== 'ready' ? 'disabled' : ''}>${esc(t('ui.inspector.merge', { branch: job.baseBranch }))}</button>`}<p class="muted">${esc(t('ui.inspector.note'))}</p>`;
  document.querySelectorAll('[data-action]').forEach(b => b.onclick = () => attempt(async () => {
    if (b.dataset.action === 'cancel' && !confirm(t('ui.inspector.confirmCancel'))) return;
    b.disabled = true; try { await api(`jobs/${selected}/control`, { action: b.dataset.action }); await refresh(); } finally { b.disabled = false; }
  }));
  $('reassign').onchange = () => attempt(async () => { if ($('reassign').value) await api(`jobs/${selected}/control`, { action: 'reassign', agent: $('reassign').value }); await refresh(); });
  $('view-diff').onclick = () => attempt(showDiff);
  if ($('merge')) $('merge').onclick = () => attempt(openMerge);
  if ($('send-answer')) $('send-answer').onclick = () => attempt(async () => { const v = $('answer').value.trim(); if (!v) return; await api(`jobs/${selected}/control`, { action: 'message', message: v }); await refresh(); });
}
async function showDiff() { const result = await api(`jobs/${selected}/diff`); $('diff-content').textContent = result.diff || t('ui.diff.empty'); if (result.status) $('diff-content').textContent += '\n\nWorking tree:\n' + result.status; $('diff-dialog').showModal(); }
async function openMerge() {
  const c = await api(`jobs/${selected}/merge-check`), job = state.jobs.find(j => j.id === selected);
  const checks = [[t('ui.merge.tested'), c.checks.tested], [t(c.checks.reviewSkipped ? 'ui.merge.reviewSkipped' : 'ui.merge.reviewed'), c.checks.reviewed], [t(c.checks.verifySkipped ? 'ui.merge.verifySkipped' : 'ui.merge.verified'), c.checks.verified], [t('ui.merge.baseUnchanged', { branch: job.baseBranch }), c.checks.baseUnchanged]];
  $('merge-check').innerHTML = `<p>${esc(t('ui.merge.summary', { code: c.code, branch: job.baseBranch, files: c.files, added: c.added, removed: c.removed }))}</p><p>${esc(t('ui.merge.risk'))} <b class="${c.risk === 'high' ? 'risk-high' : ''}">${esc(t('ui.risk.' + c.risk))}</b></p><ul class="check-list">${checks.map(([l, ok]) => `<li class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${esc(l)}</li>`).join('')}${c.reasons.map(x => `<li class="bad">⚠ ${esc(x)}</li>`).join('')}</ul>${c.checks.baseUnchanged ? '' : `<p class="error-box">${esc(t('ui.merge.baseChanged'))}</p>`}`;
  $('merge-confirm-label').textContent = t('ui.merge.confirm', { code: c.code });
  $('merge-confirm').value = ''; $('merge-confirm').hidden = $('merge-confirm-label').hidden = !c.needsConfirm;
  $('merge-go').disabled = !checks.every(([, ok]) => ok) || !c.checks.ready; $('merge-dialog').showModal();
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
const DECISION_TYPES = ['QUESTION', 'CONCLUSION', 'DECISION', 'BLOCKER', 'REWORK_REQUEST', 'REVIEW_RESULT', 'READY_FOR_MERGE', 'MERGED', 'REROUTE', 'CONFLICT', 'WARNING'];
const hueClass = id => 'hue-' + [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 8, 3);
const evLabel = type => dict['ui.ev.' + type] || fallback['ui.ev.' + type] || type;
function avatar(id) {
  const name = names[id] || id, letter = id === 'controller' ? '⚙' : ((String(name).match(/\p{L}|\d/u)?.[0] || '?') + (String(name).match(/\d+$/)?.[0] || '')).toUpperCase().slice(0, 3);
  const a = state?.agents?.find(x => x.id === id);
  const h = a ? agentHealth(a) : null;
  return `<span class="avatar-wrap"><span class="chat-avatar ${id === 'controller' ? 'sys' : hueClass(id)}" title="${esc(name)}">${esc(letter)}</span>${h ? `<span class="health-dot ${h.cls}" title="${esc(h.title)}"></span>` : ''}</span>`;
}
function drawTimeline() {
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
  const details = e => e.details ? `<details data-seq="${e.seq}" ${opened.has(String(e.seq)) ? 'open' : ''}><summary>${esc(t('ui.timeline.details'))}</summary><pre>${esc(JSON.stringify(e.details, null, 2))}</pre></details>` : '';
  timeline.innerHTML = filtered.length ? filtered.map(e => {
    if (SYSTEM_TYPES.includes(e.type)) return `<div class="chat-system"><span class="chat-type">${esc(evLabel(e.type))}</span><b>${esc(names[e.from] || e.from)}</b> ${esc(cut(e.summary, 300))}<time>${time(e)}</time>${details(e)}</div>`;
    const mine = e.from === 'user', cls = [mine && 'mine', e.from === 'controller' && 'from-system', e.type === 'BLOCKER' && 'alert', e.type === 'QUESTION' && 'question', ['READY_FOR_MERGE', 'MERGED'].includes(e.type) && 'success'].filter(Boolean).join(' ');
    return `<article class="chat-msg ${cls}">${mine ? '' : avatar(e.from)}<div class="chat-body"><div class="chat-head"><strong>${esc(names[e.from] || e.from)}</strong><span class="chat-to">→ ${esc(names[e.to] || e.to)}</span><span class="chat-type">${esc(evLabel(e.type))}</span><time>${time(e)}</time></div><div class="chat-bubble">${esc(e.summary)}</div>${details(e)}</div></article>`;
  }).join('') : `<div class="empty"><span class="empty-icon">◎</span><b>${esc(t('ui.timeline.emptyTitle'))}</b><span>${esc(t('ui.timeline.emptyText'))}</span></div>`;
  // Agent đang chạy: bong bóng "đang soạn" ba chấm.
  for (const cur of runningOf(job)) if (!filter || filter === cur.agent) timeline.insertAdjacentHTML('beforeend', `<article class="chat-msg typing">${avatar(cur.agent)}<div class="chat-body"><div class="chat-head"><strong>${esc(names[cur.agent] || cur.agent)}</strong><span class="chat-to">${esc(t('ui.chat.typing', { stage: cur.task != null ? `${cur.stage} T${cur.task + 1}` : cur.stage }))}</span></div><div class="chat-bubble"><span class="dots"><i></i><i></i><i></i></span></div></div></article>`);
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
            <button class="menu-item" data-usage="${esc(a.id)}">↻ ${esc(t('ui.members.checkQuota'))}</button>
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
    const actions = state.demo ? '' : `<button data-check="${esc(a.id)}">${esc(t('ui.login.check'))}</button><button data-profile="${esc(a.id)}">${esc(t('ui.members.profile'))}</button>${a.provider === 'claude' ? `<button data-usage="${esc(a.id)}">${esc(t('ui.members.checkQuota'))}</button><button data-term="${esc(a.id)}">${esc(t('ui.members.openTerminal'))}</button>` : ''}`;
    const cleanBuckets = dedupeBuckets(a.quota.buckets);
    const windows = cleanBuckets.map(b => b.windows.map(w => {
      const bName = b.name.replace(/[:\s]+$/, '');
      const winLabel = w.minutes ? `${esc(bName)} · ${esc(t('ui.quota.window', { time: duration(w.minutes) }))}` : (w.name && w.name !== 'used' && w.name !== 'quota' ? `${esc(bName)} · ${esc(w.name)}` : esc(bName));
      const remVal = w.remaining == null ? null : Math.max(0, Math.min(100, Math.round(w.remaining)));
      const usedVal = remVal == null ? null : Math.max(0, Math.min(100, Math.round(w.used != null ? w.used : (100 - remVal))));
      const remLabel = remVal == null ? '?' : `${t('ui.quota.windowRemaining', { n: remVal })} (${t('ui.quota.used', { n: usedVal })})`;
      return `<div class="quota-window"><label><span>${winLabel}</span><strong>${esc(remLabel)}</strong></label><progress max="100" value="${remVal ?? 0}"></progress><small>${esc(t('ui.quota.reset'))} ${w.resetText ? esc(w.resetText) : esc(clock(w.resetsAt) + untilReset(w.resetsAt))}</small></div>`;
    }).join('')).join('');
    const sp = a.speed?.samples ? t('ui.members.speed', { time: duration(a.speed.avgMinutesPerCall), tokens: a.speed.avgTokensPerCall >= 1000 ? Math.round(a.speed.avgTokensPerCall / 1000) + 'K' : a.speed.avgTokensPerCall, n: a.speed.samples }) : t('ui.members.speedUnknown');
    const mcpNames = Object.keys(a.mcp || {});
    const facts = [sp, mcpNames.length && 'MCP: ' + mcpNames.join(', '), t('ui.members.model', { model: (a.model || t('ui.profile.modelDefault')) + (a.effort ? ` · ${effortLabel(a.effort)}` : '') }), t('ui.members.tier', { tier: tierLabel(a.tier) }), !a.enabled && t('ui.members.disabled'), a.systemPrompt && t('ui.members.hasPrompt')].filter(Boolean).join(' · ');
    return `<article class="quota-card" data-agent-card="${esc(a.id)}"><h3>${esc(a.label)} <span class="tag">${esc(tag)}</span></h3><span class="muted">${esc(auth.account?.email || a.quota.account?.email || rolesText(a.id))}</span><div class="account-state ${connected ? 'connected' : ''}"><i class="dot ${connected ? 'green' : ''}"></i>${esc(auth.message || t('ui.members.notChecked'))}</div>${auth.sharedProfile ? `<span class="muted">${esc(t('ui.members.sharedProfile'))}</span>` : ''}${auth.cli ? `<span class="muted">CLI: ${esc(auth.cli)}</span>` : ''}<div class="member-actions"><button class="${connected ? '' : 'primary'}" data-login="${esc(a.id)}">${esc(t(state.demo ? 'ui.members.loginLive' : connected ? 'ui.members.relogin' : 'ui.login.start'))}</button>${actions}</div>${state.demo ? '' : roleChecks(a)}<span class="muted">${esc(facts)}</span><strong>${esc(quotaRemaining(a.quota))}</strong>${a.quota.error ? `<p class="error-box">${esc(a.quota.error)}</p>` : ''}${a.quota.note ? `<p class="muted">${esc(a.quota.note)}</p>` : ''}${a.quota.schemaUnknown ? `<p class="error-box">${esc(t('ui.quota.schemaUnknown'))}</p>` : ''}${windows}<span class="muted">${esc(t('ui.quota.updated', { time: clock(a.quota.checkedAt) }))}</span>${a.quota.raw ? `<details><summary>${esc(t('ui.quota.raw'))}</summary><pre>${esc(JSON.stringify(a.quota.raw, null, 2))}</pre></details>` : ''}</article>`;
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
  document.querySelectorAll('[data-usage]').forEach(b => b.onclick = () => attempt(async () => {
    b.disabled = true; b.textContent = t('ui.members.checking');
    try { const r = await api(`members/${b.dataset.usage}/usage`, {}); notice(r.parsed ? '' : t('ui.members.usageFailed', { text: r.text || '—' })); await refresh(); }
    finally { b.disabled = false; b.textContent = t('ui.members.checkQuota'); }
  }));
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
    if (!selected) selected = state.jobs.find(j => (!curProject || j.project === curProject) && (!curSession || j.sessionId === curSession))?.id;
    if (state.language && state.language !== lang) await loadLanguage(state.language);
    if (eventsOf !== selected) { events = []; eventsOf = selected; }
    if (selected) {
      const sel = selected; let more;
      do { more = await api(`jobs/${sel}/events?after=${events.at(-1)?.seq || 0}`); if (selected !== sel) { again = true; return; } events.push(...more); } while (more.length === 2000);
    }
    drawState(); drawTimeline();
  } finally { rendering = false; if (again) { again = false; refresh(); } }
}
const openTask = () => $('task-dialog').showModal();
['new-task', 'create-top'].forEach(id => $(id).onclick = openTask);
$('close-dialog').onclick = () => $('task-dialog').close(); $('close-diff').onclick = () => $('diff-dialog').close();
if ($('open-jobs-btn')) $('open-jobs-btn').onclick = openJobsDialog;
if ($('close-jobs')) $('close-jobs').onclick = () => $('jobs-dialog').close();
if ($('jobs-dialog-new')) $('jobs-dialog-new').onclick = () => { $('jobs-dialog').close(); openTask(); };
if ($('jobs-search')) $('jobs-search').oninput = e => { jobsSearchQuery = e.target.value; drawJobsDialog(); };
document.querySelectorAll('[data-job-filter]').forEach(b => {
  b.onclick = () => {
    jobsFilter = b.dataset.jobFilter;
    document.querySelectorAll('[data-job-filter]').forEach(x => x.classList.toggle('active', x === b));
    drawJobsDialog();
  };
});
$('task-form').onsubmit = e => { e.preventDefault(); attempt(async () => { $('submit-task').disabled = true; try { const job = await api('jobs', { project: $('project').value, goal: $('goal').value, files: pending.goal, mode: $('task-mode').value, sessionId: $('project').value === curProject ? curSession : undefined }); selected = job.id; events = []; $('task-dialog').close(); $('goal').value = ''; pending.goal = []; drawAttach('goal'); await refresh(); } finally { $('submit-task').disabled = false; } }); };
$('message-form').onsubmit = e => { e.preventDefault(); attempt(async () => { if (!selected) { const job = await api('jobs', { project: curProject, goal: $('message').value, files: pending.message, mode: $('task-mode').value, sessionId: curSession || undefined }); selected = job.id; $('message').value = ''; pending.message = []; drawAttach('message'); await refresh(); return; } await api(`jobs/${selected}/control`, { action: 'message', message: $('message').value, files: pending.message }); $('message').value = ''; pending.message = []; drawAttach('message'); await refresh(); }); };
$('clear-filter').onclick = () => { filter = null; drawState(); drawTimeline(); };
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('selected', x === b)); drawTimeline(); });
function view(name) {
  name = name === true ? 'members' : name || 'work';
  $('work-view').hidden = name !== 'work'; $('quota-view').hidden = name !== 'members'; $('security-view').hidden = name !== 'security';
  $('overview').classList.toggle('active', name === 'work'); $('quota-nav').classList.toggle('active', name === 'members'); $('security-nav').classList.toggle('active', name === 'security');
  if (name === 'security') drawSecurity();
}
// Bảng quyền: mô tả đúng những gì code đang áp dụng (sandbox, công cụ, mạng, bí mật, merge).
function drawSecurity() {
  const cols = ['manager', 'builder', 'reviewer', 'verifier', 'controller', 'you'];
  const rows = [
    ['read', 'Y Y Y Y Y Y'], ['edit', 'N Y N N N Y'], ['outside', 'N N N N N Y'], ['shell', 'P P P P Y Y'],
    ['network', state.projects.some(p => p.network) ? 'P P P P N Y' : 'N N N N N Y'], ['commit', 'N N N N Y Y'],
    ['merge', 'N N N N N Y'], ['push', 'N N N N N Y'], ['mcp', 'P P P P N Y'], ['secrets', 'N N N N N Y'], ['accounts', 'P P P P N Y'],
  ];
  const mark = { Y: ['ok', '✓'], N: ['no', '✗'], P: ['part', '~'] };
  const head = cols.map(c => `<th>${esc(c === 'controller' ? 'Controller' : c === 'you' ? t('ui.who.user') : roleLabel(c))}</th>`).join('');
  $('security-matrix').innerHTML = `<table class="sec-table"><thead><tr><th>${esc(t('ui.sec.capability'))}</th>${head}<th>${esc(t('ui.sec.how'))}</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><th>${esc(t('ui.sec.row.' + k))}</th>${v.split(' ').map(x => `<td class="${mark[x][0]}">${mark[x][1]}</td>`).join('')}<td class="how">${esc(t('ui.sec.how.' + k))}</td></tr>`).join('')}</tbody></table><p class="muted">✓ ${esc(t('ui.sec.legendYes'))} · ~ ${esc(t('ui.sec.legendPart'))} · ✗ ${esc(t('ui.sec.legendNo'))}</p>`;
  $('security-notes').innerHTML = `<h3>${esc(t('ui.sec.projects'))}</h3><ul>${state.projects.map(p => `<li><b>${esc(p.id)}</b> · ${esc(p.path)} · ${esc(t(p.network ? 'ui.sec.networkOn' : 'ui.sec.networkOff'))}${p.readDirs.length ? ' · ' + esc(t('ui.sec.readDirs')) + ': ' + esc(p.readDirs.join(', ')) : ''}</li>`).join('') || `<li>${esc(t('ui.task.noProject'))}</li>`}</ul><h3>${esc(t('ui.sec.dataTitle'))}</h3><ul>${['data1', 'data2', 'data3', 'data4'].map(k => `<li>${esc(t('ui.sec.' + k))}</li>`).join('')}</ul><h3>${esc(t('ui.sec.adviceTitle'))}</h3><ul>${['advice1', 'advice2', 'advice3'].map(k => `<li>${esc(t('ui.sec.' + k))}</li>`).join('')}</ul>`;
}
$('overview').onclick = () => view('work');
$('security-nav').onclick = () => view('security');
$('quota-nav').onclick = () => attempt(async () => { view('members'); recheckMembers(); $('quota-history').textContent = JSON.stringify(await api('quota-history'), null, 2); });
$('refresh-quota').onclick = () => attempt(async () => { await api('quota', {}); notice(t('ui.members.refreshing')); });
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
    <label class="profile-check"><input type="checkbox" data-net="${esc(p.id)}" ${p.network ? 'checked' : ''}> ${esc(t('ui.project.network'))}</label>
    <label>${esc(t('ui.project.readDirs'))} (${p.readDirs.length})</label><textarea rows="2" data-dirs="${esc(p.id)}">${esc(p.readDirs.join('\n'))}</textarea>
    <button type="button" data-save-project="${esc(p.id)}">${esc(t('ui.project.saveChanges'))}</button></details></div>`).join('')}` : '';
  const q = (attr, id) => document.querySelector(`[${attr}="${id}"]`);
  document.querySelectorAll('[data-save-project]').forEach(b => b.onclick = () => attempt(async () => {
    const id = b.dataset.saveProject;
    const r = await api(`projects/${id}/update`, { tests: q('data-tests', id).value, network: q('data-net', id).checked, readDirs: q('data-dirs', id).value });
    await refresh(); projectList(); if (r.warnings?.length) throw new Error(r.warnings.join('\n'));
  }));
  document.querySelectorAll('[data-remove-project]').forEach(b => b.onclick = () => attempt(async () => {
    const id = b.dataset.removeProject; if (!confirm(t('ui.project.confirmRemove', { id }))) return;
    try { await api(`projects/${id}/remove`, {}); }
    catch (e) { if (e.status !== 409 || !confirm(e.message + '\n\n' + t('ui.project.cancelJobsAndRemove'))) throw e; await api(`projects/${id}/remove`, { cancelJobs: true }); }
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
function selectSessionJob() {
  const own = state.jobs.filter(j => j.project === curProject && (!curSession || j.sessionId === curSession));
  if (!own.some(j => j.id === selected)) { selected = own[0]?.id; events = []; filter = null; }
  refresh();
}
$('session-project').onchange = () => { curProject = $('session-project').value; curSession = ''; store.set('project', curProject); drawSessions(); selectSessionJob(); };
$('session-select').onchange = () => { curSession = $('session-select').value; store.set('session', curSession); selectSessionJob(); };
$('session-tab').onclick = () => window.open(location.pathname + '#' + new URLSearchParams({ p: curProject }), '_blank');
$('session-new').onclick = () => attempt(async () => { const name = prompt(t('ui.session.newPrompt')); if (name === null) return; const s = await api('sessions', { project: curProject, name }); curSession = s.id; store.set('session', s.id); selected = undefined; events = []; await refresh(); });
$('session-rename').onclick = () => attempt(async () => { if (!curSession) return; const name = prompt(t('ui.session.renamePrompt'), state.sessions.find(x => x.id === curSession)?.name || ''); if (name) { await api(`sessions/${curSession}/rename`, { name }); await refresh(); } });
$('close-slot').onclick = () => $('slot-dialog').close();
$('slot-member').onchange = slotMember;
$('slot-form').onsubmit = e => { e.preventDefault(); attempt(saveSlot); };
$('slot-remove').onclick = () => attempt(async () => { await api(`members/${slot.current}/role`, { kind: slot.kind, on: false }); $('slot-dialog').close(); await refresh(); });
$('slot-profile').onclick = () => { $('slot-dialog').close(); attempt(() => openProfile(slot.current)); };
$('slot-filter').onclick = () => { filter = slot.current; $('slot-dialog').close(); drawState(); drawTimeline(); };
$('close-merge').onclick = () => $('merge-dialog').close();
$('merge-view-diff').onclick = () => attempt(showDiff);
$('merge-go').onclick = () => attempt(async () => { $('merge-go').disabled = true; try { await api(`jobs/${selected}/merge`, { confirm: $('merge-confirm').value.trim() }); $('merge-dialog').close(); await refresh(); } finally { $('merge-go').disabled = false; } });
$('close-login').onclick = () => $('login-dialog').close();
$('start-login').onclick = () => attempt(async () => { $('start-login').disabled = true; try { await api(`members/${loginId}/login`, {}); await refresh(); } finally { drawLogin(); } });
$('check-login').onclick = () => attempt(async () => { await api(`members/${loginId}/refresh`, {}); await refresh(); });
$('cancel-login').onclick = () => attempt(async () => { await api(`members/${loginId}/cancel-login`, {}); await refresh(); });
$('theme-select').onchange = () => { store.set('theme', $('theme-select').value); applyTheme($('theme-select').value); };
// Ngôn ngữ lưu ở server (team.config.json) để thông báo do server tạo cũng đổi theo.
$('lang-select').onchange = () => attempt(async () => {
  const next = $('lang-select').value; store.set('lang', next);
  await api('settings', { language: next }).catch(e => notice(e.message));
  await loadLanguage(next); notice(''); if (state) { drawState(); drawTimeline(); }
});
document.addEventListener('click', e => {
  if (!e.target.closest('.actions-dropdown')) {
    document.querySelectorAll('.actions-dropdown[open]').forEach(d => d.removeAttribute('open'));
  }
});

await loadLanguage(store.get('lang') || 'vi');
await attempt(refresh);
const query = new URLSearchParams(location.search);
if (query.has('members')) { view(true); recheckMembers(); }
if (query.has('add') && state && !state.demo) { providerHint(); $('member-dialog').showModal(); }
if (query.has('member') && state?.agents.some(a => a.id === query.get('member'))) { loginId = query.get('member'); drawLogin(); $('login-dialog').showModal(); }
const stream = new EventSource('/api/stream'); stream.onmessage = () => attempt(refresh); stream.onerror = () => { $('connection').textContent = t('ui.nav.reconnecting'); };
setInterval(() => attempt(refresh), 10000);
