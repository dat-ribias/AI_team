// Điều khiển nhanh AI Team qua tin nhắn: Chatwork (ưu tiên) và Telegram. Cả hai dùng polling nên KHÔNG cần tunnel/IP công khai.
// Chỉ người trong danh sách cho phép (allow) mới ra lệnh được; token đọc từ biến môi trường hoặc team.config.json, không ghi ra log.
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { jobTitle } from './team.js';
import { agentAsk, analyze, summary } from './intake.js';

const NEEDS = { approve_plan: 'chờ duyệt plan', answer_questions: 'Lead đang hỏi', diagnose: 'vướng', review_merge: 'sẵn sàng merge', wait_quota: 'chờ quota' };
const HELP = `Lệnh bắt đầu bằng / (mã job chỉ cần 4+ ký tự đầu):
/status — tổng quan · /can — việc cần bạn · /jobs — việc đang mở
/job <id> — chi tiết · /ketqua <id> — kết quả để duyệt (ảnh trước/sau, test, review) · /new [dự-án:] <mục tiêu> — giao việc mới
/duyet <id> — duyệt plan · /msg <id> <nội dung> — gửi chỉ dẫn / trả lời Lead
/pause|/resume|/cancel <id> · /merge <id> [mã xác nhận] · /quota · /help
Không có / là viết tự do (vd "làm tiếp a1b2 và thêm nút xuất CSV cho web"): bot phân tích, hỏi lại chỗ chưa rõ, rồi chờ bạn gõ y để làm.`;
const YES = /^(y|yes|ok|có|co|đồng ý|dong y|làm đi)$/i, NO = /^(n|no|không|khong|hủy|huy|thôi)$/i;

export function parseCommand(text) {
  const clean = String(text || '').replace(/^.*\[(?:To|rp)[^\]]*\].*$/gim, '').replace(/\[download:\d+\][\s\S]*?\[\/download\]|\[preview[^\]]*\]/g, '').replace(/\[\/?(?:info|title|code)\]/g, '').trim();
  const slash = clean.startsWith('/'), body = slash ? clean.slice(1).trim() : clean;
  const [cmd = '', ...rest] = body.split(/\s+/);
  return { cmd: cmd.toLowerCase().replace(/@\w+$/, ''), args: rest, rest: body.slice(cmd.length).trim(), clean, slash };
}

export class Bot {
  constructor(team, config = {}, { fetch: f = globalThis.fetch, log = console.log, env = process.env } = {}) {
    this.team = team; this.fetch = f; this.log = log; this.timers = []; this.seen = new Map(); this.stopped = false;
    this.chatwork = config.chatwork && { ...config.chatwork, token: env.CHATWORK_TOKEN || config.chatwork.token, allow: (config.chatwork.allow || []).map(String) };
    this.telegram = config.telegram && { ...config.telegram, token: env.TELEGRAM_BOT_TOKEN || config.telegram.token, allow: (config.telegram.allow || []).map(String) };
    this.defaultProject = config.defaultProject; this.notify = config.notify !== false;
    this.startedAt = Date.now(); // tin gửi lúc server tắt (trước mốc này) bị bỏ qua, không xử lý bù
    this.reports = []; // job vừa sẵn sàng merge / nghiên cứu xong: gửi kết quả kèm ảnh
    this.inbox = new Map(); // chat → file/ảnh vừa gửi kèm ({name, data base64, at}), dùng cho việc giao kế tiếp
    this.history = new Map(); // chat → vài lượt hỏi/đáp gần nhất, để hiểu câu hỏi nối tiếp
    this.pending = new Map(); // chat → yêu cầu đang hỏi lại / chờ xác nhận
    // Phân tích yêu cầu tự do bằng model rẻ (bot.intakeModel, mặc định haiku; Claude hết quota → Gemini); intake: false → chỉ dùng luật.
    this.ask = config.intake === false ? null : agentAsk(team, { model: config.intakeModel || 'haiku', log });
  }

  // ---------- lệnh ----------
  find(prefix) {
    const id = String(prefix || '').replace(/^#/, '').toLowerCase();
    if (id.length < 4) throw new Error('cần mã job (ít nhất 4 ký tự)');
    const hits = this.team.jobs().filter(j => j.id.startsWith(id));
    if (hits.length !== 1) throw new Error(hits.length ? `mã ${id} trùng ${hits.length} job, gõ dài hơn` : `không có job ${id}`);
    return hits[0];
  }
  line(j) { const s = this.team.jobSummary(j); return `#${j.id.slice(0, 8)} ${jobTitle(j).slice(0, 60)} · ${NEEDS[s.next] || s.status}${s.stage && s.status === 'running' ? ' · ' + s.stage : ''}`; }
  async run(text, chat = 'local') {
    const { cmd, args, rest, slash, clean } = parseCommand(text), team = this.team;
    const waiting = (this.inbox.get(chat) || []).length;
    if (!slash && !clean && waiting) return `Đã nhận ${waiting} file. Nhắn việc cần làm với file này (vd "lỗi như ảnh ở trang danh sách của web" hoặc "gửi cho job a1b2").`;
    if (!slash) return clean ? this.intake(text, chat) : HELP; // không có / → yêu cầu viết tự do
    const open = () => team.jobs().filter(j => !['merged', 'cancelled', 'done'].includes(j.status));
    switch (cmd) {
      case '': case 'help': case 'h': return HELP;
      case 'status': {
        const jobs = open(), needs = jobs.filter(j => NEEDS[team.jobSummary(j).next]);
        return `Đang chạy ${jobs.filter(j => j.status === 'running').length} · cần bạn ${needs.length} · đang mở ${jobs.length}\n` + needs.slice(0, 8).map(j => '⚑ ' + this.line(j)).join('\n');
      }
      case 'can': case 'needs': { const needs = open().filter(j => NEEDS[team.jobSummary(j).next]); return needs.length ? needs.map(j => '⚑ ' + this.line(j)).join('\n') : 'Không có việc nào chờ bạn.'; }
      case 'jobs': { const jobs = open().filter(j => !args[0] || j.project === args[0]); return jobs.length ? jobs.slice(0, 20).map(j => this.line(j)).join('\n') : 'Không có việc đang mở.'; }
      case 'job': {
        const j = this.find(args[0]), s = team.jobSummary(j);
        const tasks = (j.tasks || []).map((x, i) => `  T${i + 1} ${x.done ? '✓' : '·'} ${x.ranBy || x.agent || ''} ${String(x.title || x.instruction || '').slice(0, 60)}`).join('\n');
        return `${this.line(j)}\nDự án ${j.project} · vòng ${j.round || 0}${s.reason ? '\nLý do: ' + s.reason : ''}${j.questions?.length ? '\nCâu hỏi:\n- ' + j.questions.join('\n- ') : ''}${tasks ? '\nTask:\n' + tasks : ''}`;
      }
      case 'new': {
        let project = this.defaultProject, goal = rest;
        const m = rest.match(/^([\w.-]+):\s+([\s\S]+)$/); if (m && team.config.projects.some(p => p.id === m[1])) [, project, goal] = m;
        if (!project) project = team.config.projects[0]?.id;
        if (!goal) throw new Error('thiếu mục tiêu: new [dự-án:] <mục tiêu>');
        const files = this.takeFiles(chat), job = await team.create({ project, goal, ...(files.length ? { files } : {}) });
        return `Đã giao #${job.id.slice(0, 8)} (${project}). Lead sẽ lập plan.`;
      }
      case 'ketqua': case 'result': return this.report(this.find(args[0]));
      case 'duyet': case 'approve': {
        const j = this.find(args[0]), p = j.plans?.at(-1);
        if (j.status !== 'waiting' || !j.planGate || !p) throw new Error('job không chờ duyệt plan');
        await team.control(j.id, 'approve-plan', { version: p.version, hash: p.hash });
        return `Đã duyệt plan v${p.version} của #${j.id.slice(0, 8)}: ${(p.tasks || []).length} task.`;
      }
      case 'msg': case 'tl': { const j = this.find(args[0]), body = rest.slice(args[0].length).trim(); if (!body) throw new Error('thiếu nội dung'); const files = this.takeFiles(chat); await team.control(j.id, 'message', { message: body, ...(files.length ? { files } : {}) }); return `Đã gửi chỉ dẫn cho #${j.id.slice(0, 8)}${files.length ? ` kèm ${files.length} file` : ''}.`; }
      case 'pause': case 'resume': case 'cancel': { const j = this.find(args[0]); await team.control(j.id, cmd); return `${cmd} #${j.id.slice(0, 8)}: xong.`; }
      case 'merge': {
        const j = this.find(args[0]);
        try { await team.merge(j.id, { confirm: args[1] }); return `Đã merge #${j.id.slice(0, 8)} hoặc đã vào hàng merge.`; }
        catch (e) { return `Chưa merge được: ${e.message}${/mã|code/i.test(e.message) ? `\nGõ lại: /merge ${args[0]} <mã>` : ''}`; }
      }
      case 'quota': return (team.config.agents || []).map(a => { const r = team.remaining(a.id); return `${a.label || a.id}: ${r == null ? '?' : Math.round(r) + '%'}`; }).join('\n');
      default: return `Không có lệnh /${cmd}.\n${HELP}`;
    }
  }
  async answer(text, chat = 'local') { try { return await this.run(text, chat); } catch (e) { this.pending.delete(chat); return `Lỗi: ${e.message}`; } }

  takeFiles(chat) {
    const files = (this.inbox.get(chat) || []).filter(f => Date.now() - f.at < 30 * 60_000).slice(-10).map(({ name, data }) => ({ name, data }));
    this.inbox.delete(chat); return files;
  }

  // ---------- yêu cầu viết tự do ----------
  async intake(text, chat) {
    const { clean } = parseCommand(text), p = this.pending.get(chat);
    if (p?.asks?.length && /^\d+$/.test(clean)) {
      const ask = p.asks[0], opt = ask.options[Number(clean) - 1];
      if (!opt) return `Chọn số 1-${ask.options.length}.`;
      ask.action[ask.field] = opt.value; p.asks.shift();
      return this.nextStep(chat, p);
    }
    if (p?.confirm && YES.test(clean)) { this.pending.delete(chat); return this.execute(p.actions, p.files); }
    if (p?.confirm && NO.test(clean)) { this.pending.delete(chat); return 'Đã hủy, không làm gì.'; }
    if (!p && (YES.test(clean) || NO.test(clean) || /^\d+$/.test(clean))) return 'Không có yêu cầu nào đang chờ bạn chọn/xác nhận.';
    this.pending.delete(chat); // tin nhắn khác = yêu cầu mới, bỏ yêu cầu đang dở
    const leads = this.team.jobs().filter(j => j.questions?.length && this.team.jobSummary(j).next === 'answer_questions').map(j => ({ job: j.id, questions: j.questions.slice(0, 5) }));
    const names = (this.inbox.get(chat) || []).map(f => f.name);
    const history = this.history.get(chat) || [], plan = await analyze(this.team, names.length ? `${clean}\n[Owner attached files: ${names.join(', ')}]` : clean, this.ask, leads, history);
    const reply = await this.respond(chat, plan);
    this.history.set(chat, [...history, { owner: clean.slice(0, 500), bot: String(reply.text ?? reply).slice(0, 500) }].slice(-6));
    return reply;
  }
  async respond(chat, plan) {
    if (!plan.actions.length) return `Chưa hiểu yêu cầu.\n${HELP}`;
    const replies = plan.actions.filter(a => a.type === 'chat').map(a => a.reply).filter(Boolean).join('\n'), work = plan.actions.filter(a => !['chat', 'status', 'result'].includes(a.type));
    // Xem kết quả chỉ đọc: gửi ngay (kèm file), không cần xác nhận; job chưa rõ thì hỏi lại như các việc khác.
    const results = plan.actions.filter(a => a.type === 'result');
    if (results.length && !work.length) {
      if (results.some(a => !a.job)) return this.nextStep(chat, { actions: results, asks: plan.asks, notes: [] });
      const reports = await Promise.all(results.slice(0, 3).map(a => this.report(this.team.jobs().find(j => j.id === a.job))));
      return { text: [replies, ...reports.map(r => r.text)].filter(Boolean).join('\n\n'), files: reports.flatMap(r => r.files) };
    }
    if (!work.length) return plan.actions.some(a => a.type === 'status') ? this.run('/status', chat) : replies || 'Mình nghe đây. Cần giao việc gì cứ nhắn, hoặc /help để xem lệnh.';
    const files = this.takeFiles(chat);
    const next = this.nextStep(chat, { actions: [...work, ...results], asks: plan.asks, notes: [...(plan.notes || []), ...(files.length ? [`kèm ${files.length} file: ${files.map(f => f.name).join(', ')}`] : [])], files });
    return replies ? `${replies}\n\n${next}` : next;
  }
  nextStep(chat, p) {
    this.pending.set(chat, p);
    if (p.asks.length) { const a = p.asks[0]; return `${a.q}\n${a.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\n(gõ số)`; }
    if (p.actions.every(a => a.type === 'result')) { this.pending.delete(chat); return this.execute(p.actions, p.files); }
    p.confirm = true;
    return `Mình hiểu là:\n${summary(p.actions)}${p.notes?.length ? '\nLưu ý: ' + p.notes.join(' · ') : ''}\nĐồng ý? (y/n)`;
  }
  async execute(actions, attach = []) {
    const out = [], files = [];
    // File gửi kèm đi theo việc đầu tiên nhận được file (giao mới / chỉ dẫn / trả lời Lead).
    const give = () => { const f = attach; attach = []; return f.length ? { files: f } : {}; };
    for (const a of actions) {
      try {
        if (a.type === 'new') { const job = await this.team.create({ project: a.project, goal: a.goal, title: a.title, ...give() }); out.push(`✓ Đã giao #${job.id.slice(0, 8)} (${a.project}): ${a.title}`); continue; }
        const j = this.team.jobs().find(x => x.id === a.job); if (!j) throw new Error(`không còn job ${a.job.slice(0, 8)}`);
        if (a.type === 'result') { const r = await this.report(j); out.push(r.text); files.push(...r.files); continue; }
        if (a.type === 'answer') { await this.team.control(j.id, 'message', { message: a.text, ...give() }); out.push(`✓ Đã trả lời Lead #${j.id.slice(0, 8)}`); continue; }
        if (['paused', 'blocked'].includes(j.status)) await this.team.control(j.id, 'resume');
        if (a.note || attach.length) await this.team.control(j.id, 'message', { message: a.note || 'Xem file đính kèm.', ...give() });
        const next = this.team.jobSummary(j).next;
        out.push(`✓ #${j.id.slice(0, 8)}: ${a.note ? 'đã gửi chỉ dẫn' : ['paused', 'blocked'].includes(j.status) ? 'đã chạy tiếp' : 'đang ' + j.status}${next === 'approve_plan' ? ` · đang chờ duyệt plan (gõ /duyet ${j.id.slice(0, 8)})` : ''}`);
      } catch (e) { out.push(`✗ ${a.type} ${a.job?.slice(0, 8) || a.title}: ${e.message}`); }
    }
    return files.length ? { text: out.join('\n'), files } : out.join('\n');
  }

  // Kết quả để chủ duyệt từ xa, không cần đọc diff: tóm tắt từng task, test, review/verify, rủi ro, file đổi,
  // kèm ảnh preview trước/sau và báo cáo test mà team đã lưu làm bằng chứng cho đúng revision hiện tại.
  async report(j) {
    const team = this.team, cut = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n), last = {};
    for (const r of j.reports || []) if (['implement', 'research'].includes(r.stage)) last[r.task ?? 0] = r;
    const lines = [`📋 ${this.line(j)}`, `Dự án ${j.project}${j.risk ? ' · rủi ro ' + j.risk : ''}`, `Mục tiêu: ${cut(j.goal, 300)}`];
    if (j.planSummary) lines.push(`Kế hoạch: ${cut(j.planSummary, 300)}`);
    (j.tasks || []).forEach((t, i) => lines.push(`T${i + 1} ${t.done ? '✓' : '·'} ${t.ranBy || t.agent || ''}: ${cut(t.title || t.instruction, 90)}${last[i] ? `\n   → ${cut(last[i].summary, 220)}` : ''}`));
    if (j.conclusion) lines.push(`Kết luận: ${cut(j.conclusion.conclusion, 1200)}`);
    const tests = (j.checkResults || []).filter(c => c.revision === j.revision);
    if (tests.length) lines.push('Test: ' + tests.slice(-5).map(c => `${c.code === 0 ? '✓' : '✗ exit ' + c.code} ${cut(c.command.join(' '), 60)}`).join(' · '));
    for (const r of (j.reports || []).filter(r => ['review', 'verify'].includes(r.stage) && r.revision === j.revision).slice(-2)) {
      const open = (r.findings || []).filter(f => typeof f === 'string' || !['resolved', 'rejected'].includes(f.status));
      lines.push(`${r.stage === 'review' ? 'Review' : 'Verify'} (${r.agent}): ${r.verdict || '?'}${open.length ? ` · ${open.length} điểm: ` + open.slice(0, 3).map(f => cut(typeof f === 'string' ? f : f.claim, 100)).join(' | ') : ''}`);
    }
    const check = j.kind === 'research' ? null : await team.mergeCheck?.(j).catch(() => null);
    if (check) {
      if (check.reasons.length) lines.push('Cần chú ý: ' + check.reasons.map(r => cut(r, 160)).join(' · '));
      lines.push(`File đổi ${check.files} (+${check.added} −${check.removed}): ` + check.paths.slice(0, 15).map(p => `${p.path} +${p.added}−${p.removed}`).join(', ') + (check.paths.length > 15 ? ' …' : ''));
      if (j.status === 'ready') lines.push(`Duyệt: /merge ${j.id.slice(0, 8)}${check.needsConfirm ? ' ' + check.code : ''} · muốn sửa thì nhắn thẳng điều cần sửa`);
    }
    // Ảnh preview của controller trước, rồi bằng chứng của các thành viên; giới hạn số file và 5 MB/file (giới hạn của Chatwork).
    const entries = (j.evidence || []).filter(e => e.revision === j.revision).sort((a, b) => (b.stage === 'preview') - (a.stage === 'preview'));
    const files = entries.flatMap(e => e.files.map(f => ({ ...f, abs: join(team.dataDir || '', 'evidence', j.id, e.dir, f.path) })))
      .filter(f => ['image', 'html'].includes(f.type) && f.bytes <= 5 * 2 ** 20);
    // File sản phẩm (tài liệu Word/Excel/PDF/PowerPoint/CSV/Markdown): từ bằng chứng của job nghiên cứu, hoặc file job code thêm/sửa trong worktree.
    const DOC = /\.(docx?|xlsx?|pptx?|pdf|csv|md)$/i, size = p => { try { return statSync(p).size; } catch { return Infinity; } };
    const docs = [...entries.flatMap(e => e.files.filter(f => DOC.test(f.path) && !/^(before|after)-/.test(f.path)).map(f => join(team.dataDir || '', 'evidence', j.id, e.dir, f.path))),
      ...(check?.paths || []).filter(p => DOC.test(p.path) && j.worktree && !p.path.includes(':')).map(p => join(j.worktree, p.path))]
      .filter(p => size(p) <= 5 * 2 ** 20).slice(0, 5);
    const paths = [...docs, ...files.filter(f => f.type === 'image').slice(0, 8).map(f => f.abs), ...files.filter(f => f.type === 'html').slice(0, 2).map(f => f.abs)];
    if (docs.length) lines.push('File kết quả: ' + docs.map(p => basename(p)).join(', '));
    if (paths.length) lines.push(`Đính kèm ${paths.length} file.`);
    return { text: lines.join('\n'), files: paths };
  }

  // Báo khi một job chuyển sang trạng thái cần chủ xử lý hoặc vừa xong.
  changes() {
    const out = [];
    for (const j of this.team.jobs()) {
      const s = this.team.jobSummary(j), key = `${s.status}|${s.next}|${j.planGate?.version || ''}|${j.questions?.length || 0}`;
      const before = this.seen.get(j.id); this.seen.set(j.id, key);
      if (before === undefined || before === key) continue;
      if (s.next === 'answer_questions' && j.questions?.length) out.push(`❓ ${this.line(j)}\n${j.questions.slice(0, 5).map((q, i) => `${i + 1}) ${q}`).join('\n')}\n→ Trả lời thẳng vào chat (không cần lệnh msg).`);
      else if (s.next === 'review_merge' || s.status === 'done' && j.kind === 'research') this.reports.push(j.id); // gửi kèm kết quả đầy đủ
      else if (NEEDS[s.next]) out.push('⚑ ' + this.line(j));
      else if (['merged', 'done'].includes(s.status)) out.push('✓ ' + this.line(j));
    }
    return out;
  }

  // ---------- kênh ----------
  async cw(method, path, body) {
    const res = await this.fetch(`https://api.chatwork.com/v2${path}`, { method, headers: { 'X-ChatWorkToken': this.chatwork.token, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body) : undefined });
    if (res.status === 204) return [];
    if (!res.ok) throw new Error(`Chatwork ${res.status}`);
    return res.json();
  }
  async pollChatwork() {
    const c = this.chatwork;
    if (!c.me) {
      const me = await this.cw('GET', '/me'); c.me = me.account_id;
      // Chế độ cài đặt (allow rỗng): báo bot chạy bằng tài khoản nào, và trả account_id cho người nhắn để thêm vào allow.
      if (!c.allow.length) await this.cw('POST', `/rooms/${c.roomId}/messages`, { body: `[info][title]AI Team bot[/title]Đang chạy bằng tài khoản ${me.name} (${me.account_id}). Chưa ai được phép ra lệnh: nhắn một tin bất kỳ để nhận account_id của bạn, rồi thêm vào bot.chatwork.allow.[/info]` });
    }
    for (const m of await this.cw('GET', `/rooms/${c.roomId}/messages?force=0`)) {
      const from = String(m.account?.account_id);
      if (from === String(c.me) || m.send_time * 1000 < this.startedAt) continue;
      if (!c.allow.length && !this.seen.has('cw:' + from)) { this.seen.set('cw:' + from, 1); await this.cw('POST', `/rooms/${c.roomId}/messages`, { body: `[rp aid=${from} to=${c.roomId}-${m.message_id}]\naccount_id của bạn: ${from}. Thêm vào bot.chatwork.allow rồi khởi động lại server.` }); }
      if (!c.allow.includes(from)) continue;
      // Ảnh/file gửi kèm ([download:id]): tải về để giao cùng việc (agent đọc được ảnh mô tả lỗi).
      for (const [, id] of String(m.body).matchAll(/\[download:(\d+)\]/g)) await this.keep(`cw:${from}`, async () => {
        const info = await this.cw('GET', `/rooms/${c.roomId}/files/${id}?create_download_url=1`);
        return { name: info.filename, size: info.filesize, url: info.download_url };
      });
      const reply = await this.answer(m.body, `cw:${from}`);
      await this.cw('POST', `/rooms/${c.roomId}/messages`, { body: `[rp aid=${from} to=${c.roomId}-${m.message_id}]\n[info]${reply.text ?? reply}[/info]` });
      for (const f of reply.files || []) await this.cwFile(f);
    }
  }
  async tg(method, body) {
    const res = await this.fetch(`https://api.telegram.org/bot${this.telegram.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json(); if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`); return data.result;
  }
  async pollTelegram() {
    const c = this.telegram;
    for (const u of await this.tg('getUpdates', { offset: c.offset, timeout: 0 })) {
      c.offset = u.update_id + 1;
      const m = u.message; if (!m || !c.allow.includes(String(m.chat.id)) || m.date * 1000 < this.startedAt) continue;
      const doc = m.document || m.photo?.at(-1);
      if (doc) await this.keep(`tg:${m.chat.id}`, async () => {
        const f = await this.tg('getFile', { file_id: doc.file_id });
        return { name: m.document?.file_name || basename(f.file_path), size: f.file_size, url: `https://api.telegram.org/file/bot${c.token}/${f.file_path}` };
      });
      if (!m.text && !m.caption && !doc) continue;
      const reply = await this.answer(m.text || m.caption || '', `tg:${m.chat.id}`);
      await this.tg('sendMessage', { chat_id: m.chat.id, text: reply.text ?? reply });
      for (const f of reply.files || []) await this.tgFile(m.chat.id, f);
    }
  }
  // Tải file người dùng gửi (≤ 15 MB, giới hạn đính kèm của job) vào hàng chờ của cuộc chat; lỗi thì bỏ qua file đó.
  async keep(chat, locate) {
    try {
      const f = await locate();
      if (f.size > 15 * 2 ** 20) throw new Error(`${f.name} lớn hơn 15 MB`);
      const res = await this.fetch(f.url); if (!res.ok) throw new Error(`tải ${f.name}: ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      this.inbox.set(chat, [...(this.inbox.get(chat) || []), { name: f.name, data: data.toString('base64'), at: Date.now() }].slice(-10));
    } catch (e) { this.log('bot file:', e.message); }
  }
  // Gửi file (ảnh, báo cáo HTML) dạng multipart; lỗi một file không chặn phần còn lại.
  async upload(url, fields, headers = {}) {
    const form = new FormData(); for (const [k, v] of Object.entries(fields)) Array.isArray(v) ? form.append(k, ...v) : form.append(k, v);
    const res = await this.fetch(url, { method: 'POST', headers, body: form });
    if (!res.ok) throw new Error(`upload ${res.status}`);
  }
  blob(path) { return new Blob([readFileSync(path)]); }
  cwFile(path) { return this.upload(`https://api.chatwork.com/v2/rooms/${this.chatwork.roomId}/files`, { file: [this.blob(path), basename(path)] }, { 'X-ChatWorkToken': this.chatwork.token }).catch(e => this.log('bot chatwork file:', e.message)); }
  tgFile(chat, path) { const photo = /\.(png|jpe?g|webp)$/i.test(path); return this.upload(`https://api.telegram.org/bot${this.telegram.token}/${photo ? 'sendPhoto' : 'sendDocument'}`, { chat_id: String(chat), [photo ? 'photo' : 'document']: [this.blob(path), basename(path)] }).catch(e => this.log('bot telegram file:', e.message)); }
  async broadcast(text, files = []) {
    if (this.chatwork?.token) { await this.cw('POST', `/rooms/${this.chatwork.roomId}/messages`, { body: `[info][title]AI Team[/title]${text}[/info]` }).catch(e => this.log('bot chatwork:', e.message)); for (const f of files) await this.cwFile(f); }
    if (this.telegram?.token) for (const id of this.telegram.allow) { await this.tg('sendMessage', { chat_id: id, text: 'AI Team\n' + text }).catch(e => this.log('bot telegram:', e.message)); for (const f of files) await this.tgFile(id, f); }
  }
  async tick() {
    if (this.chatwork?.token && this.chatwork.roomId) await this.pollChatwork().catch(e => this.log('bot chatwork:', e.message));
    if (this.telegram?.token) await this.pollTelegram().catch(e => this.log('bot telegram:', e.message));
    if (this.notify) {
      const lines = this.changes(); if (lines.length) await this.broadcast(lines.join('\n'));
      for (const id of this.reports.splice(0)) { const j = this.team.jobs().find(x => x.id === id); if (j) { const r = await this.report(j).catch(e => ({ text: `⚑ ${this.line(j)} (lỗi tạo kết quả: ${e.message})`, files: [] })); await this.broadcast(r.text, r.files); } }
    }
  }
  start(pollSec = this.chatwork?.pollSec || 10) {
    if (!this.chatwork?.token && !this.telegram?.token) return false;
    this.changes(); // mốc ban đầu: không báo lại những việc đã có trước khi bật bot
    const loop = async () => { if (this.stopped) return; await this.tick(); if (!this.stopped) this.timers.push(setTimeout(loop, pollSec * 1000)); };
    this.timers.push(setTimeout(loop, 1000));
    return true;
  }
  stop() { this.stopped = true; this.timers.forEach(clearTimeout); }
}
