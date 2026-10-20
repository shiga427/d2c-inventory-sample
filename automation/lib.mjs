// automation 共通（純粋な補助。秘密は扱わない）
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const E = require(resolve(ROOT, 'engine.js'));

export function readJSON(p) { return JSON.parse(readFileSync(p, 'utf8')); }
export function writeJSON(p, obj) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 1) + '\n'); }
export function loadConfig(path) { return readJSON(path || resolve(ROOT, 'automation/config.json')); }
export function abs(p) { return resolve(ROOT, p); }

/* 今日の日付（JST）。Actions は UTC なので Date をそのまま使わない */
export function jstToday(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function jstNow(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'medium' }).format(now).replace(' ', 'T') + '+09:00';
}
export function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !!E.toDate(s); }
export function dateRange(from, to) { const out = []; for (let d = from; d <= to; d = E.addDays(d, 1)) out.push(d); return out; }

/* --key value / --flag の簡易パーサ */
export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { o[k] = v; i++; } else o[k] = true; }
    else o._.push(a);
  }
  return o;
}

/* GitHub Actions のログに警告を出す（ローカルでは普通の stderr） */
export function warn(msg) { console.error(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `⚠️ ${msg}`); }
export function summary(line) {
  console.log(line);
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (p) { try { writeFileSync(p, line + '\n', { flag: 'a' }); } catch {} }
}
export { existsSync };
