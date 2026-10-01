import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

// Thư viện skill: mọi SKILL.md đã cài trên máy (Claude, Codex, plugin, thư mục tự thêm).
// Member chạy với hồ sơ riêng nên không tự thấy các skill này; controller chép skill Lead chọn vào worktree.
export function skillRoots(config, home = homedir()) {
  return [
    ...(config.skillDirs || []),
    join(home, '.claude', 'skills'), join(home, '.claude', 'plugins'),
    join(home, '.codex', 'skills'), join(home, '.agents', 'skills'),
  ];
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const get = key => m && new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(m[1])?.[1].trim().replace(/^["']|["']$/g, '');
  return { name: get('name'), description: get('description') };
}

export function scanSkills(roots) {
  const found = new Map();
  const walk = (dir, depth) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) {
      const file = join(dir, 'SKILL.md'), meta = frontmatter(readFileSync(file, 'utf8'));
      const name = (meta.name || basename(dir)).replace(/[^\w.:-]+/g, '-').slice(0, 64);
      if (!found.has(name)) found.set(name, { name, description: (meta.description || '').slice(0, 300), dir, source: dir });
      return;
    }
    // ponytail: quét tối đa 7 cấp và bỏ node_modules/.git; plugin cài sâu hơn thì thêm thư mục vào skillDirs.
    if (depth >= 7) return;
    for (const e of entries) if (e.isDirectory() && !['node_modules', '.git'].includes(e.name)) walk(join(dir, e.name), depth + 1);
  };
  for (const root of roots) if (root && existsSync(root) && statSync(root).isDirectory()) walk(root, 0);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
