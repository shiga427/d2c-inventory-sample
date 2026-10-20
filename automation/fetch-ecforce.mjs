#!/usr/bin/env node
/* ecforce Admin API v2 から受注を取り、engine.js の importEcforceRows と同じ集計で
   data/sample-state.json の logs と products[].backlogSubs を upsert する。

   使い方:
     node automation/fetch-ecforce.mjs                      # 直近 lookbackDays 日＋「昨日以降に更新された受注」の受注日を取り直す
     node automation/fetch-ecforce.mjs --since 2026-10-06   # 指定日〜昨日を全部取り直す（初回の埋め戻し）
     node automation/fetch-ecforce.mjs --fixtures automation/fixtures/orders.json --asof 2026-10-20 --state /tmp/x.json
   環境変数（本番）: ECFORCE_API_TOKEN（トークンはここからだけ読む）・ECFORCE_BASE_URL（API の接続先・管理画面のドメインと違うことがある）
   任意: ECFORCE_FIXTURES（fixtures のパス）・ECFORCE_MAX_REQUESTS（既定 2000）・ECFORCE_MIN_INTERVAL_MS（既定 1100）

   集計の対応（CSV 取り込みと同じ）:
     受注日=created_at／対応状況=human_state／定期回数=times／購入商品（商品名）=product_name_with_tax／小計=subtotal／商品ラベル=product_labels
     定期回数1＝新規定期（newSubs）・うち発送完了＝初回出荷済（newSubsShipped）・2以上の発送完了＝定期出荷本数（subShipped）
     未出荷の新規定期 backlogSubs ＝ Σ(newSubs − newSubsShipped)（ログから機械が出す。手で入れない）
   「今日」の受注は日が終わっていないので取らない（昨日まで）。 */
import { resolve } from 'node:path';
import { E, ROOT, abs, readJSON, writeJSON, loadConfig, jstToday, jstNow, isDate, dateRange, parseArgs, warn, summary, existsSync } from './lib.mjs';
import { EcforceClient, makeFixtureFetch } from './ecforce-client.mjs';

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig(args.config);
const statePath = abs(args.state || cfg.statePath);
const today = args.asof || jstToday();
if (!isDate(today)) { console.error('--asof は YYYY-MM-DD'); process.exit(2); }
const yesterday = E.addDays(today, -1);
const fixtures = args.fixtures || process.env.ECFORCE_FIXTURES || '';
const log = (m) => console.error(`[fetch] ${m}`);

/* ---- クライアント ---- */
let client, mode;
if (fixtures) {
  const orders = readJSON(resolve(process.cwd(), fixtures));
  client = new EcforceClient({ baseUrl: 'https://fixture.invalid', token: 'fixture', fetchImpl: makeFixtureFetch(orders), minIntervalMs: 0, log });
  mode = `fixtures:${fixtures}`;
} else {
  const token = process.env.ECFORCE_API_TOKEN || '';
  const baseUrl = process.env.ECFORCE_BASE_URL || '';
  if (!token || !baseUrl) {
    console.error('ECFORCE_API_TOKEN と ECFORCE_BASE_URL が未設定です。本番は GitHub Secrets に置く。手元で試すなら --fixtures automation/fixtures/orders.json');
    process.exit(2);
  }
  client = new EcforceClient({ baseUrl, token, log, minIntervalMs: Number(process.env.ECFORCE_MIN_INTERVAL_MS || 1100), maxRequests: Number(process.env.ECFORCE_MAX_REQUESTS || 2000) });
  mode = 'ecforce-api';
}

/* ---- どの受注日を取り直すか ---- */
const state = readJSON(statePath);
const product = (state.products || []).find((p) => p.sku === cfg.sku);
if (!product) { console.error(`state に SKU ${cfg.sku} がありません`); process.exit(2); }

let dates;
if (args.since) {
  if (!isDate(args.since)) { console.error('--since は YYYY-MM-DD'); process.exit(2); }
  const until = args.until && isDate(args.until) ? args.until : yesterday;
  dates = dateRange(args.since, until);
} else {
  const set = new Set(dateRange(E.addDays(today, -(cfg.lookbackDays || 3)), yesterday));
  // 昨日以降に更新された受注（例: 未出荷だった予約が発送完了になった）の受注日も取り直す
  const upd = await client.fetchAll('/admin/orders', { q: { updated_at_gteq: `${yesterday} 00:00:00` }, sort: '-id', lighter: false }, { maxPages: 50 });
  if (upd.truncated) warn('更新分の走査を 50 ページで打ち切りました。取りこぼしがあれば --since で埋め戻してください');
  upd.items.forEach((o) => { const d = E.normDate(o.created_at); if (d && d <= yesterday) set.add(d); });
  dates = [...set].sort();
}
if (dates.length > (cfg.maxDates || 120)) { warn(`取り直す日数 ${dates.length} が上限 ${cfg.maxDates} を超えたので新しい側 ${cfg.maxDates} 日だけにします`); dates = dates.slice(-(cfg.maxDates || 120)); }

/* ---- 受注 → 行 → 集計 ---- */
const joinStr = (v) => Array.isArray(v) ? v.map((x) => (x && typeof x === 'object') ? (x.name || JSON.stringify(x)) : String(x)).join(',') : (v && typeof v === 'object') ? JSON.stringify(v) : String(v ?? '');
const hasLabel = (v) => joinStr(v).includes(cfg.label);
function toRow(o) {
  return {
    '受注日': o.created_at || '',
    '対応状況': o.human_state ?? o.state ?? '',
    '定期回数': o.times ?? '',
    '購入商品（商品名）': joinStr(o.product_name_with_tax ?? o.human_offer_name ?? ''),
    '小計': o.subtotal ?? '',
    '商品ラベル': hasLabel(o.product_labels) ? cfg.label : '',
  };
}
const importOpts = { labelToSku: { [cfg.label]: cfg.sku }, unitPrice: cfg.unitPrice, firstUnits: cfg.firstUnits, unitsByPlan: cfg.unitsByPlan || {} };
const rows = []; const detail = []; let matched = 0, fetched = 0, truncatedDates = [];
for (const d of dates) {
  const res = await client.fetchAll('/admin/orders', { q: { created_at_gteq: `${d} 00:00:00`, created_at_lt: `${E.addDays(d, 1)} 00:00:00` }, sort: '-id', lighter: false });
  if (res.truncated) truncatedDates.push(d);
  const mine = res.items.filter((o) => hasLabel(o.product_labels));
  fetched += res.items.length; matched += mine.length;
  const agg = E.importEcforceRows(mine.map(toRow), importOpts);
  const row = agg.logs.find((l) => l.date === d && l.sku === cfg.sku) || { date: d, sku: cfg.sku, orders: 0, newSubs: 0, newSubsShipped: 0, subShipped: 0 };
  // 対象の受注があるのに1件も集計に乗らない＝対応状況の値がこちらの想定と違う。ゼロで上書きせず止める
  if (mine.length > 0 && agg.excluded === mine.length) {
    const seen = [...new Set(mine.map((o) => o.human_state ?? o.state))].slice(0, 8).join(' / ');
    console.error(`[fetch] ${d}: 対象 ${mine.length} 件が全部除外されました（対応状況の実値: ${seen}）。engine.js の STATUS_SHIPPED / STATUS_PENDING を実値に合わせてください。state は書き換えません`);
    process.exit(3);
  }
  rows.push(Object.assign(row, { src: 'ecforce' }));
  detail.push({ date: d, fetched: res.items.length, matched: mine.length, newSubs: row.newSubs, newSubsShipped: row.newSubsShipped, subShipped: row.subShipped, excluded: agg.excluded });
}
if (truncatedDates.length) warn(`ページ上限で打ち切った受注日: ${truncatedDates.join(', ')}（その日の件数は不完全）`);
if (dates.length && matched === 0) warn(`取り直した ${dates.length} 日に ${cfg.label} の受注が 0 件でした（API の絞り込みかラベル名を疑う）`);

/* ---- state へ ---- */
E.upsertLogs(state, rows);
const before = product.backlogSubs;
product.backlogSubs = E.pendingFromLogs(state, cfg.sku);
state.asOf = yesterday;
state.lastFetch = { at: jstNow(), mode, today, dates, requests: client.requestCount, fetched, matched, backlogBefore: before, backlogAfter: product.backlogSubs, detail };
if (args['dry-run']) { console.log(JSON.stringify(state.lastFetch, null, 1)); process.exit(0); }
writeJSON(statePath, state);
summary(`fetch: ${mode} / ${dates[0]}〜${dates[dates.length - 1]}（${dates.length}日・${client.requestCount}請求）/ 対象 ${matched} 件 / 未出荷 ${before} → ${product.backlogSubs} 件 / 書き込み ${statePath}`);
