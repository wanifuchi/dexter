# 本日の注目銘柄タブ 仕様書

## 1. 目的

Finx の Web UI に、`本日の注目銘柄` タブを追加する。

このタブの目的は、チャットの文脈やユーザー嗜好に引っ張られず、当日の価格・出来高・ニュース材料に基づいて「今日見る価値がある銘柄」だけを表示すること。

必須ゴールは次の 4 つ。

1. `今日の材料ベース` で候補を抽出する
2. `各銘柄ごと` に current evidence が揃ったものだけを表示する
3. データ不足の日は無理に銘柄を出さず、`本日は推奨なし` を表示する
4. チャットの recommendation ロジックとは分離し、専用タブとして deterministic に動作させる

## 2. 背景と現状

現状の `今日のおすすめ銘柄` 系の回答は、チャット経由でツールを都度組み合わせて出している。

関連箇所:

- UI 本体: [public/index.html](/Users/noriaki/Desktop/claude_base/dexter/public/index.html)
- 同期元: [src/web/public/index.html](/Users/noriaki/Desktop/claude_base/dexter/src/web/public/index.html)
- 推薦ガード: [src/agent/recommendation-guard.ts](/Users/noriaki/Desktop/claude_base/dexter/src/agent/recommendation-guard.ts)
- エージェント実行: [src/gateway/agent-runner.ts](/Users/noriaki/Desktop/claude_base/dexter/src/gateway/agent-runner.ts)
- 市場データ: [src/tools/finance/get-market-data.ts](/Users/noriaki/Desktop/claude_base/dexter/src/tools/finance/get-market-data.ts)
- 個別ニュース: [src/tools/finance/news.ts](/Users/noriaki/Desktop/claude_base/dexter/src/tools/finance/news.ts)
- スクリーニング: [src/tools/finance/screen-stocks.ts](/Users/noriaki/Desktop/claude_base/dexter/src/tools/finance/screen-stocks.ts)

### 2.1 現状の問題

1. チャットはユーザー文脈と混ざりやすく、`今日の材料` より `過去の好み` に寄ることがある
2. ツールが部分失敗すると、十分な裏取りがないまま候補を出しやすい
3. `今日のおすすめ` を聞くたびに LLM が都度考えるため、出力の一貫性が弱い
4. 専用 UI がないため、`なぜ今日その銘柄なのか` を一覧で見せづらい

## 3. ゴール

### 3.1 必須ゴール

1. `本日の注目銘柄` という専用タブを追加する
2. タブは `当日の材料株スキャン結果` を一覧表示する
3. 候補抽出は deterministic な server-side pipeline で行う
4. 各表示銘柄は、少なくとも
   - current price / day change / volume
   - 同日または直近 24 時間以内のニュース/材料
   を持つ
5. current evidence が不足する銘柄は表示しない
6. 候補が 0 件なら、`本日は推奨なし` の empty state を表示する

### 3.2 非ゴール

- チャット recommendation 機能の置き換え
- パーソナライズド推薦
- 長期投資の銘柄選定
- 完全自動売買
- 毎日必ず 3 銘柄以上を出すこと

## 4. プロダクト方針

### 4.1 タブ名

UI 表示名は `本日の注目銘柄` とする。

理由:

- `おすすめ` よりも `注目` の方が過剰約束を避けやすい
- データ不足時に `0 件` を自然に表現できる

### 4.2 設計原則

1. `data-first`
   - 過去会話や memory を使って候補を補完しない
2. `per-ticker evidence required`
   - クエリ全体ではなく、各銘柄ごとに根拠を要求する
3. `no evidence, no pick`
   - 裏取り不足なら候補は出さない
4. `deterministic first`
   - MVP では LLM をランキング本体に使わない
5. `explain why today`
   - 各銘柄に「今日なぜ注目か」を 1 行で出す

## 5. ユーザー体験

### 5.1 基本動作

1. ユーザーが `本日の注目銘柄` タブを開く
2. フロントが `/api/daily-picks` を呼ぶ
3. サーバー側で候補抽出・材料確認・スコアリングを実行する
4. 根拠が揃った 3〜5 銘柄を表示する
5. 根拠が不足する場合は `今日は見送り` を表示する

### 5.2 画面要素

最低限ほしい UI:

- タブボタン `本日の注目銘柄`
- ヘッダ
  - タイトル
  - `最終更新時刻`
  - `Refresh` ボタン
- フィルタ行
  - `市場`: `US` / `JP` / `両方`
  - `モード`: `標準` / `ペニー含む`
- ステータス領域
  - `スキャン中`
  - `データ不足`
  - `0件`
- 銘柄カードまたはテーブル
  - ticker / 銘柄名
  - 現在値
  - 当日騰落率
  - 出来高 or 出来高異常フラグ
  - 今日の材料要約
  - 根拠バッジ
  - 参照ソース

### 5.3 Empty State

データ不足や該当候補なしの場合は、次のような short message を出す。

```text
本日は、具体銘柄を出せる水準の最新データが揃わなかったため見送りです。
```

禁止:

- `ツール不調だが候補だけ出す`
- `監視優先リストとしてこの5つ`
- `断定買いではないが候補を出す`

## 6. データパイプライン

## 6.1 全体フロー

MVP では、次の 4 段階で動かす。

1. 候補抽出
2. 個別銘柄の current evidence 収集
3. evidence gating
4. スコアリングと表示整形

### Step 1: 候補抽出

候補は 10〜20 銘柄までに絞る。

候補抽出の優先シグナル:

- 当日上昇率上位
- 出来高急増
- テーマ性のあるセクター資金流入
- ギャップアップ / ブレイク候補

MVP の実装は、次のいずれかでよい。

1. 既存データソースの public endpoint を直接叩く
2. 既存の finance tool 相当の内部 fetch helper を追加する
3. 既存スクリーニングを補助的に使う

ただし重要なのは、`LLM に自然言語で候補出しさせない` こと。

### Step 2: 個別銘柄 evidence 収集

候補ごとに最低限これを集める。

- current price
- day change
- current volume
- 同日または直近 24 時間以内のニュース/材料

優先データソース:

- 価格/出来高: Yahoo Finance 相当の current quote / chart 系
- ニュース: 既存の company news 取得ロジック、または同等の server-side fetch

### Step 3: Evidence Gating

各 ticker は、少なくとも次を満たさない限り表示してはいけない。

#### 必須要件

1. price / change / volume の 3 点が取得できている
2. 同日または直近 24 時間のニュース/材料が 1 件以上ある
3. ソース URL を 1 件以上表示できる

#### 無効データ判定

次は evidence なし扱い。

- `null` / `undefined`
- 空配列 / 空オブジェクト
- `_errors` しかない結果
- `error` しかない結果
- タイトルや URL が欠けたニュース

### Step 4: スコアリング

MVP では deterministic な weighted score で十分。

推奨スコア要素:

- `momentumScore` 0-30
  - 当日騰落率
- `volumeScore` 0-25
  - 出来高水準、異常値
- `catalystScore` 0-30
  - 当日ニュース件数、鮮度、説明可能性
- `liquidityScore` 0-15
  - 極端に薄い銘柄を減点

最終表示は score 上位 3〜5 銘柄。

### 6.2 市場別要件

#### MVP

- `US` を必須対応
- `JP` は対応できれば入れるが、未対応でもよい
- `両方` は `US` と `JP` の両方が利用可能な場合のみ有効

#### Phase 2

- `JP` の候補抽出を J-Quants または同等データソースで強化
- 日本株の値上がり率上位 / 出来高急増 / 材料確認を強化

### 6.3 ペニーモード

`ペニー含む` を ON にした場合のみ、低位株を候補に含めてよい。

推奨ルール:

- 標準モード: 価格下限あり
- ペニーモード: 価格下限を下げる
- ただし極端に薄い銘柄は除外

MVP では threshold の細かい数値は実装者判断でよいが、`標準` と `ペニー含む` で universe が切り替わることは必須。

## 7. API 仕様

### 7.1 新規 API

`GET /api/daily-picks`

クエリ例:

```text
/api/daily-picks?market=us&mode=standard
```

クエリパラメータ:

- `market`
  - `us` | `jp` | `both`
- `mode`
  - `standard` | `penny`
- `refresh`
  - `1` の場合はキャッシュ無視

### 7.2 レスポンス例

```json
{
  "generatedAt": "2026-04-07T01:23:45.000Z",
  "market": "us",
  "mode": "standard",
  "status": "ok",
  "picks": [
    {
      "ticker": "RKLB",
      "name": "Rocket Lab",
      "market": "US",
      "price": 12.34,
      "changePct": 8.9,
      "volume": 12345678,
      "score": 78,
      "evidence": {
        "price": true,
        "volume": true,
        "news": true
      },
      "summary": "出来高増加と当日材料で資金流入が継続。",
      "catalysts": [
        {
          "title": "Rocket Lab ...",
          "url": "https://..."
        }
      ],
      "sourceUrls": ["https://..."]
    }
  ],
  "warnings": []
}
```

### 7.3 データ不足時

```json
{
  "generatedAt": "2026-04-07T01:23:45.000Z",
  "market": "us",
  "mode": "standard",
  "status": "insufficient_data",
  "picks": [],
  "warnings": [
    "Insufficient current evidence to publish daily picks."
  ]
}
```

### 7.4 キャッシュ

MVP では 5〜10 分程度の TTL キャッシュを推奨する。

理由:

- 同じタブを何度も開いた時の API 負荷軽減
- 同一営業日中の過剰な再計算回避

保存先は実装者判断でよい。

- Redis / Upstash が使えるならそれを優先
- なければ短命の in-memory cache でも可

ただし、`refresh=1` ではキャッシュを無視できること。

## 8. フロントエンド仕様

対象:

- [public/index.html](/Users/noriaki/Desktop/claude_base/dexter/public/index.html)
- [src/web/public/index.html](/Users/noriaki/Desktop/claude_base/dexter/src/web/public/index.html)

### 8.1 ナビゲーション

新規 nav button:

- id: `nav-daily-picks`
- label: `注目銘柄`
- action: `showPage('daily-picks')`

### 8.2 ページ

新規 page:

- id: `daily-picks-page`

新規 loader:

- `loadDailyPicksPage()`

`showPage(page)` の分岐に追加し、初回表示時と refresh 時に API を呼ぶ。

### 8.3 表示状態

最低限必要な状態:

- `idle`
- `loading`
- `ok`
- `empty`
- `insufficient_data`
- `error`

### 8.4 1銘柄カードの表示項目

- ticker
- 銘柄名
- 市場
- 現在値
- 当日騰落率
- 出来高
- スコア
- 今日の材料 1 行
- ニュースリンク 1〜3 件

### 8.5 禁止事項

このタブでは次をしてはいけない。

1. ユーザーの memory / 過去会話を使って銘柄を補完する
2. データ不足時に推測で銘柄名を出す
3. `候補だけ` `監視用だけ` のような半端な推薦を出す
4. LLM に自然言語で `今日のおすすめ` を考えさせる

## 9. 実装方針

### 9.1 推奨ファイル構成

新規追加候補:

- `api/daily-picks.ts`
- `src/api-handlers/daily-picks.ts`
- `src/services/daily-picks.ts`
- `src/services/daily-picks-cache.ts`
- `src/services/daily-picks-types.ts`

既存変更候補:

- [public/index.html](/Users/noriaki/Desktop/claude_base/dexter/public/index.html)
- [src/web/public/index.html](/Users/noriaki/Desktop/claude_base/dexter/src/web/public/index.html)

### 9.2 LLM 利用方針

MVP では、候補抽出・絞り込み・スコアリングに LLM を使わない。

許可するなら次だけ。

- `summary` を短く整形する補助

ただし、summary 生成に失敗しても pick 判定は変えないこと。

### 9.3 チャットとの関係

既存の recommendation guard はそのまま維持する。

役割分担:

- チャット
  - recommendation を雑に出さないためのブレーキ
- 本日の注目銘柄タブ
  - data-driven pick のエンジン

将来的には、チャットで `今日のおすすめ` と聞かれたら、このタブの結果を参照する形に寄せてもよい。

## 10. 受け入れ条件

### AC-1

`注目銘柄` タブを開くと `daily-picks-page` が表示される

### AC-2

US 市場で current evidence が十分な日には 3〜5 銘柄が表示される

### AC-3

各表示銘柄には、

- price
- change
- volume
- 同日または直近 24h ニュース

が揃っている

### AC-4

evidence 不足の銘柄は表示されない

### AC-5

evidence 不足の日は `picks: []` と empty state を表示し、具体 ticker を出さない

### AC-6

`ペニー含む` ON/OFF で候補 universe が変わる

### AC-7

`public/index.html` と `src/web/public/index.html` が同期されている

## 11. テスト要件

最低限追加してほしいテスト:

1. 候補抽出はできたが、個別 ticker のニュースが取れない
   - 該当 ticker は除外される
2. price/change/volume はあるが news がない
   - 推薦不可
3. news はあるが current quote が不足
   - 推薦不可
4. per-ticker evidence が揃った 3 銘柄
   - スコア順で表示される
5. evidence 不足時
   - `status=insufficient_data`
   - `picks=[]`
   - 具体 ticker 名を返さない
6. `market=us` と `mode=penny` の組み合わせで結果が返る
7. `refresh=1` でキャッシュをバイパスできる

可能なら追加:

8. フロントの `loadDailyPicksPage()` が `ok / insufficient_data / error` を描画し分ける

## 12. 実装上の注意

1. `本日の注目銘柄` は chat completion ではなく server-side data pipeline として作ること
2. data source が部分的に失敗しても、evidence gating をすり抜けて ticker を出してはいけない
3. `memory_search` や user preference をこのタブで使わないこと
4. UI 文言は短く、内部事情を書きすぎないこと
5. データ不足時の fallback には個別 ticker 名を含めないこと

## 13. 実装順の推奨

1. `api/daily-picks.ts` と server-side pipeline を作る
2. deterministic candidate/evidence/scoring を実装する
3. `daily-picks-page` を追加する
4. `showPage('daily-picks')` と `loadDailyPicksPage()` を接続する
5. `empty / insufficient_data / error` を実装する
6. テストと型チェックを通す
