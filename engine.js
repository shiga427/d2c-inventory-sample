/* D2C 在庫管理エンジン v2（純粋関数・UIなし・node でも動く）
   v2: 段階別継続率カーブ・初回→2回目の短い周期・新規定期の実績（コホート）からの出荷見込み・
       未出荷の受注（先行受付の積み上がり）・EC-Force 受注エクスポートの直接取り込み */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const toDate = (s) => { const d = new Date(String(s).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? null : d; };
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;   // ローカル日付（toISOString は UTC になり JST で1日ずれる）
  const addDays = (s, n) => fmt(new Date(toDate(s).getTime() + n * DAY));
  const diffDays = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

  const defaultSettings = () => ({
    horizonDays: 120,     // 何日先まで見込みを立てるか
    shortWindow: 7,       // 直近の重み付け窓
    longWindow: 28,       // 長期の窓
    shortWeight: 0.6,     // 直近窓の重み（残りが長期窓）
    overstockDays: 120,   // これ以上の在庫日数は過剰（🟡）
    historyDays: 400,     // 新規定期の実績を何日ぶん遡ってコホート計算に使うか
  });

  const defaultProduct = () => ({
    sku: '', name: '',
    leadTimeDays: 45,     // 発注→入荷
    moq: 1000,            // 最小ロット
    lotStep: 100,         // 発注単位（この倍数に丸める）
    unitCost: 0,
    safetyDays: 7,        // 安全在庫（日数）
    reviewDays: 14,       // 発注間隔（次に発注できるまでの日数）
    demandFactor: 1.0,    // 需要係数（キャンペーン等の手動補正）
    qtyPerOrder: 1,       // 都度受注 1件あたりの個数
    backlogSubs: 0,       // 未出荷の新規定期（件）。先行受付の積み上がり。入荷したら即出荷される
    stockBase: { date: '', qty: 0 },  // 実棚（この日時点の在庫）
    sub: {
      active: 0,          // 旧方式: アクティブ会員数（実績コホートが無いときだけ使う）
      cycleDays: 30,      // 2回目以降の配送周期
      firstCycleDays: 0,  // 初回→2回目の日数（0 なら cycleDays）
      qtyFirst: 1,        // 初回の個数
      qtyPerShip: 1,      // 2回目以降の個数
      retentionCurve: [], // 段階別継続率 [F1→F2, F2→F3, F3→F4, ...]。空なら f2Rate / retention
      f2Rate: 0.8,        // 初回→2回目の継続率（カーブが無いとき）
      retention: 0.9,     // 以降の継続率（カーブより先の段階にも使う）
      newSubRatio: 0,     // 都度受注のうち定期に入る割合（日次の新規定期が無いとき）
    },
  });

  /* ---- 日次ログ ---- */
  function logsFor(state, sku) {
    return (state.logs || []).filter((l) => l.sku === sku).sort((a, b) => a.date.localeCompare(b.date));
  }

  /* 直近窓の平均（入力のある日だけで割る） */
  function windowAvg(logs, asOf, days, key) {
    const from = addDays(asOf, -days + 1);
    const rows = logs.filter((l) => l.date >= from && l.date <= asOf);
    if (!rows.length) return null;
    const byDate = {};
    rows.forEach((r) => { byDate[r.date] = (byDate[r.date] || 0) + num(r[key]); });
    const dates = Object.keys(byDate);
    return dates.reduce((s, d) => s + byDate[d], 0) / dates.length;
  }

  function velocity(logs, asOf, settings, key) {
    key = key || 'orders';
    const s = windowAvg(logs, asOf, settings.shortWindow, key);
    const l = windowAvg(logs, asOf, settings.longWindow, key);
    if (s === null && l === null) return { perDay: 0, basis: 'データなし', short: null, long: null };
    if (s === null) return { perDay: l, basis: `${settings.longWindow}日平均のみ`, short: null, long: l };
    if (l === null) return { perDay: s, basis: `${settings.shortWindow}日平均のみ`, short: s, long: null };
    const perDay = settings.shortWeight * s + (1 - settings.shortWeight) * l;
    return { perDay, basis: `${settings.shortWindow}日×${settings.shortWeight}＋${settings.longWindow}日×${(1 - settings.shortWeight).toFixed(1)}`, short: s, long: l };
  }

  /* 新規定期の1日あたり件数（日次入力の newSubs があればそれ、無ければ 都度×比率） */
  function newSubsPerDay(logs, asOf, settings, p, vel) {
    const v = velocity(logs, asOf, settings, 'newSubs');
    if (v.perDay > 0) return { perDay: v.perDay, basis: v.basis, short: v.short, long: v.long };
    return { perDay: vel.perDay * num(p.sub.newSubRatio), basis: '都度×定期比率', short: null, long: null };
  }

  /* ---- 現在庫（実棚 ＋ 入荷 − 出荷、実棚日の翌日から asOf まで） ---- */
  function currentStock(state, p, asOf) {
    const base = p.stockBase || { date: '', qty: 0 };
    const from = base.date || '0000-00-00';
    const qtyPerOrder = num(p.qtyPerOrder) || 1;
    const qtyFirst = num((p.sub || {}).qtyFirst) || 1;
    const logs = logsFor(state, p.sku).filter((l) => l.date > from && l.date <= asOf);
    // 出荷 = 都度 × 個数 + 新規定期の初回出荷（出荷済み件数 × 初回個数） + 定期出荷(個数) − 調整(+は入庫)
    const shipped = logs.reduce((s, l) => {
      const firstShipped = l.newSubsShipped !== undefined ? num(l.newSubsShipped) : num(l.newSubs);
      return s + num(l.orders) * qtyPerOrder + firstShipped * qtyFirst + num(l.subShipped) - num(l.adjust);
    }, 0);
    const received = (state.pos || []).filter((po) => po.sku === p.sku && po.status === 'received' && po.receivedDate > from && po.receivedDate <= asOf)
      .reduce((s, po) => s + num(po.receivedQty || po.qty), 0);
    return num(base.qty) - shipped + received;
  }

  /* 段階別の生存率: S[k] = k回目の出荷を受ける割合（S[1]=1） */
  function survival(sub, kMax) {
    const curve = (sub.retentionCurve || []).map(num).filter((x) => x > 0);
    const r = Math.min(1, Math.max(0, num(sub.retention)));
    const f2 = Math.min(1, Math.max(0, num(sub.f2Rate)));
    const S = [0, 1];
    for (let k = 2; k <= kMax; k++) {
      let step;
      if (curve.length) step = curve[Math.min(k - 2, curve.length - 1)];
      else step = k === 2 ? f2 : r;
      S[k] = S[k - 1] * Math.min(1, step);
    }
    return S;
  }

  /* k回目（k≥2）の出荷日 = 初回から first + (k-2)*cycle 日後 */
  function shipOffset(sub, k) {
    const cycle = Math.max(1, num(sub.cycleDays) || 30);
    const first = num(sub.firstCycleDays) > 0 ? num(sub.firstCycleDays) : cycle;
    return first + (k - 2) * cycle;
  }

  /* ---- 定期需要の日次見込み ----
     ① 実績コホート: 過去の各日の「初回出荷済み件数」から、k回目の出荷日と生存率で将来の出荷を置く
     ② 未出荷の新規（backlogSubs）: 入荷したら即出荷 → day0 に初回、以降は day0 起点のコホート
     ③ 将来の新規（newPerDay）: 毎日 newPerDay 件が初回出荷、以降は同じ規則
     ④ 旧方式（active）: コホート実績が無い商品のための近似 */
  function subDemandSeries(p, horizon, newPerDay, history, backlogSubs, backlogStartDay) {
    const sub = p.sub || {};
    const qtyFirst = num(sub.qtyFirst) || 1;
    const qty = num(sub.qtyPerShip) || 1;
    const series = new Array(horizon + 1).fill(0);
    const kMax = 60;
    const S = survival(sub, kMax);
    const place = (t0, n, includeFirst) => {
      if (n <= 0) return;
      if (includeFirst && t0 >= 0 && t0 <= horizon) series[t0] += n * qtyFirst;
      for (let k = 2; k <= kMax; k++) {
        const t = t0 + shipOffset(sub, k);
        if (t > horizon) break;
        if (t >= 0) series[t] += n * S[k] * qty;
      }
    };
    (history || []).forEach((h) => place(-h.daysAgo, h.n, false));      // ① 初回は出荷済み
    place(Math.max(0, num(backlogStartDay)), num(backlogSubs), true);  // ② 入荷日から出荷
    for (let d = 1; d <= horizon; d++) place(d, newPerDay, true);       // ③
    const active0 = num(sub.active);                                    // ④
    if (active0 > 0) {
      const cycle = Math.max(1, num(sub.cycleDays) || 30);
      const r = Math.min(1, Math.max(0, num(sub.retention)));
      for (let d = 1; d <= horizon; d++) series[d] += active0 * Math.pow(r, d / 30) / cycle * qty;
    }
    return series;
  }

  /* 実績コホート: ログの newSubsShipped（無ければ newSubs）を daysAgo ごとに */
  function cohortHistory(logs, asOf, settings) {
    const from = addDays(asOf, -(settings.historyDays || 400));
    return logs.filter((l) => l.date > from && l.date <= asOf).map((l) => ({
      daysAgo: diffDays(l.date, asOf),
      n: l.newSubsShipped !== undefined ? num(l.newSubsShipped) : num(l.newSubs),
    })).filter((h) => h.n > 0);
  }

  function roundLot(qty, moq, step) {
    if (qty <= 0) return 0;
    let q = Math.max(qty, num(moq));
    const s = num(step);
    if (s > 0) q = Math.ceil(q / s) * s;
    return q;
  }

  /* ---- 在庫推移の見込み・発注判定 ---- */
  function project(state, p, asOf, settings) {
    settings = Object.assign(defaultSettings(), settings || {});
    const H = settings.horizonDays;
    const logs = logsFor(state, p.sku);
    const vel = velocity(logs, asOf, settings, 'orders');
    const qtyPerOrder = num(p.qtyPerOrder) || 1;
    const oneOffPerDay = vel.perDay * qtyPerOrder * (num(p.demandFactor) || 1);
    const ns = newSubsPerDay(logs, asOf, settings, p, vel);
    const newPerDay = ns.perDay * (num(p.demandFactor) || 1);
    const history = cohortHistory(logs, asOf, settings);
    const backlogSubs = num(p.backlogSubs);
    const stock0 = currentStock(state, p, asOf);

    const arrivals = new Array(H + 1).fill(0);
    (state.pos || []).filter((po) => po.sku === p.sku && po.status === 'open').forEach((po) => {
      const d = diffDays(asOf, po.eta);
      arrivals[Math.max(0, Math.min(H, d))] += num(po.qty);
    });
    // 未出荷の新規は、在庫で賄えるなら今日、賄えないなら最初の入荷日に出荷される（入荷予定が無ければ今日に置いて赤にする）
    const backlogUnits = backlogSubs * (num((p.sub || {}).qtyFirst) || 1);
    let backlogStartDay = 0;
    if (backlogUnits > 0 && stock0 < backlogUnits) { const i = arrivals.findIndex((v) => v > 0); backlogStartDay = i > 0 ? i : 0; }
    const subSeries = subDemandSeries(p, H, newPerDay, history, backlogSubs, backlogStartDay);

    const lead = Math.max(0, Math.round(num(p.leadTimeDays)));
    const safetyDays = Math.max(0, num(p.safetyDays));
    const reviewDays = Math.max(1, num(p.reviewDays) || 14);
    const rows = [];
    let stock = stock0;
    let stockoutDay = null;
    for (let d = 0; d <= H; d++) {
      const demand = (d === 0 ? subSeries[0] : oneOffPerDay + subSeries[d]);   // day0 = 未出荷分
      stock = stock + arrivals[d] - demand;
      let reserved = 0;
      for (let k = d + 1; k <= Math.min(H, d + lead + safetyDays); k++) reserved += subSeries[k];
      rows.push({ day: d, date: addDays(asOf, d), stock, demand, oneOff: d === 0 ? 0 : oneOffPerDay, sub: subSeries[d], arrival: arrivals[d], reserved, free: stock - reserved });
      if (stockoutDay === null && stock < 0) stockoutDay = d;
    }

    // 1日の消化 = 都度 + 今後28日の定期平均（周期の山谷をならす）
    const subAvg = subSeries.slice(1, Math.min(H, 28) + 1).reduce((s, v) => s + v, 0) / Math.min(H, 28);
    const dailyTotal = oneOffPerDay + subAvg;
    const safetyStock = dailyTotal * safetyDays;
    const daysOfCover = dailyTotal > 0 ? Math.max(0, rows[0].stock) / dailyTotal : Infinity;

    const coverEnd = Math.min(H, lead + reviewDays);
    const stockAtLead = rows[Math.min(H, lead)].stock;
    let needDuring = 0;
    for (let k = lead + 1; k <= coverEnd; k++) needDuring += rows[k].demand;
    const shortage = needDuring + safetyStock - stockAtLead;
    const minStockInWindow = Math.min(...rows.slice(0, coverEnd + 1).map((r) => r.stock));
    let recommendQty = 0;
    if (shortage > 0 || minStockInWindow < safetyStock) {
      recommendQty = roundLot(Math.max(shortage, safetyStock - minStockInWindow), p.moq, p.lotStep);
    }
    let safetyBreachDay = null;
    for (const r of rows) { if (r.stock < safetyStock) { safetyBreachDay = r.day; break; } }
    const orderDeadlineDay = safetyBreachDay === null ? null : safetyBreachDay - lead;

    let status = '🟢', reason = '在庫は見込み範囲内';
    const hasOpenPo = (state.pos || []).some((po) => po.sku === p.sku && po.status === 'open');
    if (backlogUnits > 0 && stock0 < backlogUnits) { status = '🔴'; reason = `欠品中。未出荷 ${Math.round(backlogUnits)}個に対し在庫 ${Math.round(stock0)}個${backlogStartDay > 0 ? `。入荷 ${addDays(asOf, backlogStartDay)} で出荷` : ''}`; }
    else if (stockoutDay !== null && stockoutDay <= lead) { status = '🔴'; reason = `リードタイム内（${lead}日）に在庫切れ。今日発注しても間に合わない`; }
    else if (orderDeadlineDay !== null && orderDeadlineDay <= 0) { status = '🔴'; reason = '発注期限を過ぎている。即発注'; }
    else if (orderDeadlineDay !== null && orderDeadlineDay <= reviewDays) { status = '🟡'; reason = `次の発注間隔（${reviewDays}日）内に発注期限`; }
    else if (daysOfCover > settings.overstockDays && !hasOpenPo) { status = '🟡'; reason = `在庫日数 ${Math.round(daysOfCover)}日。過剰在庫の疑い`; }
    if (dailyTotal === 0 && backlogSubs === 0) { status = '⚪'; reason = '受注データなし'; }

    return {
      sku: p.sku, name: p.name, asOf,
      stock0, backlogQty: backlogUnits, backlogStartDay, oneOffPerDay, subPerDay: subAvg, dailyTotal, newPerDay,
      velocityBasis: vel.basis, velShort: vel.short, velLong: vel.long,
      newSubsBasis: ns.basis, newShort: ns.short, newLong: ns.long, historyDays: history.length,
      safetyStock, daysOfCover,
      reservedNow: rows[0].reserved, freeNow: rows[0].free,
      stockoutDay, stockoutDate: stockoutDay === null ? null : addDays(asOf, stockoutDay),
      safetyBreachDay, orderDeadlineDay,
      orderDeadlineDate: orderDeadlineDay === null ? null : addDays(asOf, orderDeadlineDay),
      recommendQty, recommendCost: recommendQty * num(p.unitCost),
      etaIfOrderedToday: addDays(asOf, lead),
      stockAtLead, needDuring, coverEnd,
      openPoQty: arrivals.reduce((s, v) => s + v, 0),
      status, reason, rows,
    };
  }

  function projectAll(state, asOf) {
    const settings = Object.assign(defaultSettings(), state.settings || {});
    return (state.products || []).map((p) => project(state, p, asOf, settings));
  }

  /* ---- CSV ---- */
  function parseCSV(text) {
    const lines = text.replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
    if (!lines.length) return [];
    const split = (l) => {
      const out = []; let cur = ''; let q = false;
      for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur); return out.map((s) => s.trim());
    };
    const head = split(lines[0]);
    return lines.slice(1).map((l) => { const c = split(l); const o = {}; head.forEach((h, i) => { o[h] = c[i]; }); return o; });
  }

  function normDate(s) {
    if (!s) return '';
    const m = String(s).match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
    if (!m) return '';
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }

  /* 日次ログ CSV → logs。列: date, sku, orders, newsubs, subshipped, adjust（別名も受ける） */
  function importLogsCSV(text) {
    const alias = {
      date: ['date', '日付', '受注日'], sku: ['sku', 'SKU', '商品コード', '商品'],
      orders: ['orders', '受注件数', '都度', '都度受注'], newsubs: ['newsubs', '新規定期', '定期新規'],
      subshipped: ['subshipped', '定期出荷', '定期出荷数'], adjust: ['adjust', '調整', '入庫調整'],
    };
    const low = (row) => { const o = {}; Object.keys(row).forEach((k) => { o[k.toLowerCase()] = row[k]; }); return o; };
    const pick = (row, keys) => { for (const k of keys) { const v = row[k.toLowerCase()]; if (v !== undefined && v !== '') return v; } return ''; };
    return parseCSV(text).map(low).map((r) => ({
      date: normDate(pick(r, alias.date)), sku: pick(r, alias.sku),
      orders: num(pick(r, alias.orders)), newSubs: num(pick(r, alias.newsubs)),
      subShipped: num(pick(r, alias.subshipped)), adjust: num(pick(r, alias.adjust)),
    })).filter((r) => r.date && r.sku);
  }

  /* ---- EC-Force 受注管理の CSV エクスポートを直接取り込む ----
     必要列: 受注日, 定期回数, 対応状況, 購入商品（商品名）（または 商品ラベル / プラン）
     opts: { sku: 取り込み先SKU, labelToSku: {商品ラベル: sku}, unitsByPlan: {通常:2,...}, unitPrice: 本数の推定単価, firstUnits: 初回本数 }
     集計: 日×SKU → newSubs（F1 の有効受注）, newSubsShipped（F1 の発送完了）, subShipped（F2+ 発送完了の本数）
     戻り: { logs, pendingSubs: {sku: 未出荷F1件数}, excluded, dates:[min,max] } */
  const STATUS_SHIPPED = new Set(['発送完了']);
  const STATUS_PENDING = new Set(['注文確定', '決済完了', '発送準備', '決済保留', '入金待ち']);
  function planOf(row) {
    if (row['プラン']) return String(row['プラン']);
    const n = String(row['購入商品（商品名）'] || row['商品名'] || '');
    if (/解約手数料/.test(n)) return '解約手数料';
    if (/プランB/.test(n)) return 'プランB';
    if (/プランC/.test(n)) return 'プランC';
    if (/プランD/.test(n)) return 'プランD';
    if (/プランE/.test(n)) return 'プランE';
    return '通常';
  }
  function unitsOf(row, plan, k, opts) {
    if (k === 1) return num(opts.firstUnits) || 1;
    if (opts.unitsByPlan && opts.unitsByPlan[plan]) return num(opts.unitsByPlan[plan]);
    const price = num(row['小計']);
    if (opts.unitPrice && price > 0) return Math.max(1, Math.round(price / num(opts.unitPrice)));
    return 1;
  }
  /* 行の配列（CSV の1行＝1オブジェクト。API から組み立てた行も同じ形）を集計する。CSV 取り込みも API 取り込みもここを通る */
  function importEcforceRows(rows, opts) {
    opts = opts || {};
    const agg = {}; const pending = {}; let excluded = 0; let min = null, max = null;
    rows.forEach((r) => {
      const date = normDate(r['受注日']);
      if (!date) { excluded++; return; }
      const label = String(r['商品ラベル'] || '');
      const sku = (opts.labelToSku && opts.labelToSku[label]) || opts.sku;
      if (!sku) { excluded++; return; }
      const plan = planOf(r);
      if (plan === '解約手数料') { excluded++; return; }
      const status = String(r['対応状況'] || '');
      const k = Math.round(num(r['定期回数'])) || (num(r['顧客購入回数']) > 1 ? 2 : 1);
      const key = `${date}|${sku}`;
      if (!agg[key]) agg[key] = { date, sku, orders: 0, newSubs: 0, newSubsShipped: 0, subShipped: 0 };
      if (!min || date < min) min = date; if (!max || date > max) max = date;
      const shipped = STATUS_SHIPPED.has(status), pend = STATUS_PENDING.has(status);
      if (!shipped && !pend) { excluded++; return; }      // キャンセル・返品・返送待ち
      if (k <= 1) {
        agg[key].newSubs += 1;
        if (shipped) agg[key].newSubsShipped += 1; else pending[sku] = (pending[sku] || 0) + 1;
      } else if (shipped) {
        agg[key].subShipped += unitsOf(r, plan, k, opts);
      }
    });
    return { logs: Object.values(agg).sort((a, b) => a.date.localeCompare(b.date)), pendingSubs: pending, excluded, dates: [min, max] };
  }
  function importEcforceCSV(text, opts) { return importEcforceRows(parseCSV(text), opts); }

  /* 未出荷の新規定期（件）＝ ログの Σ(newSubs − newSubsShipped)。backlogSubs はこれで機械が出す（手で入れない） */
  function pendingFromLogs(state, sku) {
    return logsFor(state, sku).reduce((s, l) => s + Math.max(0, num(l.newSubs) - (l.newSubsShipped !== undefined ? num(l.newSubsShipped) : num(l.newSubs))), 0);
  }

  /* ログの upsert（同日・同SKUは上書き） */
  function upsertLogs(state, rows) {
    const key = (r) => `${r.date}|${r.sku}`;
    const map = {};
    (state.logs || []).forEach((r) => { map[key(r)] = r; });
    rows.forEach((r) => { map[key(r)] = Object.assign({}, map[key(r)] || {}, r); });
    state.logs = Object.values(map).sort((a, b) => a.date.localeCompare(b.date) || a.sku.localeCompare(b.sku));
    return state;
  }

  const api = { DAY, toDate, fmt, addDays, diffDays, defaultSettings, defaultProduct, velocity, currentStock, survival, shipOffset, subDemandSeries, cohortHistory, roundLot, project, projectAll, parseCSV, importLogsCSV, importEcforceCSV, importEcforceRows, pendingFromLogs, planOf, upsertLogs, STATUS_SHIPPED, STATUS_PENDING, normDate, logsFor, num };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.InvEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
