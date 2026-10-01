import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Chuỗi hiển thị nằm trong locales/<lang>.json (dùng chung server + giao diện). Không có key thì lùi về vi, rồi về chính key.
const dir = resolve(fileURLToPath(new URL('../locales', import.meta.url)));
export const languages = ['vi', 'en', 'ja'];
const cache = {};
let current = 'vi';
const load = lang => { try { return cache[lang] ??= JSON.parse(readFileSync(join(dir, `${lang}.json`), 'utf8')); } catch { return cache[lang] = {}; } };
export function setLanguage(lang) { if (languages.includes(lang)) current = lang; return current; }
export const getLanguage = () => current;
export function msg(key, vars = {}) {
  const text = load(current)[key] ?? load('vi')[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
}
