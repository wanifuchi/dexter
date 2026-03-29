# CLAUDE.md — Claude Code向け開発ガイド

## プロジェクト

Finx (旧dexter) — 金融リサーチAIエージェント。日本株・米国株に対応。

## コマンド

- `bun install` — 依存関係インストール
- `bun run start` — TUI起動
- `bun run web` — Webサーバー (localhost:3456)
- `bun test` — テスト実行
- `bun run typecheck` — TypeScriptチェック
- `vercel --prod` — 本番デプロイ

## 重要ルール

- **こまめにcommit & pushすること**（VSCodeクラッシュで失う教訓あり）
- UI変更は `public/index.html` と `src/web/public/index.html` の両方を更新
- `@/` パスエイリアスは使わない（Vercel非互換。相対importを使う）
- Vercel環境では `process.env.VERCEL` で判定、.dexterディレクトリは `/tmp` を使う
- `.env` はgitに含めない。Vercel環境変数と手動同期

## ファイル構造の要点

- `api/` — Vercel serverless functions
- `public/` — Vercel用静的ファイル
- `src/tools/finance/` — 米国株ツール
- `src/tools/finance-jp/` — 日本株ツール
- `src/tools/registry.ts` — 全ツール登録
- 日本株の最新価格はYahoo Finance (.T形式)、履歴はJ-Quants
