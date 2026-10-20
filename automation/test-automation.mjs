#!/usr/bin/env node
/* automation の検査（トークン無し・fixtures で回す）。node automation/test-automation.mjs
   ① fetch → judgment が通り latest.md が出力デザイン規約の形（結論ブロック→表3列→次にやること）
   ② 既定モードが「昨日以降に更新された受注」の受注日を取り直す
   ③ 逆テスト: fixtures の未出荷（注文確定の定期1回目）を増やすと判定が 🔴 欠品中 に変わる（増やす前は 🔴 でない）
   ④ 投稿してはいけないルームへの投稿は機械が止める／po.json の形式エラーで止まる */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT } from './lib.mjs';

const TODAY = '2026-10-20';
const FX = resolve(ROOT, 'automation/fixtures');
const tmp = mkdtempSync(join(tmpdir(), 'inventory-automation-'));
const node = (args, env = {}) => spawnSync(process.execPath, args.map((a) => a.replace('{tmp}', tmp)), { cwd: ROOT, env: { ...process.env, ...env, GITHUB_ACTIONS: '' }, encoding: 'utf8' });
let fails = 0;
function t(name, fn) { try { fn(); console.log('✅', name); } catch (e) { fails++; console.log('❌', name, '\n   ', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const J = (p) => JSON.parse(readFileSync(p, 'utf8'));

const fixtures = J(resolve(FX, 'orders.json'));
const expect = (date) => {
  const mine = fixtures.filter((o) => String(o.product_labels).includes('サンプル商品') && o.created_at.startsWith(date.replace(/-/g, '/')) && !/解約手数料/.test(o.product_name_with_tax));
  const f1 = mine.filter((o) => Number(o.times) <= 1 && ['発送完了', '注文確定', '決済完了', '発送準備', '決済保留', '入金待ち'].includes(o.human_state));
  return { newSubs: f1.length, shipped: f1.filter((o) => o.human_state === '発送完了').length };
};
const expectedBacklog = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'].reduce((s, d) => { const e = expect(d); return s + e.newSubs - e.shipped; }, 0);

copyFileSync(resolve(FX, 'state.json'), join(tmp, 'state.json'));
t('① fetch（fixtures・--since 埋め戻し）が通り、集計が fixtures を直接数えた値と一致', () => {
  const r = node(['automation/fetch-ecforce.mjs', '--fixtures', 'automation/fixtures/orders.json', '--asof', TODAY, '--since', '2026-10-10', '--state', '{tmp}/state.json']);
  assert(r.status === 0, r.stderr);
  const st = J(join(tmp, 'state.json'));
  const row = st.logs.find((l) => l.date === '2026-10-19');
  const e = expect('2026-10-19');
  assert(row && row.newSubs === e.newSubs && row.newSubsShipped === e.shipped, `10-19: ${JSON.stringify(row)} vs ${JSON.stringify(e)}`);
  assert(row.subShipped > 0, 'subShipped が 0');
  assert(st.products[0].backlogSubs === expectedBacklog, `backlog ${st.products[0].backlogSubs} ≠ ${expectedBacklog}`);
  assert(st.asOf === '2026-10-19', `asOf ${st.asOf}`);
  assert(!st.logs.some((l) => l.date === TODAY), '今日の分を取ってはいけない');
});
t('② 既定モード: 直近3日＋「昨日以降に更新された受注」の受注日（10-13 の予約が 10-19 に発送完了）を取り直す', () => {
  const r = node(['automation/fetch-ecforce.mjs', '--fixtures', 'automation/fixtures/orders.json', '--asof', TODAY, '--state', '{tmp}/state.json', '--dry-run']);
  assert(r.status === 0, r.stderr);
  const lf = JSON.parse(r.stdout);
  assert(JSON.stringify(lf.dates) === JSON.stringify(['2026-10-13', '2026-10-17', '2026-10-18', '2026-10-19']), JSON.stringify(lf.dates));
});
t('① judgment → latest.md が規約の形（H1→結論ブロック→表3列→H2まで→次にやること）・fixtures の在庫は 🔴 でない', () => {
  const r = node(['automation/run-judgment.mjs', '--state', '{tmp}/state.json', '--out', '{tmp}/out', '--po', 'automation/fixtures/po.json', '--asof', TODAY]);
  assert(r.status === 0, r.stderr);
  const md = readFileSync(join(tmp, 'out/latest.md'), 'utf8'); const lines = md.split('\n');
  assert(lines[0].startsWith('# '), 'H1 で始まらない');
  assert(lines[2] === '> [!IMPORTANT] 結論', '結論ブロックが H1 直後に無い');
  const one = lines[3].replace(/^>\s*\*\*/, '').replace(/\*\*$/, '');
  assert([...one].length <= 40, `結論が40字超: ${one}`);
  assert(/^\| 🚦 \| (🟢 平常|🟡 注意|🔴 要対応) \|$/.test(lines[7]), `信号行: ${lines[7]}`);
  lines.filter((l) => l.startsWith('|') && !/^\|[-| ]+\|$/.test(l)).forEach((l) => { const c = l.split('|').length - 2; assert(c <= 3, `表が3列超: ${l}`); });
  assert(!lines.some((l) => l.startsWith('### ')), 'H3 がある');
  assert(md.includes('\n## 次にやること\n'), '次にやること が無い');
  assert(lines.indexOf('## 次にやること') > lines.findIndex((l) => l.startsWith('## SAMPLE')), '次にやること が末尾でない');
  const out = J(join(tmp, 'out/latest.json'));
  assert(out.results[0].status !== '🔴', `fixtures の在庫が 🔴（${out.results[0].reason}）では逆テストにならない`);
  assert(out.asOf === TODAY && out.dataThrough === '2026-10-19', `asOf ${out.asOf} / dataThrough ${out.dataThrough}`);
});
t('③ 逆テスト: 未出荷（注文確定の定期1回目）を 15,000 件足すと 🔴 欠品中 に変わる', () => {
  const extra = []; let id = 900000;
  for (let i = 0; i < 15000; i++) extra.push({ id: ++id, number: `R${id}`, created_at: '2026/10/19 21:00:00', updated_at: '2026/10/19 21:00:00', human_state: '注文確定', state: 'confirmed', times: 1, product_name_with_tax: '★【先行受付】商品A 通常プラン', subtotal: 2000, product_labels: 'サンプル商品', customer_id: 1 });
  writeFileSync(join(tmp, 'orders-red.json'), JSON.stringify(fixtures.concat(extra)));
  const f = node(['automation/fetch-ecforce.mjs', '--fixtures', join(tmp, 'orders-red.json'), '--asof', TODAY, '--since', '2026-10-19', '--state', '{tmp}/state.json']);
  assert(f.status === 0, f.stderr);
  const st = J(join(tmp, 'state.json'));
  assert(st.products[0].backlogSubs === expectedBacklog + 15000, `backlog ${st.products[0].backlogSubs}`);
  const r = node(['automation/run-judgment.mjs', '--state', '{tmp}/state.json', '--out', '{tmp}/out-red', '--po', 'automation/fixtures/po.json', '--asof', TODAY]);
  assert(r.status === 0, r.stderr);
  const out = J(join(tmp, 'out-red/latest.json'));
  assert(out.results[0].status === '🔴' && /欠品中/.test(out.results[0].reason), `${out.results[0].status} ${out.results[0].reason}`);
  const md = readFileSync(join(tmp, 'out-red/latest.md'), 'utf8').split('\n');
  assert(md[3].startsWith('> **🔴 欠品中'), md[3]);
  assert(md.includes('| 要対応 | 1件 |'), '要対応 1件 が無い');
  assert(md.some((l) => /^\| 今日 \| .+本 を発注する \| 発注担当 \|$/.test(l)), '次にやること に発注が無い');
});
t('③-b 対応状況の値が想定外（全件除外）なら state を書き換えずに止まる（exit 3）', () => {
  const alien = fixtures.filter((o) => o.created_at.startsWith('2026/10/19')).map((o) => ({ ...o, human_state: 'SHIPPED_X' }));
  writeFileSync(join(tmp, 'orders-alien.json'), JSON.stringify(alien));
  const before = readFileSync(join(tmp, 'state.json'), 'utf8');
  const f = node(['automation/fetch-ecforce.mjs', '--fixtures', join(tmp, 'orders-alien.json'), '--asof', TODAY, '--since', '2026-10-19', '--state', '{tmp}/state.json']);
  assert(f.status === 3, `exit ${f.status}`);
  assert(readFileSync(join(tmp, 'state.json'), 'utf8') === before, 'state が書き換わった');
});
t('④ Chatwork: dry-run は【自動通知】で始まる／拒否リストのルームへは投稿せず exit 1／拒否リスト未設定・トークン無しは exit 0 で飛ばす', () => {
  const d = node(['automation/post-chatwork.mjs', '--file', '{tmp}/out-red/latest.md', '--dry-run']);
  assert(d.status === 0 && d.stdout.startsWith('【自動通知】') && d.stdout.includes('[info][title]結論[/title]🔴'), d.stdout.slice(0, 200));
  const deny = node(['automation/post-chatwork.mjs', '--file', '{tmp}/out-red/latest.md'], { CHATWORK_TOKEN: 'dummy', CHATWORK_ROOM_ID: '222', CHATWORK_DENY_ROOMS: '111,222' });
  assert(deny.status === 1 && /投稿してはいけない/.test(deny.stderr), `exit ${deny.status} ${deny.stderr}`);
  const noDeny = node(['automation/post-chatwork.mjs', '--file', '{tmp}/out-red/latest.md'], { CHATWORK_TOKEN: 'dummy', CHATWORK_ROOM_ID: '333', CHATWORK_DENY_ROOMS: '' });
  assert(noDeny.status === 0 && /CHATWORK_DENY_ROOMS/.test(noDeny.stderr), `exit ${noDeny.status} ${noDeny.stderr}`);
  const skip = node(['automation/post-chatwork.mjs', '--file', '{tmp}/out-red/latest.md'], { CHATWORK_TOKEN: '', CHATWORK_API_TOKEN: '', CHATWORK_ROOM_ID: '' });
  assert(skip.status === 0 && /未設定/.test(skip.stderr), `exit ${skip.status} ${skip.stderr}`);
});
t('④ po.json: eta の無い open 行があれば exit 2', () => {
  writeFileSync(join(tmp, 'po-bad.json'), JSON.stringify({ pos: [{ id: 'x', sku: 'SAMPLE-A', qty: 100, status: 'open' }] }));
  const r = node(['automation/run-judgment.mjs', '--state', '{tmp}/state.json', '--out', '{tmp}/out-bad', '--po', '{tmp}/po-bad.json', '--asof', TODAY]);
  assert(r.status === 2 && /eta/.test(r.stderr), `exit ${r.status}`);
});
t('本番トークン無し・fixtures 無しなら exit 2（トークンは環境変数からだけ読む）', () => {
  const r = node(['automation/fetch-ecforce.mjs', '--asof', TODAY, '--state', '{tmp}/state.json'], { ECFORCE_API_TOKEN: '', ECFORCE_BASE_URL: '', ECFORCE_FIXTURES: '' });
  assert(r.status === 2 && /ECFORCE_API_TOKEN/.test(r.stderr), `exit ${r.status}`);
});
rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} 件 失敗` : '\n全件 合格');
process.exit(fails ? 1 : 0);
