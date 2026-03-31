# Finx 開発メモ — 次回再開用

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
