#!/usr/bin/env node
/* engine.js の projectAll を回し、outputs/latest.json（判定全体）と outputs/latest.md（出力デザイン規約の形）を書く。
   先に automation/po.json（発注した・入荷した の2入力）を state.pos に反映する。
   使い方: node automation/run-judgment.mjs [--state data/sample-state.json] [--out outputs] [--asof YYYY-MM-DD] [--po automation/po.json] */
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { E, abs, readJSON, writeJSON, loadConfig, jstToday, jstNow, isDate, parseArgs, warn, summary, existsSync } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig(args.config);
const statePath = abs(args.state || cfg.statePath);
const poPath = abs(args.po || cfg.poPath);
const outDir = abs(args.out || cfg.outDir);
const state = readJSON(statePath);

/* ---- po.json → state.pos（po.json が正。1行足せば判定に入る） ---- */
let poNote = 'po.json なし（state.pos をそのまま使用）';
if (existsSync(poPath)) {
  const po = readJSON(poPath);
  const list = Array.isArray(po) ? po : (po.pos || []);
  const bad = [];
  const pos = list.map((p, i) => {
    const q = { id: String(p.id || `po-${i + 1}`), sku: p.sku, qty: E.num(p.qty), orderDate: p.orderDate || '', eta: p.eta || '', memo: p.memo || '', status: p.status === 'received' ? 'received' : 'open' };
    if (p.receivedDate) q.receivedDate = p.receivedDate;
    if (p.receivedQty !== undefined) q.receivedQty = E.num(p.receivedQty);
    if (!q.sku || !(q.qty > 0)) bad.push(`${q.id}: sku と qty が要る`);
    if (q.status === 'open' && !isDate(q.eta)) bad.push(`${q.id}: 入荷予定 eta（YYYY-MM-DD）が要る`);
    if (q.status === 'received' && !isDate(q.receivedDate)) bad.push(`${q.id}: 入荷日 receivedDate（YYYY-MM-DD）が要る`);
    return q;
  });
  if (bad.length) { console.error('automation/po.json の形式エラー:\n  ' + bad.join('\n  ')); process.exit(2); }
  state.pos = pos;
  poNote = `po.json ${pos.length} 件（open ${pos.filter((p) => p.status === 'open').length}・received ${pos.filter((p) => p.status === 'received').length}）`;
}

/* ---- 判定 ---- */
// 判定の基準日は「今日」。state.asOf は受注データの最終日（fetch が昨日に置く）
const asOf = args.asof || jstToday();
if (!isDate(asOf)) { console.error('asOf が日付ではありません'); process.exit(2); }
const results = E.projectAll(state, asOf);
const dataThrough = (state.logs || []).reduce((m, l) => (l.date > m ? l.date : m), '');
const out = { generatedAt: jstNow(), asOf, dataThrough, title: cfg.title, lastFetch: state.lastFetch || null, po: poNote, results };
mkdirSync(outDir, { recursive: true });
writeJSON(resolve(outDir, 'latest.json'), out);
writeFileSync(resolve(outDir, 'latest.md'), renderMarkdown(out, state));
writeJSON(statePath, state);
summary(`judgment: asOf ${asOf} / データ 〜${dataThrough} / ${results.map((r) => `${r.sku} ${r.status} ${r.reason}`).join('; ')} / ${resolve(outDir, 'latest.md')}`);

/* ---- Markdown（templates/output-design.md: H1 直後に結論ブロック／1文40字／表3列／H2 まで／根拠は畳む／末尾は次にやること） ---- */
function md(d) { return d ? d.slice(5).replace('-', '/') : '—'; }          // 10-30 → 10/30
function n(v, dgt = 0) { return (v === null || v === undefined || !isFinite(v)) ? '—' : Number(v).toLocaleString('ja-JP', { maximumFractionDigits: dgt }); }
function yen(v) { return v >= 10000 ? `約${n(v / 10000)}万円` : `${n(v)}円`; }
function conclusion(r) {
  const q = r.recommendQty ? `${n(r.recommendQty)}本` : '';
  if (r.status === '⚪') return { sig: '🟡 注意', line: '🟡 受注データなし。取り込みを確認する。' };
  if (r.status === '🔴') {
    if (/欠品中/.test(r.reason)) return { sig: '🔴 要対応', line: `🔴 欠品中。未出荷 ${n(r.backlogQty)}本。${r.backlogStartDay > 0 ? `${md(E.addDays(r.asOf, r.backlogStartDay))} 入荷で出荷。` : '入荷予定なし。'}` };
    if (/間に合わない/.test(r.reason)) return { sig: '🔴 要対応', line: `🔴 ${md(r.stockoutDate)} に在庫切れ。今日発注でも間に合わない。` };
    return { sig: '🔴 要対応', line: `🔴 発注期限 ${md(r.orderDeadlineDate)} を超過。今日 ${q} を発注。` };
  }
  if (r.status === '🟡') {
    if (/過剰/.test(r.reason)) return { sig: '🟡 注意', line: `🟡 在庫日数 ${n(r.daysOfCover)}日。過剰在庫の疑い。` };
    return { sig: '🟡 注意', line: `🟡 発注期限 ${md(r.orderDeadlineDate)}。${q} の発注を準備。` };
  }
  return { sig: '🟢 平常', line: '🟢 在庫は見込み範囲内。発注は不要。' };
}
function shortReason(r) {
  const s = r.reason || '';
  if (/欠品中/.test(s)) return '欠品中（入荷待ち）';
  if (/間に合わない/.test(s)) return 'LT内に在庫切れ';
  if (/期限を過ぎ/.test(s)) return '発注期限を超過';
  if (/発注間隔/.test(s)) return '発注期限が近い';
  if (/過剰/.test(s)) return '過剰在庫の疑い';
  return [...s].slice(0, 20).join('');
}
function renderMarkdown(o, st) {
  const rs = o.results;
  const worst = rs.slice().sort((a, b) => ({ '🔴': 0, '🟡': 1, '⚪': 2, '🟢': 3 }[a.status] - { '🔴': 0, '🟡': 1, '⚪': 2, '🟢': 3 }[b.status]))[0];
  const c = worst ? conclusion(worst) : { sig: '🟡 注意', line: '🟡 商品が登録されていない。' };
  const red = rs.filter((r) => r.status === '🔴').length;
  const deadline = worst && worst.orderDeadlineDate ? `${md(worst.orderDeadlineDate)}${worst.orderDeadlineDay <= 0 ? '（超過）' : ''}` : '—';
  const L = [];
  L.push(`# ${o.title}（${o.asOf}）`, '');
  L.push('> [!IMPORTANT] 結論', `> **${c.line}**`, '');
  L.push('| | |', '|---|---|', `| 🚦 | ${c.sig} |`, `| 要対応 | ${red ? `${red}件` : 'なし'} |`, `| 期限 | ${deadline} |`, '');
  for (const r of rs) {
    const p = (st.products || []).find((x) => x.sku === r.sku) || {};
    const openPo = (st.pos || []).filter((x) => x.sku === r.sku && x.status === 'open');
    L.push(`## ${r.sku.slice(0, 12)}`, '');
    L.push('| 項目 | 値 | 備考 |', '|---|---|---|');
    L.push(`| 判定 | ${r.status} | ${shortReason(r)} |`);
    L.push(`| 現在庫 | ${n(r.stock0)}本 | 実棚 ${md((p.stockBase || {}).date)} 起点 |`);
    L.push(`| 未出荷 | ${n(r.backlogQty)}本 | ${r.backlogQty > 0 ? (r.backlogStartDay > 0 ? `${md(E.addDays(r.asOf, r.backlogStartDay))} 入荷で出荷` : '在庫から出荷') : '—'} |`);
    L.push(`| 入荷予定 | ${openPo.length ? n(openPo.reduce((s, x) => s + E.num(x.qty), 0)) + '本' : 'なし'} | ${openPo.map((x) => md(x.eta)).join('・') || '—'} |`);
    L.push(`| 1日消化 | ${n(r.dailyTotal, 1)}本 | 新規 ${n(r.newPerDay, 1)}件/日 |`);
    L.push(`| 在庫切れ | ${r.stockoutDate ? md(r.stockoutDate) : '期間内なし'} | ${r.stockoutDay !== null && r.stockoutDay <= E.num(p.leadTimeDays) ? 'LT内・間に合わない' : '—'} |`);
    L.push(`| 発注期限 | ${r.orderDeadlineDate ? md(r.orderDeadlineDate) : '—'} | ${r.orderDeadlineDay !== null && r.orderDeadlineDay <= 0 ? '超過' : '—'} |`);
    L.push(`| 推奨発注 | ${r.recommendQty ? n(r.recommendQty) + '本' : '不要'} | ${r.recommendQty ? yen(r.recommendCost) : '—'} |`);
    L.push(`| 今日発注 | ${md(r.etaIfOrderedToday)} 入荷 | LT ${p.leadTimeDays}日 |`, '');
    L.push('> [!NOTE]- 根拠', `> 新規定期 ${n(r.newPerDay, 2)}件/日（${r.newSubsBasis}）。定期（初回＋継続）${n(r.subPerDay, 1)}本/日（28日平均）。`);
    L.push(`> 安全在庫 ${n(r.safetyStock)}本（${p.safetyDays}日）。定期確保 ${n(r.reservedNow)}本。MOQ ${n(p.moq)}・単位 ${n(p.lotStep)}。`);
    L.push(`> 受注データ 〜${o.dataThrough}（${o.lastFetch ? `${o.lastFetch.mode} ${o.lastFetch.at}` : '手入力'}）。${o.po}。`, '');
  }
  L.push('## 次にやること', '', '| 期日 | やること | 誰 |', '|---|---|---|');
  for (const r of rs) {
    const q = r.recommendQty ? `${n(r.recommendQty)}本` : '';
    if (r.status === '🔴' && r.recommendQty) L.push(`| 今日 | ${q} を発注する | 発注担当 |`, `| 発注後 | po.json に1行足す | 発注担当 |`);
    else if (r.status === '🟡' && r.recommendQty) L.push(`| ${md(r.orderDeadlineDate)} | ${q} を発注する | 発注担当 |`);
    const openPo = (st.pos || []).filter((x) => x.sku === r.sku && x.status === 'open');
    openPo.forEach((x) => L.push(`| ${md(x.eta)} | 入荷したら po.json を received に | 発注担当 |`));
  }
  L.push('| 毎朝 07:30 | 自動で再判定・配信 | 機械 |', '');
  return L.join('\n');
}
