#!/usr/bin/env node
/* ダミー（fixtures）を作る。本物の API 応答の attributes と同じ名前（created_at / updated_at / human_state / times / product_name_with_tax / subtotal / product_labels）。
   「今日」は 2026-10-20 固定（テストは --asof 2026-10-20 で回す）。
   orders.json: 2026-10-10〜10-19 の受注。10-13 の未出荷 3 件は 10-19 に発送完了になった（updated_at が 10-19）。
   state.json: 在庫が足りている商品（実棚 12,000・入荷予定 20,000）。逆テストはここに未出荷を足して 🔴 にする。 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E } from '../lib.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const TODAY = '2026-10-20';
let id = 500000; let seed = 11; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
const ts = (d, h) => `${d.replace(/-/g, '/')} ${String(h).padStart(2, '0')}:00:00`;
const orders = [];
const mk = (d, h, o) => orders.push(Object.assign({ id: ++id, number: `F${id}`, created_at: ts(d, h), updated_at: ts(d, h), payment_state: 'completed', product_labels: 'サンプル商品', customer_id: 1000 + (id % 700) }, o));
for (let d = '2026-10-10'; d <= '2026-10-19'; d = E.addDays(d, 1)) {
  const f1 = 38 + Math.round(6 * rnd());
  for (let i = 0; i < f1; i++) mk(d, 9 + (i % 10), { human_state: '発送完了', state: 'shipped', times: 1, product_name_with_tax: '商品A 通常プラン', subtotal: 2000 });
  for (let i = 0; i < 3; i++) mk(d, 20, { human_state: d === '2026-10-13' ? '発送完了' : '注文確定', state: d === '2026-10-13' ? 'shipped' : 'confirmed', times: 1, product_name_with_tax: '★【先行受付】商品A 通常プラン', subtotal: 2000, updated_at: d === '2026-10-13' ? ts('2026-10-19', 15) : ts(d, 20) });
  const f2 = 18 + Math.round(6 * rnd());
  for (let i = 0; i < f2; i++) mk(d, 10 + (i % 8), { human_state: '発送完了', state: 'shipped', times: 2 + (i % 5), product_name_with_tax: i % 4 === 0 ? '商品A プランBプラン' : '商品A 通常プラン', subtotal: i % 4 === 0 ? 9000 : 6000 });
  for (let i = 0; i < 2; i++) mk(d, 12, { human_state: 'キャンセル', state: 'canceled', times: 1, product_name_with_tax: '商品A 通常プラン', subtotal: 2000 });
  mk(d, 13, { human_state: '発送完了', state: 'shipped', times: 2, product_name_with_tax: '商品A プランB 解約手数料', subtotal: 5000 });
  for (let i = 0; i < 5; i++) mk(d, 14, { human_state: '発送完了', state: 'shipped', times: 1 + (i % 3), product_name_with_tax: '別商品X', subtotal: 20000, product_labels: '別商品X' });
}
writeFileSync(resolve(here, 'orders.json'), JSON.stringify(orders, null, 1) + '\n');

/* state: 2026-06-01〜10-12 のログ（新規 40 件/日・全部出荷済・定期出荷 45 本/日）、実棚 12,000（09-30）、入荷予定 20,000（11-30） */
const p = Object.assign(E.defaultProduct(), {
  sku: 'SAMPLE-A', name: 'サンプル商品A 150ml（fixture）', leadTimeDays: 120, moq: 0, lotStep: 0, unitCost: 500, safetyDays: 30, reviewDays: 30,
  stockBase: { date: '2026-09-30', qty: 12000 }, backlogSubs: 0,
  sub: { active: 0, cycleDays: 45, firstCycleDays: 30, qtyFirst: 1, qtyPerShip: 2, retentionCurve: [0.6, 0.4, 0.6, 0.6, 0.6], f2Rate: 0.6, retention: 0.6, newSubRatio: 0 },
  note: 'fixture（ダミー）。実データではない',
});
const logs = []; let s2 = 5; const r2 = () => { s2 = (s2 * 9301 + 49297) % 233280; return s2 / 233280; };
for (let d = '2026-06-01'; d <= '2026-10-12'; d = E.addDays(d, 1)) { const ns = 36 + Math.round(8 * r2()); logs.push({ date: d, sku: 'SAMPLE-A', orders: 0, newSubs: ns, newSubsShipped: ns, subShipped: 40 + Math.round(10 * r2()) }); }
const state = { products: [p], logs, pos: [{ id: 'po-fixture', sku: 'SAMPLE-A', qty: 20000, orderDate: '2026-07-30', eta: '2026-11-30', status: 'open', memo: 'fixture' }], settings: Object.assign(E.defaultSettings(), { horizonDays: 180 }), asOf: '2026-10-12', source: 'fixture（ダミー）。automation/fixtures/generate.mjs が作る' };
writeFileSync(resolve(here, 'state.json'), JSON.stringify(state, null, 1) + '\n');
writeFileSync(resolve(here, 'po.json'), JSON.stringify({ pos: state.pos }, null, 1) + '\n');
console.log(`orders ${orders.length} 件 / logs ${logs.length} 日 / TODAY ${TODAY}`);
