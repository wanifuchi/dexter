# ポートフォリオページ認証 仕様書

## 1. 目的

Finx の Web UI にある `ポートフォリオ` ページを、未認証ユーザーから保護する。

今回の対象は「アプリ全体の会員認証」ではなく、単一管理者が使うポートフォリオ機能だけを軽量に保護すること。

必須ゴールは次の 3 つ。

1. `ポートフォリオ` ページを開く前に認証を要求する
2. ポートフォリオ関連 API を未認証では読めない/更新できないようにする
3. Vercel 上でも動く、依存の少ない実装にする

## 2. 背景と現状

現状、ポートフォリオ画面はフロントからそのまま API を叩いている。

- 画面: [public/index.html](/Users/noriaki/Desktop/claude_base/dexter/public/index.html)
- 同期元: [src/web/public/index.html](/Users/noriaki/Desktop/claude_base/dexter/src/web/public/index.html)
- API 集約: [api/data.ts](/Users/noriaki/Desktop/claude_base/dexter/api/data.ts)
- ポートフォリオ取得: [src/api-handlers/portfolio.ts](/Users/noriaki/Desktop/claude_base/dexter/src/api-handlers/portfolio.ts)
- 株数更新: [src/api-handlers/update-shares.ts](/Users/noriaki/Desktop/claude_base/dexter/src/api-handlers/update-shares.ts)

### 2.1 現状の問題

1. `ポートフォリオ` ページに認証がない
2. `/api/portfolio` `/api/dividends` `/api/watchlist` `/api/tax-goals` などが未認証で読める
3. 株数更新の `POST /api/portfolio` も未認証で実行できる
4. ポジション追加 UI は `/api/chat` に自然言語で登録依頼を送っており、ポートフォリオ専用認証の境界が曖昧

## 3. 非ゴール

- Google / GitHub / Clerk / Supabase などの外部認証導入
- マルチユーザーアカウント管理
- 権限ロール設計
- チャット全体の認証必須化

## 4. 採用方針

### 4.1 MVP 方針

単一管理者向けの `パスコード認証 + HttpOnly の署名付き Cookie` を採用する。

理由:

- 既存構成に最小差分で入れられる
- Vercel でそのまま動く
- DB や Redis に auth session を持たずに済む
- ポートフォリオ専用保護に十分

### 4.2 採用しない案

- Basic Auth
  - ブラウザ UX が悪く、ページ単位制御もしづらい
- フロントだけのパスワード入力
  - API 保護にならない
- SQLite / Redis に auth session を保存
  - 今回の要件に対して重い

## 5. 認証モデル

### 5.1 認証情報

環境変数:

- `PORTFOLIO_AUTH_PASSWORD`
  - 必須
  - ポートフォリオページのログインに使う単一パスコード
- `PORTFOLIO_AUTH_COOKIE_SECRET`
  - 必須
  - Cookie 署名用 secret
  - 32 bytes 以上を想定
- `PORTFOLIO_AUTH_COOKIE_NAME`
  - 任意
  - 既定値: `finx_portfolio_auth`
- `PORTFOLIO_AUTH_TTL_DAYS`
  - 任意
  - 既定値: `7`

### 5.2 Cookie

Cookie 属性:

- `HttpOnly`
- `Secure` 本番時必須
- `SameSite=Lax`
- `Path=/`
- `Max-Age` は TTL に従う

Cookie の中身は stateless token とする。

推奨 payload:

```json
{
  "v": 1,
  "exp": 1760000000
}
```

これを base64url 化し、`HMAC-SHA256` 署名を付与する。

形式例:

```text
base64url(payload).base64url(signature)
```

### 5.3 検証

サーバー側では毎回以下を行う。

1. Cookie を取得
2. 形式検証
3. 署名検証
4. 有効期限検証
5. 通過時のみ portfolio protected API を処理

失敗時は `401 Unauthorized` を返す。

## 6. 保護対象

### 6.1 画面

`ポートフォリオ` ページ自体をロックする。

期待挙動:

1. ユーザーが `ポートフォリオ` タブを押す
2. 未認証ならポートフォリオ本体は表示せず、ログインフォームを表示
3. 認証成功後に初めて portfolio data を fetch する

### 6.2 API

MVP で保護する API:

- `GET /api/portfolio`
- `POST /api/portfolio`
- `GET /api/dividends`
- `GET /api/watchlist`
- `GET /api/tax-goals`
- 必要なら `GET /api/snapshots`

実装上は [api/data.ts](/Users/noriaki/Desktop/claude_base/dexter/api/data.ts) で `type` ごとに認証ガードを差し込むのが最小。

### 6.3 ポートフォリオ更新経路

現状の `addPositionUI()` は `/api/chat` に自然言語で登録依頼を投げている。

これはポートフォリオ専用認証の境界として不適切なので、MVP で次の変更を入れる。

1. ポートフォリオ追加/更新は専用 API に寄せる
2. `POST /api/portfolio` を拡張して追加・更新・削除を処理する
3. `public/index.html` 側の `addPositionUI()` は `/api/chat` ではなく `/api/portfolio` を呼ぶ

これにより、ポートフォリオの読み書きをすべて portfolio auth の中に閉じ込める。

## 7. API 仕様

### 7.1 新規 API

`/api/portfolio-auth`

#### `GET /api/portfolio-auth`

用途:

- 認証状態確認

レスポンス例:

```json
{ "authenticated": true }
```

または

```json
{ "authenticated": false }
```

#### `POST /api/portfolio-auth`

用途:

- ログイン

リクエスト例:

```json
{ "password": "..." }
```

成功時:

- 認証 Cookie を `Set-Cookie`
- `200 { authenticated: true }`

失敗時:

- `401 { error: "Unauthorized" }`

#### `DELETE /api/portfolio-auth`

用途:

- ログアウト

動作:

- Cookie を失効
- `200 { ok: true }`

### 7.2 既存 API の変更

#### [api/data.ts](/Users/noriaki/Desktop/claude_base/dexter/api/data.ts)

`type` が以下のとき認証必須:

- `portfolio`
- `dividends`
- `watchlist`
- `tax-goals`
- `snapshots`（必要なら）

認証失敗時レスポンス:

```json
{ "error": "Unauthorized" }
```

HTTP status は `401`

#### `POST /api/portfolio`

MVP では次の payload を受けられるようにする。

```json
{
  "ticker": "NVDA",
  "name": "NVIDIA",
  "shares": 100,
  "avgCost": 120.5,
  "account": "rakuten-tokutei"
}
```

ルール:

- 既存銘柄があれば更新
- なければ追加
- `shares === 0` は削除扱いでもよい

## 8. フロントエンド仕様

対象:

- [public/index.html](/Users/noriaki/Desktop/claude_base/dexter/public/index.html)
- [src/web/public/index.html](/Users/noriaki/Desktop/claude_base/dexter/src/web/public/index.html)

### 8.1 UI 要件

ポートフォリオページに未認証時のロック状態を追加する。

表示要素:

- タイトル: `ポートフォリオ認証`
- パスコード入力欄
- `ログイン` ボタン
- エラーメッセージ領域
- 認証後は `ログアウト` ボタン

### 8.2 フロー

#### 初回表示

1. `showPage('portfolio')`
2. 先に `GET /api/portfolio-auth`
3. 未認証ならロック UI 表示
4. 認証済みなら `loadPortfolioPage()` 実行

#### ログイン

1. パスコード送信
2. `POST /api/portfolio-auth`
3. 成功時はロック UI を閉じて `loadPortfolioPage()`

#### API 401

portfolio 系 fetch が 401 を返したら:

1. ローカルの認証状態フラグを false にする
2. ポートフォリオ本体を隠す
3. ロック UI を再表示する

#### ログアウト

1. `DELETE /api/portfolio-auth`
2. ポートフォリオ表示をクリア
3. ロック UI に戻す

### 8.3 ローカル保存

`localStorage` に保存してよいのは UI 状態だけ。

例:

- `finx_portfolio_auth_hint = "authenticated"` のような補助フラグ

ただし source of truth は必ず cookie + server verification とする。

パスコード本体は絶対に `localStorage` に保存しない。

## 9. サーバー実装方針

### 9.1 新規ユーティリティ

推奨追加ファイル:

- `src/web/auth/portfolio-auth.ts`
  - Cookie parse
  - token sign
  - token verify
  - login/logout helper
- `api/portfolio-auth.ts`
  - status/login/logout handler

### 9.2 実装ルール

1. `node:crypto` の `createHmac` を使う
2. 比較は `timingSafeEqual` を使う
3. Cookie 生成/破棄は helper に寄せる
4. 認証判定ロジックを `api/data.ts` から再利用できるようにする

## 10. エラー仕様

### 10.1 API

- 未認証: `401`
- 壊れた Cookie: `401`
- 期限切れ Cookie: `401`
- パスコード不一致: `401`
- サーバー内部エラー: `500`

### 10.2 UI

ログイン失敗時:

- `パスコードが正しくありません`

期限切れ時:

- `認証の有効期限が切れました。再ログインしてください`

## 11. セキュリティ要件

1. パスコードはサーバー環境変数のみ
2. 平文パスコードをクライアント保存しない
3. Cookie は `HttpOnly`
4. 本番では `Secure`
5. 署名 secret とパスコードは別変数にする
6. 自然言語の `/api/chat` 経由でポートフォリオ変更させない

## 12. 受け入れ条件

### AC-1

未認証で `ポートフォリオ` タブを押しても、保有銘柄一覧や損益が表示されない。

### AC-2

正しいパスコードでログインすると、そのまま `ポートフォリオ` ページが表示される。

### AC-3

未認証で `GET /api/portfolio` を叩くと `401` を返す。

### AC-4

未認証で `POST /api/portfolio` を叩くと `401` を返す。

### AC-5

認証済み cookie がある間は、ページ再読込後もポートフォリオを開ける。

### AC-6

ログアウト後は `ポートフォリオ` ページが再びロックされる。

### AC-7

`addPositionUI()` 相当の追加操作が `/api/chat` ではなく portfolio protected API を通る。

### AC-8

[public/index.html](/Users/noriaki/Desktop/claude_base/dexter/public/index.html) と [src/web/public/index.html](/Users/noriaki/Desktop/claude_base/dexter/src/web/public/index.html) の実装が同期している。

## 13. テスト方針

最低限ほしいテスト:

1. token sign / verify のユニットテスト
2. 期限切れ token が弾かれるテスト
3. 壊れた署名が弾かれるテスト
4. `api/portfolio-auth` の login/status/logout テスト
5. `api/data.ts` が protected type で `401` を返すテスト
6. 認証済み時は `portfolio` `dividends` `watchlist` `tax-goals` が通るテスト
7. `POST /api/portfolio` の追加/更新/削除テスト

## 14. 段階実装

### Phase 1

- portfolio auth helper
- `/api/portfolio-auth`
- `api/data.ts` のガード
- ポートフォリオページのロック UI

### Phase 2

- `addPositionUI()` を `/api/chat` から切り離し
- `POST /api/portfolio` を追加/更新兼用へ拡張

Phase 1 だけでも「閲覧保護」は成立する。  
Phase 2 まで入れると「変更経路の認証境界」まで綺麗に閉じる。
