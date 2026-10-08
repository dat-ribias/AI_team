// The ledger lives in job JSON; IDs are local to a discussion, never CLI identities.
export const short = (v, n = 2000) => typeof v === 'string' ? v.trim().slice(0, n) : '';
export const strings = v => (Array.isArray(v) ? v : []).slice(0, 6).map(x => short(x, 500)).filter(Boolean);
export function scopeFiles(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some(p => typeof p !== 'string' || !p || p.length > 500 || /[\\:\x00-\x1f]|^\/|(^|\/)\.\.?($|\/)|(^|\/)(\.git|\.codex|\.aws)(\/|$)/i.test(p))) throw new Error('Invalid evidence file scope');
  return [...new Set(value)].sort();
}
export function ledger(d) {
  d.claims ||= [{ id: 'C1', statement: short(d.claim || d.topic), status: d.status === 'resolved' ? 'resolved' : 'open', by: d.from }];
  d.evidence ||= []; d.history ||= []; d.owners ||= [d.from];
  d.messages ||= [];
  for (const [i, m] of d.messages.entries()) {
    m.id ||= `M${i + 1}`; m.claimIds ||= ['C1']; m.evidenceIds ||= [];
    if (m.type === 'question') m.delivery ||= d.messages.slice(i + 1).some(r => r.type === 'reply') ? 'answered' : 'stored';
  }
  return d;
}
export function claimIds(d, values) {
  const ids = values == null ? [d.claims[0].id] : values;
  if (!Array.isArray(ids) || !ids.length || ids.length > 8 || ids.some(id => !d.claims.some(c => c.id === id))) throw new Error('Unknown claim reference');
  return [...new Set(ids)];
}
export function addClaims(d, values, by) {
  if (values == null) return;
  if (!Array.isArray(values) || values.length > 4 || d.claims.length + values.length > 12) throw new Error('Too many claims');
  for (const v of values) {
    if (!short(v?.statement)) throw new Error('A claim needs a statement');
    d.claims.push({ id: `C${d.claims.length + 1}`, statement: short(v.statement), status: 'open', by });
  }
}
export function evidence(d, sources, ids, snapshot, by, kind = 'citation', check) {
  const created = [];
  for (const source of strings(sources)) {
    if (d.evidence.length >= 60) throw new Error('Evidence limit reached');
    const e = { id: `E${d.evidence.length + 1}`, source, claimIds: ids, snapshot, by, kind, status: 'current', at: new Date().toISOString(), ...(check ? { check } : {}) };
    d.evidence.push(e); created.push(e.id);
  }
  return created;
}
export function question(d, request, snapshot, by) {
  ledger(d); addClaims(d, request.claims, by);
  const ids = claimIds(d, request.claimIds), proof = evidence(d, request.evidence, ids, snapshot, by);
  const m = { id: `M${d.messages.length + 1}`, by, type: 'question', text: short(request.question), claimIds: ids, evidence: strings(request.evidence), evidenceIds: proof, snapshot, delivery: 'stored', at: new Date().toISOString() };
  d.messages.push(m); return m;
}
export function answer(d, report, snapshot, by) {
  const q = d.messages.findLast(m => m.type === 'question' && m.delivery !== 'answered');
  if (!q || report.replyTo != null && report.replyTo !== q.id) throw new Error('Reply does not address the pending message');
  const ids = claimIds(d, report.claimIds ?? q.claimIds);
  if (ids.length !== q.claimIds.length || q.claimIds.some(id => !ids.includes(id))) throw new Error('Reply must address every requested claim');
  // ponytail: legacy scalar answers address the single pending question; explicit IDs reject mismatched replies.
  const proof = evidence(d, report.evidence, ids, snapshot, by);
  const m = { id: `M${d.messages.length + 1}`, replyTo: q.id, by, type: 'reply', text: short(report.answer), stance: report.stance, claimIds: ids, evidence: strings(report.evidence), evidenceIds: proof, snapshot, at: new Date().toISOString() };
  d.messages.push(m); q.delivery = 'answered'; q.answerId = m.id; return m;
}
export function refreshLedger(d, snapshot) {
  ledger(d);
  for (const e of d.evidence) if (e.snapshot?.fingerprint && e.snapshot.fingerprint !== snapshot.fingerprint) e.status = 'stale';
  if (d.status !== 'resolved' || !d.decision?.snapshot?.fingerprint || d.decision.snapshot.fingerprint === snapshot.fingerprint || d.freshness === 'historical') return false;
  d.history.push({ ...d.decision, reopenedAt: new Date().toISOString() }); d.history = d.history.slice(-12);
  d.status = 'reopened'; d.reason = 'Evidence scope changed; the decision must be checked again';
  d.claims.forEach(c => { c.status = 'open'; }); return true;
}
export function decide(d, report, snapshot, by) {
  if (report?.thread !== d.id || !['accepted', 'rejected', 'unresolved'].includes(report.outcome) || !short(report.reason)) throw new Error('A reasoned discussion decision is required');
  for (const key of ['conditions', 'remaining']) if (report[key] !== undefined && (!Array.isArray(report[key]) || report[key].length > 6 || report[key].some(v => typeof v !== 'string'))) throw new Error('Conditions and remaining obligations must be arrays of at most six strings');
  const ids = claimIds(d, report.claimIds ?? d.messages.findLast(m => m.type === 'question')?.claimIds);
  const created = evidence(d, report.evidence, ids, snapshot, by);
  const refs = report.evidenceIds == null ? created : report.evidenceIds;
  if (!Array.isArray(refs) || refs.length > 12 || refs.some(id => !d.evidence.some(e => e.id === id && e.status === 'current' && ids.some(c => e.claimIds.includes(c)))) || refs.length && ids.some(c => !refs.some(id => d.evidence.find(e => e.id === id).claimIds.includes(c)))) throw new Error('Decision references missing, unrelated or stale evidence');
  if (report.outcome === 'rejected' && !refs.length) throw new Error('Rejection needs evidence');
  for (const c of d.claims.filter(c => ids.includes(c.id))) { c.status = report.outcome === 'unresolved' ? 'open' : 'resolved'; c.resolution = report.outcome; }
  const remaining = strings(report.remaining);
  d.decision = { outcome: report.outcome, choice: short(report.choice || report.reason), reason: short(report.reason), claimIds: ids, evidence: strings(report.evidence), evidenceIds: [...new Set([...refs, ...created])], conditions: strings(report.conditions), remaining, by, at: new Date().toISOString(), snapshot };
  const closed = report.outcome !== 'unresolved' && !remaining.length && d.claims.every(c => c.status === 'resolved');
  if (closed) for (const m of d.messages) if (m.type === 'question' && m.delivery !== 'answered') { m.delivery = 'withdrawn'; m.withdrawnBy = by; }
  return closed;
}
export function obligations(discs) {
  return (discs || []).filter(d => d.status !== 'resolved').map(d => ({ id: d.id, topic: short(d.topic, 200), task: d.task, stage: d.stage, owner: d.owner || d.from, to: d.to, status: d.status, claims: (d.claims || [{ id: 'C1', statement: d.claim || d.topic }]).map(c => ({ id: c.id, statement: short(c.statement), status: c.status })), pending: d.messages?.filter(m => m.type === 'question' && !['answered', 'withdrawn'].includes(m.delivery)).map(m => ({ id: m.id, text: short(m.text), claimIds: m.claimIds })) || [], remaining: strings(d.decision?.remaining), reason: short(d.reason) }));
}
