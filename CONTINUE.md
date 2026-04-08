# Finx 開発メモ — 次回再開用

## 直近セッションの成果（〜2026-04-09）

### 新機能

#### 1. 投資家ペルソナ分析・Bull vs Bear討論・予測市場オッズ
- **実装場所:** [src/agent/investment-wisdom.ts](src/agent/investment-wisdom.ts), [src/tools/finance/prediction-market.ts](src/tools/finance/prediction-market.ts)
- **投資家ペルソナ分析** — バフェット/リンチ/グレアム/マークス/ソロスの5視点で銘柄判定（プロンプトベース）
- **Bull vs Bear討論** — 強気/弱気の構造化ディベートフォーマット
- **予測市場オッズ** — Polymarket APIから利下げ確率等を取得
  - 重要: Polymarket gamma APIは`title`検索が機能しないため、volume順で上位200イベントを取得→ローカルでキーワードフィルタする方式
  - 日本語キーワード同義語展開対応（「利下げ」→ fed, rate cut, fomc等）

#### 2. 画像アップロード + Vision分析
- **実装場所:** [public/index.html](public/index.html) `sendMessage()`, [api/chat.ts](api/chat.ts), [src/model/llm.ts](src/model/llm.ts)
- +ボタンで画像添付 → GPT-5.4 Visionで読み取り
- base64でchat APIに送信、最初のイテレーションでのみLLMに画像を渡す
- 10MB制限、sessionStorageで一時保持

#### 3. 会話継続性改善 — FollowUpResolver + ThreadStore
- **実装場所:** [src/conversation/](src/conversation/), [api/conversations.ts](api/conversations.ts)
- **ThreadStore** (`finx:thread:*`) — 全会話スレッドのsource of truth（Redis正）
- **FollowUpResolver** — 「続けて」「1,2」「両方」等をアプリ層で解決
- **NextActionsExtractor** — assistant回答から番号付き候補を構造化抽出
- **長文継続要求対応** — 「1. xxx 2. xxx 3. xxx たのむ」のような列挙も拾う
- **raw/resolved query分離** — userMessage(生入力) と resolvedUserMessage(解決後) を別保存
- agent-runnerでThreadStoreからInMemoryChatHistoryを復元（cold start対応）
- agent.buildInitialPromptでThreadStoreのrecentTurnsをprompt contextに注入

#### 4. ポートフォリオAPIにBasic認証
- **実装場所:** [api/data.ts](api/data.ts)
- PROTECTED_TYPES: portfolio/dividends/watchlist/snapshots/tax-goals
- 環境変数: `PORTFOLIO_BASIC_USER=finx`, `PORTFOLIO_BASIC_PASSWORD=0620dad`
- UI側: `portfolioFetchWithRetry()`, 認証情報はsessionStorageのみ（localStorage不可）
- `addPositionUI()`を`/api/chat`経由から`/api/portfolio` POST経由に変更（認証漏れ防止）

#### 5. 本日の米国株注目銘柄タブ（US専用MVP）
- **実装場所:** [src/services/daily-picks.ts](src/services/daily-picks.ts), [api/daily-picks.ts](api/daily-picks.ts)
- **Deterministic data pipeline（LLM非使用）**
  - Step 1: 候補抽出（Yahoo trending + Finnhub news mentioned tickers、最大20件）
  - Step 2: Evidence収集（Yahoo quote + Finnhub company news、並列）
  - Step 3: Evidence Gating — price/change/volume + 24h以内ニュース必須
  - Step 4: Scoring — momentum(0-30) + volume(0-25) + catalyst(0-30) + liquidity(0-15)
- **FINNHUB_API_KEY必須** — 未設定なら`insufficient_data`を返す
- キャッシュTTL 10分（Redis優先 + in-memoryフォールバック）
- UI: 説明ボックス + CSS tooltip（`data-tip`属性、`::after`疑似要素で即時表示）
- 市場ステータスバッジ（ET基準で市場前/取引時間中/取引後/週末を自動判定）

#### 6. 利確判定タブ（rumaトレード理論）
- **実装場所:** [public/index.html](public/index.html) `loadProfitCheckPage()` / `pcDecide()`
- **rumaトレード理論の4原則ベース** — 4ステップQAで利確判定
  - Step 1: トレンド狙い / レンジ狙い / 決めていなかった
  - Step 2: シナリオ生きている / 崩れた / 判断不能
  - Step 3: 逆ポジ質問（今売りで入る根拠ある?）
  - Step 4: 事前利確ライン到達?
- **8パターンの判定ロジック**（[public/index.html:pcDecide](public/index.html)）
  - シナリオ崩壊 → 全部利確（撤退）
  - 逆ポジYES + ターゲット到達 → 全部利確
  - 逆ポジYES + ターゲット未到達 → 半分利確（50/50決済）
  - トレンド狙い + 逆ポジNO + ターゲット到達 → 保有継続
  - レンジ狙い + ターゲット到達 → 全部利確
  - 逆ポジNO + ターゲット未到達 → 保有継続
  - 利確ライン未設定 → 半分利確 + 設計やり直し
  - 戦略未決定 → 一旦半分利確 + 戦略確定
- 各判定に具体的な株数を計算表示、ポートフォリオ認証と連動

### ガード層の強化

#### Recommendation Guard（時点依存推薦の誤爆防止）
- **実装場所:** [src/agent/recommendation-guard.ts](src/agent/recommendation-guard.ts)
- **4層ガード:**
  1. Query-level evidence（有効ツール2件以上）
  2. Personalization表現検出（「あなた向け」「過去履歴」等）
  3. Hedging recommendation検出（「ツール不調」「監視優先」+ ticker列挙）
  4. Per-ticker evidence（各推薦tickerがtool resultsに含まれているか）
- **memory_search物理ブロック** — time-sensitive + non-personalized queryではツールリストから除外
  - `AgentConfig.blockedTools: Set<string>` で実装
  - agent-runnerで`shouldBlockMemory(intent)` → blockedToolsを渡す
- **isToolResultValid()** — tool_endが出ても中身が`_errors`/`error`/空ならevidence無効扱い

### UI修正

- **新規会話の切り方と履歴スレッド分離**
  - sessionId生成を `crypto.randomUUID()` ベースに
  - Finxロゴ・チャットタブ → `newConversation()`（新threadId + welcome画面）
  - 送信中のsessionId race防止: `sendMessage()`先頭で`const requestSessionId = sessionId`で固定
  - welcome HTMLを`getWelcomeMarkup()`で共通化
- **モバイル対応** — `body`の`height: 100vh` → `100dvh`（アドレスバー問題解消）
- **CSS tooltip** — 既存の`title`属性より高速表示（hover後100ms）
  - `[data-tip]::after` で`width: max-content` + `left: 0`（縦長表示バグ修正済み）

### 重要な設計判断

1. **ThreadStoreをsource of truthに統一** — 従来のInMemoryChatHistory（`finx:session:*`）とThreadStore（`finx:thread:*`）の二重管理を解消。Redisの`finx:thread:*`が唯一の正、InMemoryChatHistoryは短期コンテキスト管理用に存続
2. **daily-picksはLLM非使用** — MVPではdeterministicなweighted scoreで十分。LLMは使わない
3. **memory_searchは時点依存推薦では物理除外** — プロンプトだけでなくtool listから消す
4. **Vercelのファイル永続化は信用しない** — Redis正、ファイルはローカル開発フォールバック専用

### 未対応・残課題

- **JP市場対応** — daily-picksはUS専用MVP。J-Quants統合はPhase 2
- **スレッドstore削除API** — localStorage削除は可能だがRedis側は残る
- **offeredNextActions抽出精度** — 正規表現ベース、LLMが独自フォーマットで候補出すと抽出失敗の可能性
- **旧`finx:session:*`データのThreadStore移行** — 新規会話から統一経路、旧データはそのまま

### 最近のコミット履歴（新しい順）

```
61e201d feat: 利確判定タブ追加 — rumaトレード理論の4原則ベース
cd8d615 fix: tooltip縦長表示を修正
505e4df fix: tooltipをCSS即時表示に変更
d19596c feat: 米国株注目銘柄タブに説明UI・tooltip・市場ステータスバッジ
cd513b0 fix: 注目銘柄タブをUS専用MVPに整理
10d027e feat: 本日の注目銘柄タブを追加 — server-side data pipeline
d16742a fix: recommendation guardをquery-levelからticker-levelに強化
082a9d2 fix: ロゴ・チャットタブ押下でnewConversation()に統一
109258b fix: memory_searchをアプリ層で実際にブロック + プロンプト矛盾解消
4623f77 fix: 時点依存推薦ガードを強化 — 結果中身ベース判定+final answer guard
6c0b203 fix: 新規会話の切り方と履歴スレッド分離を修正
```

### 環境変数（Vercel本番に設定が必要）

```
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
FINNHUB_API_KEY=...                    # daily-picks必須
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
PORTFOLIO_BASIC_USER=finx              # ポートフォリオ認証
PORTFOLIO_BASIC_PASSWORD=0620dad       # ポートフォリオ認証
```

### 開発のコツ（このセッションで学んだこと）

1. **git lockに注意** — 並列gitコマンドで`.git/index.lock`が残ることがある。失敗したら`rm -f .git/index.lock`
2. **HTMLの二重管理** — `public/index.html` と `src/web/public/index.html` は必ず同期。`cp`で済む
3. **CSS inline警告は無視してOK** — 既存のパターンに合わせてインラインで書いている
4. **Vercelのmax function制限** — Hobby 12個、Pro 24個。新APIは`api/data.ts`経由で統合するか直接追加判断
5. **Tool result checkは中身を見る** — ツール名だけでは成功判定に不十分

---



## プロジェクト概要

**Finx** — 金融リサーチAIエージェント。ポートフォリオ管理、アラート通知、バックテスト、ペーパートレード、投資叡智ベースのAI分析を提供。

| 項目 | 値 |
|---|---|
| 本番URL | https://finx-psi.vercel.app |
| GitHub | https://github.com/wanifuchi/dexter |
| ブランチ | `main` |
| デフォルトモデル | GPT-5.4 (OpenAI) |
| フレームワーク | Bun + LangChain + Vercel Serverless |
| データストア | Upstash Redis (Tokyo) |
| 通知 | LINE Messaging API |
| CI | GitHub Actions |

## セットアップ

```bash
cd ~/Desktop/claude_base/dexter
bun install
bun test          # テスト
bun run typecheck # 型チェック
vercel --prod     # デプロイ
```

## アーキテクチャ

```
dexter/
├── api/                         # Vercel serverless (8関数、Hobby上限12)
│   ├── chat.ts                  # SSEチャット
│   ├── health.ts                # ヘルスチェック
│   ├── data.ts                  # 統合データAPI (?type=portfolio|dividends|watchlist|snapshots|tax-goals)
│   ├── backtest.ts              # バックテスト実行
│   ├── paper-trade.ts           # ペーパートレード
│   ├── line-webhook.ts          # LINE承認ワークフロー
│   ├── auto-strategy-config.ts  # 自動戦略設定
│   └── cron/index.ts            # 統合Cron (?job=scan-alerts|snapshot|news-alerts|auto-strategy|economic-alerts|weekly-report|earnings-calendar)
├── public/
│   ├── index.html               # Web UI (全ページ)
│   └── manifest.json            # PWA
├── src/
│   ├── agent/
│   │   ├── agent.ts             # エージェントコア
│   │   ├── prompts.ts           # システムプロンプト構築
│   │   └── investment-wisdom.ts # 14人の投資家の叡智ナレッジベース
│   ├── api-handlers/            # Vercel関数から呼ばれるハンドラー群
│   │   ├── portfolio.ts         # ポートフォリオ（RSI/SMA/相関/アトリビューション含む）
│   │   ├── dividends.ts         # 配当データ
│   │   ├── watchlist.ts         # ウォッチリスト
│   │   ├── snapshots.ts         # パフォーマンスチャート用
│   │   ├── scan-alerts.ts       # 株価アラートスキャン
│   │   ├── snapshot.ts          # 日次スナップショット記録
│   │   ├── news-alerts.ts       # ニュースアラート
│   │   ├── auto-strategy.ts     # 自動戦略実行
│   │   ├── economic-alerts.ts   # 経済指標アラート
│   │   ├── weekly-report.ts     # AI週次レポート
│   │   ├── earnings-calendar.ts # 決算日カレンダー
│   │   └── tax-goals.ts         # 税金シミュレーター+目標設定
│   ├── backtest/
│   │   ├── engine.ts            # バックテストエンジン
│   │   ├── registry.ts          # 戦略レジストリ（11戦略）
│   │   └── strategies/          # 各戦略の実装
│   ├── gateway/
│   │   ├── agent-runner.ts      # セッション管理（Redis永続化）
│   │   └── channels/
│   │       └── line/outbound.ts # LINE Messaging API送信
│   ├── tools/
│   │   ├── trading/
│   │   │   ├── types.ts         # ポートフォリオ・アラート型定義
│   │   │   ├── kv-store.ts      # Upstash Redis永続化
│   │   │   ├── portfolio-store.ts
│   │   │   ├── alert-store.ts
│   │   │   ├── watchlist-store.ts
│   │   │   ├── signal-detector.ts  # シグナル検出（Redis cooldown）
│   │   │   ├── trading-tools.ts    # LangChainツール群
│   │   │   ├── learning-engine.ts  # ユーザー適応学習
│   │   │   └── trade-journal.ts    # 取引日記
│   │   ├── finance/             # 米国株ツール
│   │   ├── finance-jp/          # 日本株ツール
│   │   └── registry.ts          # 全ツール登録
│   └── trading/
│       ├── paper-engine.ts      # ペーパートレードエンジン
│       ├── approval-engine.ts   # LINE承認ワークフロー
│       └── types.ts
├── .github/workflows/
│   ├── ci.yml                   # CI（typecheck + test）
│   ├── scan-alerts.yml          # 5分間隔アラート + 自動戦略 + ニュース
│   ├── daily-snapshot.yml       # 日次スナップショット
│   └── daily-tasks.yml          # 経済指標 + 決算日 + 週次レポート
└── vercel.json                  # Vercel設定（rewrites, crons, functions）
```

## 実装済み機能（47機能）

### Phase 1: アラート・通知
1. LINE通知チャネル
2. ポートフォリオ管理（CRUD）
3. アラートルール管理
4. シグナル検出（Redis cooldown付き）
5. 5分間隔Cron（GitHub Actions）
6. Upstash Redis永続化

### Phase 2: 分析・チャート
7. 配当トラッカー（直近12ヶ月実績ベース）
8. パフォーマンスチャート（日次スナップショット）
9. S&P500ベンチマーク比較
10. バックテスト（11戦略）

### Phase 3: ペーパートレード
11. ペーパートレードエンジン（成行/指値）
12. LINE承認ワークフロー
13. 戦略自動実行

### UI機能
14. ダークモード
15. ソート・フィルター
16. テクニカル指標（RSI/50MA）
17. セクター分散分析
18. ウォッチリスト
19. 日本株円建て表示
20. ニュースアラート（LINE）
21. パフォーマンスアトリビューション
22. 相関分析ヒートマップ
23. 配当カレンダー
24. リバランス提案
25. 為替感応度分析
26. 銘柄クリック→チャット分析
27. ポートフォリオ自動更新（60秒）
28. 配当再投資シミュレーション（DRIP戦略）
29. 会話コンテキスト保持（Redis + localStorage sessionId）
30. TOPボタン・ロゴクリック
31. サブタブ分割（ポジション/分析/配当/管理）
32. 折りたたみセクション
33. ツールチップ
34. 損益カラー段階化
35. 税金シミュレーター
36. 目標進捗バー
37. 経済指標アラート（FOMC/CPI/雇用統計）
38. AI週次レポート
39. 銘柄比較（チャットサジェスション）
40. 配当スクリーナー
41. 決算日カレンダー+LINE通知
42. ポジション編集UI
43. モバイルPWA
44. AIスクリーニング
45. 取引日記
46. ミニチャート（インラインスパークライン）
47. 通知設定画面

### 成長する仕組み
- 投資叡智ナレッジベース（14人の偉大な投資家の原則）
- ユーザー適応学習エンジン（フィードバック/好み/教訓をRedisに蓄積）
- シナリオ分析フレームワーク（金利/景気/インフレ/地政学）
- スクリーニング基準テンプレート（高配当/バフェット/CANSLIM/GARP/バリュー/税効率）

### バックテスト戦略（11種）
1. バイ&ホールド
2. ドルコスト平均法
3. モメンタムリバランス
4. ミーンリバージョン（RSI逆張り）
5. ゴールデンクロス
6. ブレイクアウト（タートルズ）
7. ボリンジャーバンド反発
8. デュアルモメンタム
9. ボラティリティ・ブレイクアウト
10. ATRトレーリングストップ
11. 配当再投資（DRIP）

## 外部サービス設定

### Vercel環境変数
```
OPENAI_API_KEY, EDINETDB_API_KEY, JQUANTS_API_KEY,
FINANCIAL_DATASETS_API_KEY, FINNHUB_API_KEY, FMP_API_KEY,
POLYGON_API_KEY, TWELVE_DATA_API_KEY, ALPHA_VANTAGE_API_KEY,
TAVILY_API_KEY, GOOGLE_API_KEY,
LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID,
CRON_SECRET,
UPSTASH_REDIS_KV_REST_API_URL, UPSTASH_REDIS_KV_REST_API_TOKEN
```

### GitHub Secrets
```
FINX_URL=https://finx-psi.vercel.app
CRON_SECRET=（Vercelと同じ値）
```

### Upstash Redis キー一覧
```
finx:portfolio          — ポートフォリオ（13ポジション）
finx:alert-rules        — アラートルール（20ルール）
finx:watchlist           — ウォッチリスト
finx:snapshots           — 日次スナップショット（最大365日）
finx:paper-account       — ペーパートレード口座
finx:approvals           — LINE承認待ちキュー
finx:auto-strategy       — 自動戦略設定
finx:goals               — 目標設定（資産/配当）
finx:learning            — ユーザー学習データ
finx:journal             — 取引日記
finx:session:*           — チャットセッション履歴
finx:cooldown:*          — アラートクールダウン（TTL 24h）
```

## Vercel Hobbyプラン制約
- Serverless Functions上限: **12個**（現在8個使用）
- Cron Jobs: **1日1回**のみ（5分間隔はGitHub Actionsで代替）
- 新しいAPIを追加する場合は `api/data.ts` か `api/cron/index.ts` に統合すること

## 既知の課題

- [ ] EDINET名前検索の精度（証券コード直指定なら問題なし）
- [ ] Yahoo Finance v10 API (summaryDetail) が401を返す場合がある
- [ ] `src/web/public/index.html` と `public/index.html` が二重管理（変更時は `cp` で同期）
- [ ] LINE Webhook URL未設定（LINE Developersコンソールで `https://finx-psi.vercel.app/api/line-webhook` を設定すれば承認ワークフローが動く）
- [ ] パフォーマンスチャートはデータ蓄積中（2日以上で表示開始）

## セキュリティレビュー（2026-04-03 Codex指摘）

### 対応済み
- [x] **XSSサニタイズ** — `renderMarkdown()`にHTMLエスケープ追加。innerHTML注入を防止（`6a2d6ff`）
- [x] **earnings-calendar rewrite** — vercel.jsonに追加。今まで404だったcronジョブが正常動作するように（`6a2d6ff`）

### 未対応（URL非公開の個人利用のため保留）
- [ ] **API認証なし（High）** — `/api/data`, `/api/paper-trade`, `/api/auto-strategy-config` が `CORS: *` で認証なし。Basic認証 or Bearerトークン追加で対応可能だが、フロント・GitHub Actions cron・Vercel環境変数の同時変更が必要。公開や他人共有する前には必須
- [ ] **LINE webhook署名検証なし（High）** — `x-line-signature`未検証。webhook URLを知っていれば偽POSTで承認フローを操作可能。`@line/bot-sdk`の`validateSignature`で対応。`LINE_CHANNEL_SECRET`環境変数が必要
- [ ] **承認フローuserId未使用（Medium）** — `event.source.userId`を取得しているが使っていない。マルチユーザー化する際に対応必要。single-userなら署名検証でカバー可能

## ロードマップ

### 直近（自分で使い倒す期間 〜2026年6月）
- UIの使い勝手改善（使っていて不便を感じたら随時修正）
- アラート精度の改善（誤検知/見逃しの調整）
- 学習エンジンのデータ蓄積

### 中期
- ヘルプドキュメント生成（Playwrightスクショ+マークダウン、UI安定後）
- 知人に配布してフィードバック収集

### 長期
- SaaS化（認証: NextAuth/Clerk、マルチテナント、Stripe課金）
- Phase 4: ライブトレード（auカブコムAPI）
- モバイル最適化

## 運用ルール

- **こまめにコミット・push** — VSCodeクラッシュで未保存の変更が失われた教訓
- UI変更時は `cp public/index.html src/web/public/index.html` で同期
- デプロイは `vercel --prod`
- 新しいAPIハンドラーは `src/api-handlers/` に配置し `api/data.ts` or `api/cron/index.ts` から呼ぶ（Hobby上限12回避）
- 通知はLINEのみ（WhatsAppは使わない）
