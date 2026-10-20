# D2C 在庫発注判定（サンプル）

> [!IMPORTANT] 結論
> **これは仕組みを見せるためのサンプルです。数字はすべてダミーで、実在の在庫・原価・発注とは関係ありません。**

| | |
|---|---|
| 判定の見本 | [outputs/latest.md](outputs/latest.md) |
| 動かす場所 | GitHub Actions（毎朝 07:30 JST） |
| 人が入れるもの | 発注した・入荷した の記録だけ |

## 何をするか

毎朝、機械が EC-Force の受注を読み、在庫の発注が要るか・何本か・いつまでかを出して Chatwork に配信します。

| 順 | すること | ファイル |
|---|---|---|
| ① | EC-Force 受注を取り込む | `automation/fetch-ecforce.mjs` |
| ② | 判定して結果を書く | `automation/run-judgment.mjs` |
| ③ | Chatwork に投稿する | `automation/post-chatwork.mjs` |

- ① は ecforce Admin API v2（参照のみ・1秒1リクエストを守る）。定期回数1＝新規定期、うち発送完了＝初回出荷済、2回目以降の発送完了＝定期出荷本数として日ごとに数えます。未出荷の件数も受注から機械が出します。
- ② は入荷予定（`automation/po.json`）を反映してから計算し、`outputs/latest.md`（結論→表→次にやること）を書きます。
- ③ は同じ中身を Chatwork の1ルームに投稿します。
- 本番では API の認証トークンを GitHub Secrets に置きます。このサンプルには入っていません。

## 判定のしくみ

- **定期の需要**: 過去の各日の新規定期の件数から、2回目・3回目…の出荷日と段階別の継続率で将来の出荷を置く（初回→2回目は短い周期、以降は通常周期）
- **未出荷**: 在庫で賄えなければ、最初の入荷日にまとめて出荷される
- **安全在庫**: 1日の消化 × 安全在庫日数
- **発注期限**: 安全在庫を割る日 − リードタイム
- **推奨発注数**: リードタイム後の在庫で「発注間隔ぶんの需要＋安全在庫」を賄えない分（最小ロットと発注単位に切り上げ）
- 🔴 = 欠品中、発注期限超過、またはリードタイム内に在庫切れ／🟡 = 発注期限が近い、または過剰在庫の疑い／🟢 = 範囲内

## 手元で試す（トークン不要）

```
node test.js                          # 計算の検証
node automation/test-automation.mjs   # 取り込み→判定の通し・逆テスト（ダミー受注）
node automation/run-judgment.mjs --asof 2026-10-20
node automation/post-chatwork.mjs --dry-run   # Chatwork に送る文面を表示するだけ
```

画面で見るなら、このフォルダで `python3 -m http.server` を起動し、`http://localhost:8000/index.html?view=1` を開きます。

## ファイル

| ファイル | 役割 |
|---|---|
| `engine.js` | 計算（画面なし・node でも動く） |
| `index.html` | 画面（`?view=1` で閲覧専用） |
| `automation/` | 取り込み・判定・配信のスクリプト |
| `automation/fixtures/` | ダミーの受注と在庫 |
| `data/sample-state.json` | ダミーの在庫と受注の集計 |
| `outputs/latest.md` | 判定の見本 |
