import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function fileHash(root, path) {
  if (typeof path !== 'string' || !path || /(^|[\\/])\.\.?([\\/]|$)|^[\\/]|:/.test(path)) throw new Error('Invalid memory file path');
  const target = resolve(root, path), base = realpathSync(root);
  if (!existsSync(target)) return null;
  if (!realpathSync(target).startsWith(base + sep)) throw new Error('Memory file is outside the worktree');
  const data = readFileSync(target), text = data.toString('utf8');
  // Git can check out the same text as LF or CRLF on different machines/worktrees.
  return hash(!data.includes(0) && Buffer.from(text).equals(data) ? text.replace(/\r\n/g, '\n') : data);
}

// SQLite owns the records; FTS is a rebuildable index, not the source of truth.
export class MemoryStore {
  constructor(db, redact) {
    this.db = db; this.redact = redact;
    const columns = new Set(db.prepare('PRAGMA table_info(memory)').all().map(x => x.name));
    for (const [name, type] of Object.entries({ uid: 'TEXT', scope: "TEXT NOT NULL DEFAULT 'project'", status: "TEXT NOT NULL DEFAULT 'active'", revision: 'INTEGER NOT NULL DEFAULT 1', commitSha: 'TEXT', source: "TEXT NOT NULL DEFAULT 'legacy'", files: "TEXT NOT NULL DEFAULT '{}'" })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE memory ADD COLUMN ${name} ${type}`);
    }
    for (const row of db.prepare('SELECT id,job FROM memory WHERE uid IS NULL').all()) {
      const job = row.job && db.prepare('SELECT body FROM jobs WHERE id=?').get(row.job);
      const owner = job && JSON.parse(job.body), code = owner && owner.kind !== 'research';
      db.prepare('UPDATE memory SET uid=?,scope=?,commitSha=? WHERE id=?').run(randomUUID(), code && owner.status !== 'merged' ? 'job' : 'project', code ? owner.revision || null : null, row.id);
    }
    const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name='memory_fts'").get();
    if (fts && !fts.sql.includes('remove_diacritics 2')) db.exec('DROP TRIGGER IF EXISTS memory_fts_insert; DROP TRIGGER IF EXISTS memory_fts_delete; DROP TRIGGER IF EXISTS memory_fts_update; DROP TABLE memory_fts;');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS memory_uid ON memory(uid);
      CREATE INDEX IF NOT EXISTS memory_scope ON memory(project,scope,job,status);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, files, content='memory', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid,text,files) VALUES(new.id,new.text,new.files); END;
      CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts,rowid,text,files) VALUES('delete',old.id,old.text,old.files); END;
      CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts,rowid,text,files) VALUES('delete',old.id,old.text,old.files);
        INSERT INTO memory_fts(rowid,text,files) VALUES(new.id,new.text,new.files); END;`);
    if (!fts || !fts.sql.includes('remove_diacritics 2')) db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  }
  rows(project, history = false) {
    return this.db.prepare(`SELECT * FROM memory WHERE project=? AND kind IN ('fact','retraction') ${history ? '' : "AND status='active' AND kind='fact'"} ORDER BY id`).all(project).map(r => ({ ...r, files: JSON.parse(r.files) }));
  }
  add({ project, text, job = 'user', scope = 'project', commitSha = null, source = 'user', files = {}, kind = 'fact', uid = randomUUID(), status = 'active', revision = 1, at = new Date().toISOString() }) {
    text = this.redact(String(text)).trim().slice(0, 2000);
    if (!text) return;
    return this.db.prepare('INSERT INTO memory(project,session,kind,text,job,at,uid,scope,status,revision,commitSha,source,files) VALUES(?,NULL,?,?,?,?,?,?,?,?,?,?,?)')
      .run(project, kind, text, job, at, uid, scope, status, revision, commitSha, this.redact(String(source)).slice(0, 1000), JSON.stringify(files)).lastInsertRowid;
  }
  retire(project, id, revision) {
    const result = this.db.prepare("UPDATE memory SET status='superseded',revision=revision+1 WHERE project=? AND id=? AND status='active' AND revision=?").run(project, Number(String(id).replace(/^M/i, '')), revision);
    if (!result.changes) throw new Error('Memory changed; reload before editing');
  }
  candidates(project, job, query = '', limit = 200, memoryId) {
    if (typeof query !== 'string' || query.length > 2000) throw new Error('Memory query is too long');
    limit = Math.max(1, Math.min(500, Number(limit) || 200));
    const visible = `m.project=? AND m.kind='fact' AND m.status='active' AND (m.scope='project' OR m.job=?) AND (? IS NULL OR m.id=?)
      AND NOT EXISTS(SELECT 1 FROM memory r WHERE r.project=m.project AND r.kind='retraction' AND r.status='active' AND r.text=m.uid AND (r.scope='project' OR r.job=?))`;
    const tokens = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) || [])].slice(0, 40);
    let rows = [];
    if (tokens.length) rows = this.db.prepare(`SELECT m.*,bm25(memory_fts) AS rank FROM memory_fts JOIN memory m ON m.id=memory_fts.rowid WHERE memory_fts MATCH ? AND ${visible} ORDER BY rank,m.id DESC LIMIT ?`)
      .all(tokens.map(t => `"${t}"`).join(' OR '), project, job || '', memoryId ?? null, memoryId ?? null, job || '', limit);
    // ponytail: substring fallback scans this project's notes; add a trigram index if Japanese queries become slow.
    if (!rows.length) rows = this.db.prepare(`SELECT m.* FROM memory m WHERE ${visible} AND (?='' OR m.text LIKE ? ESCAPE '\\' OR m.files LIKE ? ESCAPE '\\') ORDER BY m.id DESC LIMIT ?`)
      .all(project, job || '', memoryId ?? null, memoryId ?? null, job || '', query, `%${query.replace(/[\\%_]/g, '\\$&')}%`, `%${query.replace(/[\\%_]/g, '\\$&')}%`, limit);
    return rows.map(r => ({ ...r, files: JSON.parse(r.files) }));
  }
  promote(job) {
    for (const r of this.db.prepare("SELECT * FROM memory WHERE job=? AND scope='job' AND status='active'").all(job.id)) {
      if (r.commitSha && r.commitSha !== job.revision) { this.retire(job.project, r.id, r.revision); continue; }
      if (r.kind === 'retraction') this.db.prepare("UPDATE memory SET status='superseded',revision=revision+1 WHERE project=? AND uid=? AND status='active'").run(job.project, r.text);
      this.db.prepare("UPDATE memory SET scope='project',revision=revision+1 WHERE id=?").run(r.id);
    }
  }
  export(project) { return { format: 'ai-team-memory', version: 1, exportedAt: new Date().toISOString(), project, records: this.rows(project, true) }; }
  import(project, pack, jobMap = {}, validateOnly = false) {
    if (pack?.format !== 'ai-team-memory' || pack.version !== 1 || !Array.isArray(pack.records) || pack.records.length > 100000) throw new Error('Invalid memory package');
    const rows = pack.records.map(r => {
      if (!r || typeof r.uid !== 'string' || !/^[\w-]{1,100}$/.test(r.uid) || typeof r.text !== 'string' || !r.text.trim() || r.text.length > 2000 || !['fact','retraction'].includes(r.kind) || !['active','stale','superseded'].includes(r.status) || !['job','project'].includes(r.scope) || !Number.isSafeInteger(r.revision) || r.revision < 1 || typeof r.source !== 'string' || r.source.length > 1000 || r.job !== null && typeof r.job !== 'string' || typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at)) || !r.files || typeof r.files !== 'object' || Array.isArray(r.files)) throw new Error('Invalid memory record');
      for (const [p, h] of Object.entries(r.files)) if (!p || /(^|[\\/])\.\.?([\\/]|$)|^[\\/]|:/.test(p) || h !== null && !/^[a-f0-9]{64}$/.test(h)) throw new Error('Invalid memory file fingerprint');
      if (r.commitSha !== null && !/^[a-f0-9]{40,64}$/.test(r.commitSha)) throw new Error('Invalid memory commit');
      // Job notes need an imported owner; never silently turn them into shared knowledge.
      return { ...r, project, job: Object.hasOwn(jobMap, r.job) ? jobMap[r.job] : r.job, importedStatus: r.scope === 'job' && !Object.hasOwn(jobMap, r.job) ? 'stale' : r.status, text: this.redact(r.text), source: this.redact(r.source) };
    });
    if (validateOnly) return;
    let added = 0, conflicts = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        const old = this.db.prepare('SELECT * FROM memory WHERE uid=?').get(r.uid);
        const status = r.importedStatus;
        if (old) { if (old.project !== project || old.text !== r.text || old.kind !== r.kind || old.source !== r.source || old.job !== r.job || (old.status !== r.status && old.status !== status) || old.revision !== r.revision || old.files !== JSON.stringify(r.files) || old.commitSha !== r.commitSha || old.scope !== r.scope) conflicts++; continue; }
        this.add({ ...r, status }); added++;
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { added, conflicts, unchanged: rows.length - added - conflicts };
  }
}
