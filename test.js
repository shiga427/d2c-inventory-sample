// node test.js  — エンジン v2 の計算検証（UIなし）
const E = require('./engine.js');
const assert = require('assert');
const base = '2026-10-20';
const mk = (o)=> { const p = E.defaultProduct(); Object.assign(p, o); if (o.sub) p.sub = Object.assign(E.defaultProduct().sub, o.sub); return p; };
const noSub = { active:0, cycleDays:30, qtyPerShip:1, f2Rate:0, retention:0, newSubRatio:0, retentionCurve:[] };
let fails = 0;
function t(name, fn){ try{ fn(); console.log('✅', name); }catch(e){ fails++; console.log('❌', name, '\n   ', e.message); } }
const flat = (n, orders) => { const logs=[]; for(let d=-27; d<=0; d++) logs.push({date:E.addDays(base,d), sku:'A', orders}); return logs; };

t('現在庫 = 実棚 − 出荷 + 入荷（初回出荷は newSubsShipped×初回個数）', ()=>{
  const p = mk({sku:'A', stockBase:{date:'2026-10-10', qty:1000}, qtyPerOrder:1, sub:{qtyFirst:1}});
  const state = { products:[p], logs:[{date:'2026-10-11',sku:'A',orders:10,subShipped:5,newSubs:30,newSubsShipped:4},{date:'2026-10-12',sku:'A',orders:20,adjust:-3}], pos:[{sku:'A',status:'received',receivedDate:'2026-10-12',qty:100}] };
  assert.strictEqual(E.currentStock(state,p,base), 1000-10-5-4-20-3+100);
});
t('受注ゼロ・定期ゼロ → ⚪', ()=>{
  const p = mk({sku:'A', stockBase:{date:base, qty:100}, sub:noSub});
  assert.strictEqual(E.project({products:[p],logs:[],pos:[]}, p, base).status,'⚪');
});
t('旧方式: 会員300・30日・継続率1.0 → 10個/日で一定', ()=>{
  const p = mk({sku:'A', sub:{active:300,cycleDays:30,qtyPerShip:1,f2Rate:1,retention:1,retentionCurve:[]}});
  const s = E.subDemandSeries(p, 60, 0, [], 0);
  assert.ok(Math.abs(s[1]-10)<1e-9 && Math.abs(s[60]-10)<1e-9);
});
t('生存率カーブ: [0.6,0.4,0.6] → S2=.6 S3=.24 S4=.144 S5=.0864（以降は最後の値）', ()=>{
  const S = E.survival({retentionCurve:[0.6,0.4,0.6], retention:0.9, f2Rate:0.8}, 5);
  assert.ok(Math.abs(S[2]-0.6)<1e-9 && Math.abs(S[3]-0.24)<1e-9 && Math.abs(S[4]-0.144)<1e-9 && Math.abs(S[5]-0.0864)<1e-9, JSON.stringify(S));
});
t('出荷日: 初回20日・以降60日 → F2=+20, F3=+80, F4=+140', ()=>{
  const sub = {cycleDays:60, firstCycleDays:20};
  assert.deepStrictEqual([2,3,4].map(k=>E.shipOffset(sub,k)), [20,80,140]);
});
t('実績コホート: 10日前に100件初回出荷、F1→F2 0.5・初回20日・3本 → 10日後に 150本', ()=>{
  const p = mk({sku:'A', sub:{active:0, cycleDays:60, firstCycleDays:20, qtyFirst:1, qtyPerShip:3, retentionCurve:[0.5,0.5], retention:0.5}});
  const s = E.subDemandSeries(p, 120, 0, [{daysAgo:10, n:100}], 0);
  assert.ok(Math.abs(s[10]-150)<1e-9, `s[10]=${s[10]}`);
  assert.ok(Math.abs(s[70]-75)<1e-9, `s[70]=${s[70]}`);   // F3: 100*.25*3
  assert.strictEqual(s[11], 0);
});
t('未出荷の新規 200件 → day0 に 200×初回個数、+20日に 200×F2率×本数', ()=>{
  const p = mk({sku:'A', sub:{active:0, cycleDays:60, firstCycleDays:20, qtyFirst:1, qtyPerShip:2, retentionCurve:[0.6], retention:0.6}});
  const s = E.subDemandSeries(p, 60, 0, [], 200);
  assert.strictEqual(s[0], 200); assert.ok(Math.abs(s[20]-240)<1e-9, s[20]);
});
t('将来の新規 10件/日 → 毎日10本の初回 + 20日目から F2 が加わる', ()=>{
  const p = mk({sku:'A', sub:{active:0, cycleDays:60, firstCycleDays:20, qtyFirst:1, qtyPerShip:2, retentionCurve:[0.5], retention:0.5}});
  const s = E.subDemandSeries(p, 60, 10, [], 0);
  assert.strictEqual(s[1], 10); assert.ok(Math.abs(s[21]-(10+10))<1e-9, s[21]);
});
t('欠品中（在庫0・未出荷あり）→ 🔴 欠品中', ()=>{
  const p = mk({sku:'A', backlogSubs:500, stockBase:{date:base, qty:0}, sub:{active:0, cycleDays:60, firstCycleDays:20, retentionCurve:[0.6], retention:0.6}});
  const r = E.project({products:[p],logs:[],pos:[]}, p, base);
  assert.strictEqual(r.status,'🔴'); assert.ok(/欠品中/.test(r.reason), r.reason); assert.strictEqual(r.rows[0].stock, -500);
});
t('ロット丸め: 1234 → MOQ 1000・単位 500 → 1500 ／ MOQ0・単位0 → そのまま', ()=>{ assert.strictEqual(E.roundLot(1234,1000,500),1500); assert.strictEqual(E.roundLot(1234,0,0),1234); });
t('LT30日・在庫が20日分 → 🔴（今日発注しても間に合わない）', ()=>{
  const p = mk({sku:'A', leadTimeDays:30, safetyDays:0, reviewDays:14, moq:1000, lotStep:100, stockBase:{date:base, qty:200}, sub:noSub});
  const r = E.project({products:[p],logs:flat(28,10),pos:[]}, p, base);
  assert.strictEqual(r.status,'🔴'); assert.strictEqual(r.stockoutDay, 21, `stockoutDay=${r.stockoutDay}`); assert.ok(r.recommendQty>=1000);
});
t('在庫十分（1年分）・入荷予定なし → 🟡 過剰', ()=>{
  const p = mk({sku:'A', leadTimeDays:30, stockBase:{date:base, qty:3650}, sub:noSub});
  const r = E.project({products:[p],logs:flat(28,10),pos:[]}, p, base);
  assert.strictEqual(r.status,'🟡'); assert.strictEqual(r.recommendQty,0);
});
t('入荷予定(open PO)で在庫切れが消える', ()=>{
  const p = mk({sku:'A', leadTimeDays:30, safetyDays:0, reviewDays:14, moq:1000, lotStep:100, stockBase:{date:base, qty:200}, sub:noSub});
  const r = E.project({products:[p],logs:flat(28,10),pos:[{sku:'A',status:'open',qty:2000,eta:E.addDays(base,15)}]}, p, base);
  assert.strictEqual(r.stockoutDay, null); assert.strictEqual(r.status,'🟢');
});
t('推奨数量 = LT後の不足 + 発注間隔分 + 安全在庫 を丸め', ()=>{
  const p = mk({sku:'A', leadTimeDays:30, safetyDays:5, reviewDays:14, moq:100, lotStep:50, stockBase:{date:base, qty:400}, sub:noSub});
  const r = E.project({products:[p],logs:flat(28,10),pos:[]}, p, base);
  assert.ok(Math.abs(r.stockAtLead-100)<1e-6, `stockAtLead=${r.stockAtLead}`);
  assert.strictEqual(r.recommendQty, 100, `recommend=${r.recommendQty}`);
  assert.strictEqual(r.safetyBreachDay, 36); assert.strictEqual(r.orderDeadlineDay, 6); assert.strictEqual(r.status,'🟡');
});
t('定期確保分 = 今後 LT+安全日 分の定期需要（旧方式 300名）', ()=>{
  const p = mk({sku:'A', leadTimeDays:30, safetyDays:0, stockBase:{date:base, qty:1000}, sub:{active:300,cycleDays:30,qtyPerShip:1,f2Rate:1,retention:1,retentionCurve:[]}});
  const r = E.project({products:[p],logs:[],pos:[]}, p, base);
  assert.ok(Math.abs(r.reservedNow-300)<1e-6, `reserved=${r.reservedNow}`); assert.ok(Math.abs(r.freeNow-700)<1e-6);
});
t('CSV取り込み（日本語列名・日付形式）', ()=>{
  const rows = E.importLogsCSV('日付,SKU,受注件数,新規定期\n2026/10/1,A,12,3\n2026-10-02,A,8,');
  assert.deepStrictEqual(rows.map(r=>[r.date,r.orders,r.newSubs]), [['2026-10-01',12,3],['2026-10-02',8,0]]);
});
t('EC-Force 受注CSV: F1有効/F1発送済/F2+本数/未出荷/除外 を数える', ()=>{
  const csv = ['受注日,対応状況,定期回数,購入商品（商品名）,小計,商品ラベル',
    '2026-10-01 10:00,発送完了,1,商品A 通常プラン,2000,サンプル商品',
    '2026-10-01 11:00,注文確定,1,★【先行受付】商品A 通常プラン,2000,サンプル商品',
    '2026-10-01 12:00,発送完了,2,商品A プランBプラン,9000,サンプル商品',
    '2026-10-01 13:00,発送完了,3,商品A 通常プラン,6000,サンプル商品',
    '2026-10-01 14:00,キャンセル,1,商品A 通常プラン,2000,サンプル商品',
    '2026-10-01 15:00,発送完了,1,商品A プランB 解約手数料,5000,サンプル商品',
    '2026-10-02 09:00,決済完了,1,商品A 通常プラン,1800,サンプル商品'].join('\n');
  const r = E.importEcforceCSV(csv, { sku:'LZ', unitPrice:3000, firstUnits:1 });
  assert.deepStrictEqual(r.logs.map(l=>[l.date,l.newSubs,l.newSubsShipped,l.subShipped]), [['2026-10-01',2,1,5],['2026-10-02',1,0,0]]);
  assert.deepStrictEqual(r.pendingSubs, {LZ:2}); assert.strictEqual(r.excluded, 2); assert.deepStrictEqual(r.dates, ['2026-10-01','2026-10-02']);
  const r2 = E.importEcforceCSV(csv, { sku:'LZ', unitsByPlan:{通常:2, プランB:3} });
  assert.strictEqual(r2.logs[0].subShipped, 5);
});
t('日付演算はローカル日付（JST で1日ずれない）', ()=>{
  assert.strictEqual(E.addDays('2026-10-05', 41), '2026-11-15'); assert.strictEqual(E.addDays('2026-10-05', 0), '2026-10-05'); assert.strictEqual(E.diffDays('2026-10-05','2026-11-15'), 41);
  assert.strictEqual(E.fmt(E.toDate('2026-01-01')), '2026-01-01');
});
t('速度: 直近7日×0.6 + 28日×0.4', ()=>{
  const logs=[]; for(let d=-27; d<=0; d++) logs.push({date:E.addDays(base,d), sku:'A', orders: d>-7 ? 20 : 10});
  const v = E.velocity(logs, base, E.defaultSettings());
  const long = (7*20+21*10)/28; assert.ok(Math.abs(v.perDay-(0.6*20+0.4*long))<1e-9, v.perDay);
});
t('API 取り込み: 行配列の集計は CSV と同じ／未出荷件数はログの Σ(newSubs−newSubsShipped)', ()=>{
  const rows = [
    {'受注日':'2026/10/01 10:00','対応状況':'発送完了','定期回数':1,'購入商品（商品名）':'商品A 通常プラン','小計':2000,'商品ラベル':'サンプル商品'},
    {'受注日':'2026/10/01 11:00','対応状況':'注文確定','定期回数':1,'購入商品（商品名）':'★【先行受付】商品A 通常プラン','小計':2000,'商品ラベル':'サンプル商品'},
    {'受注日':'2026/10/01 12:00','対応状況':'発送完了','定期回数':3,'購入商品（商品名）':'商品A 通常プラン','小計':6000,'商品ラベル':'サンプル商品'},
    {'受注日':'2026/10/01 13:00','対応状況':'発送完了','定期回数':1,'購入商品（商品名）':'別商品X','小計':20000,'商品ラベル':'別商品X'},
  ];
  const r = E.importEcforceRows(rows, { labelToSku:{'サンプル商品':'LZ'}, unitPrice:3000, firstUnits:1 });
  assert.deepStrictEqual(r.logs, [{date:'2026-10-01', sku:'LZ', orders:0, newSubs:2, newSubsShipped:1, subShipped:2}]); assert.strictEqual(r.excluded, 1);
  const st = E.upsertLogs({logs:[{date:'2026-09-30', sku:'LZ', newSubs:5, newSubsShipped:2}]}, r.logs);
  assert.strictEqual(E.pendingFromLogs(st, 'LZ'), 3+1);
});
console.log(fails ? `\n${fails} 件 失敗` : '\n全件 合格');
process.exit(fails?1:0);
