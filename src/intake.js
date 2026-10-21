// Tiếp nhận yêu cầu viết tự do (từ Chatwork/Telegram): tách thành các hành động cụ thể, hỏi lại khi mơ hồ (dự án nào, job nào),
// tóm tắt và chờ xác nhận trước khi tạo/điều khiển job. Phân tích bằng model rẻ (mặc định Claude Haiku; Claude hết quota/lỗi → Gemini),
// prompt kèm ảnh chụp trạng thái team; tất cả lỗi thì dùng luật đơn giản. Kết quả model chỉ là đề xuất: mã job/dự án luôn được kiểm lại.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { jobTitle } from './team.js';

const OPEN = j => !['merged', 'cancelled', 'done'].includes(j.status);
const short = j => `#${j.id.slice(0, 8)} ${jobTitle(j).slice(0, 50)}`;

// Chi tiết từng vòng của job được nhắc tới (trong tin nhắn hoặc vài lượt chat gần đây): để trả lời "vòng 2 sao sai", "vì sao chạy lại".
export function jobDigest(j) {
  const cut = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const rounds = (j.plans || []).filter(p => p.reason !== 'challenge').map((p, i) => ({ round: i + 1, plan: p.version, why: p.reason, trigger: cut(p.trigger, 200) || undefined, summary: cut(p.summary, 200), tasks: (p.tasks || []).map(t => `${t.agent}: ${cut(t.title || t.instruction, 80)}`) }));
  const checks = (j.reports || []).filter(r => ['test', 'review', 'verify'].includes(r.stage)).slice(-12).map(r => ({ stage: r.stage, agent: r.agent, verdict: r.verdict, summary: cut(r.summary, 200),
    findings: (r.findings || []).slice(0, 6).map(f => cut(typeof f === 'string' ? f : `${f.id || ''} [${f.impact || ''}] ${f.claim || ''}`, 160)), output: r.stage === 'test' && r.output ? cut(String(r.output).slice(-400), 400) : undefined }));
  return { id: j.id.slice(0, 8), title: jobTitle(j), status: j.status, stage: j.stage, goal: cut(j.goal, 300), rounds, checks, questions: j.questions?.length ? j.questions : undefined,
    blocked: j.blockedReason ? cut(JSON.stringify(j.blockedReason), 200) : undefined, error: cut(j.error, 300) || undefined, conclusion: cut(j.conclusion?.conclusion, 500) || undefined };
}

export function intakePrompt(team, text, leads = [], history = []) {
  // Gửi cả job đã xong/đã merge gần đây (không chỉ job đang mở) để trả lời được "job nào xong rồi", kèm giờ hiện tại và vài lượt chat trước.
  const day = t => t ? new Date(t).toLocaleString('sv-SE').slice(0, 16) : null;
  const projects = team.config.projects.map(p => p.id);
  const jobs = [...team.jobs()].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))).slice(0, 60)
    .map(j => ({ id: j.id.slice(0, 8), project: j.project, title: jobTitle(j).slice(0, 80), status: j.status, kind: j.kind, updated: day(j.updatedAt || j.createdAt), result: String(j.conclusion?.summary || j.planSummary || '').replace(/\s+/g, ' ').slice(0, 120) || undefined }));
  return `You route a project owner's chat request for a multi-agent coding team. Split it into concrete actions.
Now: ${day(Date.now())} (${Intl.DateTimeFormat().resolvedOptions().timeZone})
Projects: ${JSON.stringify(projects)}
Jobs, most recently updated first (status merged/done = finished; cancelled = dropped): ${JSON.stringify(jobs)}
Lead questions waiting for the owner: ${JSON.stringify(leads.map(l => ({ job: l.job.slice(0, 8), questions: l.questions })))}
Recent conversation (oldest first): ${JSON.stringify(history.slice(-6))}
Details of jobs mentioned (rounds = each plan and why it was redone; checks = test/review/verify results with findings): ${JSON.stringify(mentioned(team, [text, ...history.slice(-3).map(h => h.owner + ' ' + h.bot)].join(' ')).map(jobDigest)).slice(0, 12000)}
Request: ${JSON.stringify(String(text).slice(0, 3000))}
Return ONLY JSON: {"summary":"one line","actions":[{"type":"continue","job":"8-char id","note":"optional extra instruction"} | {"type":"new","project":"project id or null if unclear","title":"short title","goal":"self-contained goal in the request's language"} | {"type":"answer","job":"8-char id","text":"the owner's answer to that job's Lead questions"} | {"type":"result","job":"8-char id"} | {"type":"status"} | {"type":"chat","reply":"your reply"}],"questions":["only if something cannot be decided"]}
Rules: use "result" when the owner wants a job's result, evidence, screenshots, files or report (any status, including merged/done): the bot then sends the real report with attached files, so never describe or promise files yourself. Use "chat" (alone) for greetings, small talk and questions that do not ask the team to do anything: reply briefly and naturally as a friendly assistant, in the owner's language; answer questions about jobs/projects from the job list above, and questions like "why did round 2 fail / why was it rerun" from the job details (quote the concrete findings or test errors) (list matching jobs with id, title, status, date). Match project names loosely ("fe new" = "FE_NEW"). Use the recent conversation to resolve short follow-ups like "fe_new" or "cái đó". "status" only when the owner asks for an overview. Use "answer" when the request replies to a waiting Lead question. "continue" only for jobs that are not merged/done/cancelled. Use project null when the request does not make the project clear (do NOT guess). One "new" per independent feature. Keep the owner's language. Replies are shown in Chatwork: plain text only, no Markdown (no **, #, backticks).`;
}

const mentioned = (team, text) => [...new Set((String(text).match(/\b[0-9a-f]{4,12}\b/gi) || []).map(x => x.toLowerCase()))]
  .map(id => team.jobs().filter(j => j.id.startsWith(id))).filter(h => h.length === 1).map(h => h[0]).filter((j, i, a) => a.indexOf(j) === i).slice(0, 2);

// Luật dự phòng khi không có ChatGPT web: Lead đang hỏi → coi là câu trả lời; mã job → làm tiếp; còn lại là 1 job mới.
export function heuristic(team, text, leads = []) {
  if (leads.length) return { actions: [{ type: 'answer', job: leads.length === 1 ? leads[0].job : '', text: String(text) }], questions: [] };
  const ids = [...new Set((String(text).match(/#?\b[0-9a-f]{4,12}\b/gi) || []).map(x => x.replace('#', '').toLowerCase()))];
  const jobs = ids.map(id => team.jobs().find(j => j.id.startsWith(id))).filter(Boolean);
  if (jobs.length) return { actions: jobs.map(j => ({ type: 'continue', job: j.id, note: '' })), questions: [] };
  const project = team.config.projects.find(p => new RegExp(`\\b${p.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))?.id || null;
  if (!project && String(text).trim().length < 20) return { actions: [{ type: 'chat', reply: '' }], questions: [] }; // câu ngắn (chào hỏi…): không tạo job
  return { actions: [{ type: 'new', project, title: String(text).slice(0, 60), goal: String(text) }], questions: [] };
}

function parseJson(answer) {
  const start = answer.indexOf('{'), end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON');
  return JSON.parse(answer.slice(start, end + 1));
}

// Chuẩn hóa đề xuất: chỉ giữ hành động hợp lệ; chỗ thiếu/mơ hồ thành câu hỏi có lựa chọn đánh số.
export function normalize(team, plan, leads = []) {
  const projects = team.config.projects.map(p => p.id), open = team.jobs().filter(OPEN), actions = [], asks = [];
  for (const a of Array.isArray(plan?.actions) ? plan.actions : []) {
    if (a?.type === 'status') { actions.push({ type: 'status' }); continue; }
    if (a?.type === 'result') {
      const id = String(a.job || '').replace('#', '').toLowerCase(), hits = id.length >= 4 ? team.jobs().filter(j => j.id.startsWith(id)) : [];
      const action = { type: 'result', job: hits.length === 1 ? hits[0].id : null };
      actions.push(action);
      if (!action.job) asks.push({ action, field: 'job', q: 'Xem kết quả job nào?', options: (hits.length ? hits : team.jobs()).slice(0, 9).map(j => ({ value: j.id, label: short(j) })) });
      continue;
    }
    if (a?.type === 'chat') { actions.push({ type: 'chat', reply: String(a.reply || '').slice(0, 4000) }); continue; }
    if (a?.type === 'answer' && String(a.text || '').trim()) {
      const id = String(a.job || '').replace('#', '').toLowerCase(), hits = id.length >= 4 ? leads.filter(l => l.job.startsWith(id)) : [];
      const action = { type: 'answer', job: hits.length === 1 ? hits[0].job : leads.length === 1 && !id ? leads[0].job : null, text: String(a.text).slice(0, 20000) };
      actions.push(action);
      if (!action.job) asks.push({ action, field: 'job', q: 'Trả lời câu hỏi của job nào?', options: leads.map(l => ({ value: l.job, label: short(team.jobs().find(j => j.id === l.job) || { id: l.job }) })) });
      continue;
    }
    if (a?.type === 'continue') {
      const hits = open.filter(j => j.id.startsWith(String(a.job || '').replace('#', '').toLowerCase()) && String(a.job || '').length >= 4);
      const action = { type: 'continue', job: hits.length === 1 ? hits[0].id : null, note: String(a.note || '').slice(0, 2000) };
      actions.push(action);
      if (!action.job) asks.push({ action, field: 'job', q: `Làm tiếp job nào${a.job ? ` ("${a.job}")` : ''}?`, options: (hits.length ? hits : open).slice(0, 9).map(j => ({ value: j.id, label: short(j) })) });
      continue;
    }
    if (a?.type === 'new' && String(a.goal || '').trim()) {
      const action = { type: 'new', project: projects.includes(a.project) ? a.project : null, title: String(a.title || a.goal).slice(0, 60), goal: String(a.goal).slice(0, 20000) };
      actions.push(action);
      if (!action.project) asks.push(projects.length === 1 ? (action.project = projects[0], null) : { action, field: 'project', q: `"${action.title}" làm trong dự án nào?`, options: projects.map(id => ({ value: id, label: id })) });
    }
  }
  return { actions, asks: asks.filter(Boolean), notes: (Array.isArray(plan?.questions) ? plan.questions : []).map(String).slice(0, 3) };
}

export function summary(actions) {
  return actions.map((a, i) => `${i + 1}. ${a.type === 'new' ? `Giao việc mới [${a.project}]: ${a.title}` : a.type === 'continue' ? `Làm tiếp #${a.job.slice(0, 8)}${a.note ? ` · ${a.note.slice(0, 80)}` : ''}` : a.type === 'answer' ? `Trả lời Lead #${a.job.slice(0, 8)}: ${a.text.slice(0, 80)}` : a.type === 'result' ? `Gửi kết quả #${a.job.slice(0, 8)}` : 'Xem tổng quan'}`).join('\n');
}

// Model phân tích: Claude (model rẻ, mặc định haiku) trước, rồi Gemini; bỏ member đã báo hết quota (remaining = 0).
export function agentAsk(team, { model = 'haiku', log = () => {} } = {}) {
  if (typeof team.agentRun !== 'function') return null;
  const usable = a => a.enabled !== false && team.remaining?.(a.id) !== 0;
  return async prompt => {
    const claude = team.config.agents.filter(a => a.provider === 'claude' && usable(a)).map(a => ({ ...a, model, effort: undefined, mcp: undefined }));
    const gemini = team.config.agents.filter(a => (a.provider === 'gemini' || a.provider === 'antigravity' && /gemini/i.test(a.model || '')) && usable(a));
    const dir = join(team.dataDir, 'intake'); mkdirSync(dir, { recursive: true }); // thư mục trống: model không có gì để đọc ngoài prompt
    let last = new Error('không có member Claude/Gemini còn quota');
    for (const agent of [...claude.slice(0, 1), ...gemini.slice(0, 1)]) {
      try { return await team.agentRun(agent, { stage: 'intake', kind: 'code', worktree: dir, checks: [], idleTimeoutMin: 2, maxCallMin: 3 }, prompt, { onEvent: () => {} }); }
      catch (e) { last = e; log(`intake ${agent.id}: ${e.message.slice(0, 200)}`); }
    }
    throw last;
  };
}

export async function analyze(team, text, ask, leads = [], history = []) {
  let plan;
  if (ask) try { const out = await ask(intakePrompt(team, text, leads, history)); plan = typeof out === 'string' ? parseJson(out) : out; } catch { plan = null; }
  const result = normalize(team, plan || heuristic(team, text, leads), leads);
  return result.actions.length ? result : normalize(team, heuristic(team, text, leads), leads);
}
