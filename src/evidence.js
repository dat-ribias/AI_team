import { lstatSync, realpathSync, readdirSync, mkdirSync, openSync, closeSync, fstatSync, readSync, writeFileSync, constants } from 'node:fs';
import { resolve, relative, dirname, extname, isAbsolute, win32 } from 'node:path';
import { secret } from './transfer.js';

export function safeRel(path) {
  if (typeof path !== 'string' || !path || /[:\x00-\x1f]/.test(path) || isAbsolute(path) || win32.isAbsolute(path)) throw new Error('Unsafe evidence path');
  const rel = path.replace(/\\/g, '/');
  if (rel.split('/').some(p => p === '..')) throw new Error('Unsafe evidence path');
  return rel;
}

export function kind(path) {
  const ext = extname(path).slice(1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['log', 'txt', 'md', 'json', 'xml', 'csv'].includes(ext)) return 'text';
  return 'other';
}

export function collect({ worktree, paths, dest, maxBytes, usedBytes = 0 }) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0 || !Number.isFinite(usedBytes) || usedBytes < 0) throw new Error('Invalid evidence size limit');
  mkdirSync(dest, { recursive: true });
  const root = realpathSync(worktree), files = [], skipped = [], seen = new Set();
  const archive = realpathSync(dest);
  let bytes = 0, full = false;
  const inside = file => { const rel = relative(root, file); return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')); };
  const visit = path => {
    let rel;
    try { rel = safeRel(path); } catch { skipped.push({ path: String(path), reason: 'Unsafe evidence path' }); return; }
    if (seen.has(rel)) return;
    seen.add(rel);
    if (rel.split('/').some(p => p.toLowerCase() === '.git')) { skipped.push({ path: rel, reason: 'Git metadata' }); return; }
    if (rel.split('/').some(secret) || /credentials|secret/i.test(rel)) { skipped.push({ path: rel, reason: 'Credential file' }); return; }
    if (full) { skipped.push({ path: rel, reason: 'Evidence size limit exceeded' }); return; }
    const source = resolve(root, rel);
    try {
      // Inspect every component: a regular file can still be reached through a junction.
      for (let p = source; p !== root; p = dirname(p)) {
        if (!inside(p)) throw new Error('Evidence path is outside the worktree');
        if (lstatSync(p).isSymbolicLink()) throw new Error('Symlink or junction');
        if (!inside(realpathSync(p))) throw new Error('Evidence path is outside the worktree');
      }
      const stat = lstatSync(source);
      if (stat.isDirectory()) { for (const name of readdirSync(source).sort()) visit(`${rel.replace(/\/$/, '')}/${name}`); return; }
      if (!stat.isFile()) { skipped.push({ path: rel, reason: 'Not a regular file' }); return; }
      if (usedBytes + bytes + stat.size > maxBytes) { full = true; skipped.push({ path: rel, reason: 'Evidence size limit exceeded' }); return; }
      const target = resolve(archive, rel);
      mkdirSync(dirname(target), { recursive: true });
      for (let p = dirname(target); p !== archive; p = dirname(p)) {
        if (lstatSync(p).isSymbolicLink() || relative(archive, realpathSync(p)).split(/[\\/]/)[0] === '..') throw new Error('Unsafe evidence destination');
      }
      const fd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || !inside(realpathSync(source))) throw new Error('Evidence file changed during collection');
        // Bound reads as well as writes if the producer grows a file during collection.
        const data = Buffer.alloc(stat.size + 1);
        let length = 0, count;
        while (length < data.length && (count = readSync(fd, data, length, data.length - length, null))) length += count;
        if (length !== stat.size) throw new Error('Evidence file changed during collection');
        writeFileSync(target, data.subarray(0, length), { flag: 'wx' });
      } finally { closeSync(fd); }
      bytes += stat.size; files.push({ path: rel, bytes: stat.size, type: kind(rel) });
    } catch (e) { if (e.code !== 'ENOENT') skipped.push({ path: rel, reason: e.message }); }
  };
  for (const path of paths) visit(path);
  return { files, skipped, bytes };
}
