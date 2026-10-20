#!/usr/bin/env node
/* outputs/latest.md を Chatwork の1ルームに投稿する。
   環境変数: CHATWORK_TOKEN（API トークン）・CHATWORK_ROOM_ID（投稿先ルーム）・CHATWORK_DENY_ROOMS（投稿してはいけないルーム ID のカンマ区切り）・VIEW_URL（任意）
   使い方: node automation/post-chatwork.mjs [--file outputs/latest.md] [--dry-run]
   投稿してはいけないルームの一覧は Secret CHATWORK_DENY_ROOMS に置く（コードには書かない）。未設定なら投稿しない。
   配信先は、この判定のために作った専用ルーム。
   投稿に失敗しても exit 0（配信は出口。成果物は既にコミット済み。Actions には ::warning:: を出す）。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { abs, loadConfig, parseArgs, warn, summary } from './lib.mjs';

const BODY_LIMIT = 6000;
const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig(args.config);
const file = abs(args.file || resolve(cfg.outDir, 'latest.md'));
const mdText = readFileSync(file, 'utf8');
const viewUrl = process.env.VIEW_URL || '';

/* Markdown → Chatwork 記法（[info][title]...[/title]...[/info]）。表は「項目: 値（備考）」の行に */
export function toChatwork(text, url) {
  const lines = text.split('\n');
  const out = []; let title = ''; let section = null; let buf = [];
  const flush = () => { if (section !== null) { out.push(`[info][title]${section}[/title]${buf.join('\n')}[/info]`); } else if (buf.length) out.push(buf.join('\n')); section = null; buf = []; };
  const cell = (l) => l.split('|').slice(1, -1).map((s) => s.trim().replace(/\*\*/g, ''));
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (!l) continue;
    if (l.startsWith('# ')) { title = l.slice(2); continue; }
    if (l.startsWith('## ')) { flush(); section = l.slice(3); continue; }
    if (/^>\s*\[!IMPORTANT\]/.test(l)) { flush(); section = '結論'; continue; }
    if (/^>\s*\[!NOTE\]-?/.test(l)) { flush(); section = l.replace(/^>\s*\[!NOTE\]-?\s*/, '') || '根拠'; continue; }
    if (/^\|\s*-+/.test(l) || /^\|[-| ]+\|$/.test(l)) continue;
    if (l.startsWith('|')) {
      const c = cell(l);
      if (c.length >= 2 && c[0] === '' && c[1] === '') continue;
      if (c[0] === '項目' || c[0] === '期日') continue;
      if (c.length === 3) buf.push(c[2] && c[2] !== '—' ? `${c[0]}: ${c[1]}（${c[2]}）` : `${c[0]}: ${c[1]}`);
      else buf.push(c.filter(Boolean).join(': '));
      continue;
    }
    buf.push(l.replace(/^>\s?/, '').replace(/\*\*/g, ''));
  }
  flush();
  let body = `【自動通知】${title}\n` + out.join('\n');
  if (url) body += `\n閲覧ページ: ${url}`;
  if (body.length > BODY_LIMIT) body = body.slice(0, BODY_LIMIT - 40) + '\n…（続きはリポジトリの outputs/latest.md）';
  return body;
}

const body = toChatwork(mdText, viewUrl);
if (args['dry-run']) { console.log(body); process.exit(0); }

const token = (process.env.CHATWORK_TOKEN || process.env.CHATWORK_API_TOKEN || '').trim();
const room = String(process.env.CHATWORK_ROOM_ID || '').trim();
if (!token) { warn('CHATWORK_TOKEN が未設定なので投稿を飛ばしました'); process.exit(0); }
if (!/^\d+$/.test(room)) { warn('CHATWORK_ROOM_ID が未設定（数字のルームID）なので投稿を飛ばしました'); process.exit(0); }
const deny = new Set(String(process.env.CHATWORK_DENY_ROOMS || '').split(/[\s,]+/).filter(Boolean));
if (!deny.size) { warn('CHATWORK_DENY_ROOMS が未設定なので投稿を飛ばしました（投稿してはいけないルームを確かめられないため）'); process.exit(0); }
if (deny.has(room)) { console.error(`ルーム ${room} は投稿してはいけないルームです（CHATWORK_DENY_ROOMS）。専用ルームの ID を入れてください`); process.exit(1); }
try {
  const res = await fetch(`https://api.chatwork.com/v2/rooms/${room}/messages`, { method: 'POST', headers: { 'X-ChatWorkToken': token, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ body }).toString() });
  const text = await res.text();
  if (!res.ok) { warn(`Chatwork 投稿に失敗（status ${res.status}）: ${text.slice(0, 200)}`); process.exit(0); }
  summary(`chatwork: ルーム ${room} に投稿（${body.length} 文字・message_id ${(JSON.parse(text || '{}').message_id) || '?'}）`);
} catch (e) { warn(`Chatwork 投稿に失敗: ${e.message}`); process.exit(0); }
