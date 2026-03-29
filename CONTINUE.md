# Finx 開発メモ — 次回再開用

## プロジェクト概要

**Finx** = dexter (金融リサーチAIエージェント) のWeb版。ブラウザから日本株・米国株の分析ができる。

| 項目 | 値 |
|---|---|
| 本番URL | https://finx-psi.vercel.app |
| GitHub | https://github.com/wanifuchi/dexter |
| ブランチ | `main` |
| デフォルトモデル | GPT-5.4 (OpenAI) |
| フレームワーク | Bun + LangChain + Vercel Serverless |

## セットアップ

```bash
cd ~/Desktop/claude_base/dexter
bun install
```

### ローカル起動

```bash
# TUI (ターミナル対話)
bun run start

# Webサーバー (http://localhost:3456)
bun run web

# テスト
bun test

# 型チェック
bun run typecheck
```

### デプロイ

```bash
vercel --prod
```

環境変数はVercelダッシュボードで管理済み。`.env` のキーを変更した場合は `vercel env add <KEY> production` で同期。

## アーキテクチャ

```
dexter/
├── api/                    # Vercel serverless functions
│   ├── chat.ts             # SSEストリーミング (/api/chat)
│   └── health.ts           # ヘルスチェック (/api/health)
├── public/
│   └── index.html          # Finx Web UI (Warm Stone配色)
├── src/
│   ├── agent/              # エージェントコア (ループ、プロンプト)
│   ├── gateway/            # agent-runner、セッション管理
│   ├── model/              # LLM呼び出し抽象層
│   ├── tools/
│   │   ├── finance/        # 米国株ツール (Yahoo, Finnhub, FMP, Polygon等)
│   │   ├── finance-jp/     # 日本株ツール (EDINET DB, J-Quants, Yahoo JP)
│   │   └── registry.ts     # 全ツール登録・条件分岐
│   ├── web/
│   │   ├── server.ts       # Bun用ローカルWebサーバー
│   │   └── public/         # ローカル用UI (public/と同期)
│   └── utils/
│       └── paths.ts        # .dexterディレクトリ (Vercelは/tmp)
├── vercel.json             # Vercel設定
└── .env                    # APIキー (.gitignore済み)
```

## APIキー一覧 (.env)

| キー | 用途 | 必須 |
|---|---|---|
| OPENAI_API_KEY | GPT-5.4 (メインLLM) | 必須 |
| EDINETDB_API_KEY | 日本株財務・企業情報 | 日本株に必須 |
| JQUANTS_API_KEY | 日本株価(東証公式、履歴用) | あると良い |
| FINANCIAL_DATASETS_API_KEY | 米国株財務 | 必須 |
| FINNHUB_API_KEY | アナリスト評価・ニュース | あると良い |
| FMP_API_KEY | 米国株スクリーナー | あると良い |
| POLYGON_API_KEY | 米国株価 | あると良い |
| TWELVE_DATA_API_KEY | テクニカル指標 | あると良い |
| ALPHA_VANTAGE_API_KEY | 米国株価 | あると良い |
| TAVILY_API_KEY | Web検索 | あると良い |

## 2026-03-29 実施した作業

### git復旧
- VSCodeクラッシュで `.git` 破損。リモートから再クローンして復旧
- 未コミットだった変更をバックアップ→復元

### 米国株ツール追加 (2519982)
- `finance/yahoo-finance.ts` — Yahoo Finance (APIキー不要、ETF/ADR対応)
- `finance/alpha-vantage.ts` — Alpha Vantage
- `finance/finnhub.ts` — Finnhub (アナリスト評価、ニュース)
- `finance/twelve-data.ts` — Twelve Data (テクニカル)
- `finance/fmp.ts` — Financial Modeling Prep (スクリーナー)
- `finance/polygon.ts` — Polygon.io

### 日本株ツール追加 (e5e450e)
- `finance-jp/edinetdb-api.ts` — EDINET DB APIクライアント
- `finance-jp/edinetdb-tools.ts` — 財務、企業情報、AI分析、決算短信、有報、大量保有
- `finance-jp/jquants-tools.ts` — J-Quants株価 + Yahoo Financeリアルタイム
- `finance-jp/screener-jp.ts` — LLM駆動の日本株スクリーナー

### Vercelデプロイ (004a625〜b9f00d3)
- `api/chat.ts` — SSEストリーミングサーバレス関数
- `api/health.ts` — ヘルスチェック
- `@/` パスエイリアスを相対importに変換 (Vercel互換)
- `.dexter` ディレクトリを `/tmp` に (Vercel読み取り専用FS対応)
- 環境変数をVercelに設定済み

### UI (240b19f, 35b4942)
- Warm Stone配色 (ベージュ+ブロンズ)
- チャット履歴ページ (localStorage、最大100件)
- Shift+Enter送信、Enter改行
- 推定APIコスト表示
- AI感を排除したデザイン

### 日本株リアルタイム株価修正 (a2d9226)
- J-Quants無料プランは数ヶ月遅延 → 最新価格をYahoo Finance (.T形式) で取得
- 履歴データのみJ-Quantsを使用

## 既知の課題・TODO

- [ ] EDINET名前検索の精度（「トヨタ」→トヨタ紡織に行く場合あり。証券コード直指定なら問題なし）
- [ ] Yahoo Finance v10 API (summaryDetail) が401を返す場合がある
- [ ] Finnhub Price Target APIが無料プランで403
- [ ] `src/web/public/index.html` と `public/index.html` が二重管理（変更時は両方更新必要）
- [ ] Vercelでのセッション永続化なし（リクエスト間でチャット履歴は消える）
- [ ] `dexter_broken` ディレクトリが残っている（不要なら `rm -rf ~/Desktop/claude_base/dexter_broken`）

## 運用ルール

- **こまめにコミット・push** — VSCodeクラッシュで未保存の変更が失われた教訓
- UI変更時は `public/index.html` と `src/web/public/index.html` の両方を更新
- デプロイは `vercel --prod`
- `.env` は `.gitignore` 済み、Vercel環境変数と手動同期
