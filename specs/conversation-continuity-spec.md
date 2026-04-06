# 会話継続性改善 仕様書

## 1. 目的

Finx のチャットで、次のような短い追撃メッセージでも会話が自然に続くようにする。

- `続けて`
- `そのまま`
- `1,2を具体的に出して`
- `両方`
- `それで進めて`
- `今日売るならいくら？`

特に、直前の回答で提示した「次にできること」を、次ターンで確実に引き継げることを最優先とする。

## 2. 背景と現状の問題

### 2.1 現状の会話保持は「短期セッション」と「長期記憶」で分断されている

- 短期セッション履歴は [`src/gateway/agent-runner.ts`](/Users/noriaki/Desktop/claude_base/dexter/src/gateway/agent-runner.ts) で `InMemoryChatHistory` を Redis/ファイルへ保存している。
- ただし `memory_search` が参照する過去会話は [`src/memory/store.ts`](/Users/noriaki/Desktop/claude_base/dexter/src/memory/store.ts) の `.dexter/messages/chat_history.json` 前提になっている。
- Web チャットはこの `chat_history.json` に書き込んでおらず、CLI 側だけが [`src/utils/long-term-chat-history.ts`](/Users/noriaki/Desktop/claude_base/dexter/src/utils/long-term-chat-history.ts) を経由して保存している。

結果:

- Web で何ターン会話しても `memory_search` が空になりやすい。
- 個人化アドバイス前に `memory_search` を呼んでも、直前までの会話が拾えない。

### 2.2 「続けて」解決がプロンプト依存で不安定

- [`src/agent/prompts.ts`](/Users/noriaki/Desktop/claude_base/dexter/src/agent/prompts.ts) には「`続けて` なら前の提案を実行せよ」というルールがある。
- しかし実装上は、追撃メッセージをアプリケーション層で解決していない。
- そのため、モデルが前ターンの候補番号 `1` `2` を取り違えたり、「何を指すか不明」と返すことがある。

結果:

- `1,2を具体的に出して` に対して「1,2が前提会話依存なので特定できません」のような破綻が起きる。

### 2.3 Web の「履歴」は会話スレッドを復元していない

- [`public/index.html`](/Users/noriaki/Desktop/claude_base/dexter/public/index.html) の履歴は `localStorage.finx_history` に Q/A スナップショットを保存しているだけ。
- 履歴クリック時も、そのスナップショットを描画するだけで、対応する `sessionId` を再開していない。
- `newConversation()` は `sessionId` を作り直すが、履歴側は会話スレッドという概念を持っていない。

結果:

- ユーザー視点では「履歴はあるのに、その続きを話せない」状態になる。

### 2.4 メモリ索引対象のパス設計も不整合

- [`src/memory/indexer.ts`](/Users/noriaki/Desktop/claude_base/dexter/src/memory/indexer.ts) の内部定数は `sessions/chat_history.json` を使う。
- 一方で実際に読むのは [`src/memory/store.ts`](/Users/noriaki/Desktop/claude_base/dexter/src/memory/store.ts) の `messages/chat_history.json`。

結果:

- 実害は限定的でも、開発者が誤解しやすく、会話記憶の実装経路が読みづらい。

## 3. ゴール

### 3.1 必須ゴール

1. 同一スレッド内の短い追撃メッセージを、アプリケーション層で安定して解決できること。
2. Web チャットの会話内容が、`memory_search` から検索可能になること。
3. 履歴一覧から任意の会話スレッドを開き、そのまま続きを送れること。
4. ページ再読み込み、Vercel cold start、別リクエストでも会話が継続すること。

### 3.2 非ゴール

- 投資判断ロジック自体の改善
- 新しい認証機能の追加
- マルチユーザー権限設計の全面刷新
- プロンプト文言だけでの対処

## 4. プロダクト要求

### FR-1: `sessionId` を「会話スレッドID」として正式採用する

- Web の `sessionId` を単なる内部IDではなく、会話スレッドの canonical ID とする。
- API・Redis・UI で用語を `threadId` 相当に統一してよいが、既存互換のため `sessionId` 入力は維持する。
- 1 スレッド = 連続した会話コンテキスト。
- `新しい会話` を押した時だけ新しいスレッドを作る。

### FR-2: 完了ターンを必ず永続会話ストアへ保存する

各ターンで以下を保存すること。

- `threadId`
- `turnId`
- `timestamp`
- `userMessage`
- `resolvedUserMessage`（後述の follow-up 解決後の実クエリ）
- `assistantMessage`
- `assistantSummary`
- `offeredNextActions`
- `toolUsageSummary`

保存先要件:

- 本番は Redis を正とする
- ローカル開発はファイルフォールバックを許容する
- Vercel cold start 後も復元できること

### FR-3: Follow-up Resolver をアプリケーション層に追加する

モデル任せではなく、エージェント起動前に短い追撃メッセージを解決する。

#### 追撃判定条件

次のいずれかを満たす場合、follow-up 解決を実行する。

- 文字数が短い
- `続けて`, `そのまま`, `両方`, `1`, `2`, `1,2`, `go ahead`, `do it`, `yes` 等の既知パターン
- 指示対象を省略した日本語照応表現
  - `それ`
  - `これ`
  - `じゃあそれ`
  - `それで`
  - `具体的に`

#### 解決ルール

1. 直前の assistant turn に `offeredNextActions` がある場合
   - `1` → 1番を実行
   - `2` → 2番を実行
   - `1,2` / `両方` → 両方実行
   - `続けて` / `そのまま` → 直前に提示した全候補を実行
2. `offeredNextActions` がない場合
   - 直近 3〜6 ターンを見て、照応先を 1 つに解決
3. 高信頼で解決できない場合のみ、1回だけ狭い確認質問を返す
   - 悪い例: `何を？`
   - 良い例: `直前の提案は「売却案」と「買い候補」でした。どちらを先に出しますか？`

#### resolved query の例

元の入力:

```text
1,2を具体的に出して
```

解決後:

```text
前の回答で提案した 1. 銘柄ごとの売り・保有・縮小の3分類 と 2. どれを何株くらい減らすとバランスが良くなるか を、現在の保有銘柄前提で具体的に出して。
```

### FR-4: `offeredNextActions` を構造化保存する

Assistant が次アクションを提示した場合、その候補を turn metadata として構造化保存する。

例:

```json
{
  "offeredNextActions": [
    {
      "key": "1",
      "label": "SOXL vs SOXX の比較",
      "instruction": "SOXL と SOXX の比較を出す"
    },
    {
      "key": "2",
      "label": "今の価格帯でのエントリー戦略",
      "instruction": "今の価格帯でのエントリー戦略を出す"
    }
  ]
}
```

抽出手段は実装者判断でよいが、要件は以下。

- 箇条書き番号付き候補を抽出できること
- `必要なら次に...` `続けるなら...` `次にすぐ...` などの文脈を拾えること
- 抽出失敗時でも既存回答は壊さないこと

### FR-5: `memory_search` で Web 会話を拾えるようにする

以下のいずれかで実装すること。

#### 推奨案

- Memory indexer に「会話スレッドプロバイダ」を追加する
- Redis 上の永続会話ストアを読み、検索可能な transcript chunk に変換する

#### 代替案

- 永続会話ストア更新時に `.dexter/messages/chat_history.json` を canonical に保つ
- ただし本番が serverless のため、Redis 正を崩さないこと

#### 必須条件

- Web の会話も CLI の会話も同じ検索面に載ること
- `memory_search` の結果に `threadId` か等価情報を含めること
- 直近完了ターンは次ターンの検索対象に入っていること

### FR-6: 履歴画面は「Q/A一覧」ではなく「スレッド一覧」にする

履歴 1 件が意味するもの:

- 現状: 単発の過去 Q/A
- 新仕様: 再開可能な会話スレッド

必要な UI 挙動:

1. 履歴一覧は `threadId` ごとの最新サマリを表示
2. 履歴クリックでそのスレッドを開く
3. 開いたら `sessionId` をその `threadId` に切り替える
4. 次の送信はそのスレッドへ継続される
5. `新しい会話` は空スレッドを作成して切り替える

### FR-7: 既存互換性を維持する

- `/api/chat` の既存 payload は壊さない
- `sessionId` が来たらそのまま使う
- `sessionId` が未指定なら従来通りデフォルト生成
- CLI・LINE・WhatsApp の既存ルートは壊さない

## 5. 推奨アーキテクチャ

## 5.1 新規コンポーネント

### A. ConversationThreadStore

責務:

- スレッドメタ情報の保存
- ターン列の保存
- スレッド一覧取得
- 単一スレッド復元

推奨キー:

- `finx:thread:{threadId}:meta`
- `finx:thread:{threadId}:turns`
- `finx:thread:index`

### B. FollowUpResolver

責務:

- 追撃メッセージ判定
- `offeredNextActions` 解決
- `resolvedUserMessage` 生成
- 低信頼時の確認文生成

### C. ConversationTranscriptIndexer

責務:

- 永続会話ストアから transcript を読み出す
- memory search 用 chunk に変換する
- source を `sessions` または `conversations` として保存する

## 5.2 既存コードへの接続点

### サーバー側

- [`api/chat.ts`](/Users/noriaki/Desktop/claude_base/dexter/api/chat.ts)
  - `sessionId` を canonical threadId として扱う
  - `resolvedUserMessage` をレスポンスイベントに含められるようにする

- [`src/gateway/agent-runner.ts`](/Users/noriaki/Desktop/claude_base/dexter/src/gateway/agent-runner.ts)
  - 既存の `InMemoryChatHistory` 永続化は維持
  - 完了ターンを ConversationThreadStore にも保存
  - 復元時は transcript も読めるようにする

- [`src/utils/in-memory-chat-history.ts`](/Users/noriaki/Desktop/claude_base/dexter/src/utils/in-memory-chat-history.ts)
  - `assistantSummary` は既存流用可能
  - `offeredNextActions` を持てるよう拡張する

### メモリ側

- [`src/memory/index.ts`](/Users/noriaki/Desktop/claude_base/dexter/src/memory/index.ts)
- [`src/memory/indexer.ts`](/Users/noriaki/Desktop/claude_base/dexter/src/memory/indexer.ts)
- [`src/memory/session-files.ts`](/Users/noriaki/Desktop/claude_base/dexter/src/memory/session-files.ts)

必要変更:

- file ベース専用の transcript 取り込みをやめ、thread store 経由でも取り込めるようにする
- `sessions/chat_history.json` と `messages/chat_history.json` の命名不整合を解消する

### フロント側

- [`public/index.html`](/Users/noriaki/Desktop/claude_base/dexter/public/index.html)
- [`src/web/public/index.html`](/Users/noriaki/Desktop/claude_base/dexter/src/web/public/index.html)

必要変更:

- `finx_history` の単発 Q/A 保存を、thread list キャッシュへ置き換える
- `loadHistory(id)` を `openThread(threadId)` に置き換える
- UI 上で現在スレッドを明示する

## 6. データモデル

### 6.1 ThreadMeta

```ts
type ThreadMeta = {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  lastUserMessage: string;
  lastAssistantPreview: string;
};
```

### 6.2 ConversationTurn

```ts
type OfferedNextAction = {
  key: string;
  label: string;
  instruction: string;
};

type ConversationTurn = {
  turnId: string;
  threadId: string;
  timestamp: string;
  userMessage: string;
  resolvedUserMessage?: string;
  assistantMessage: string;
  assistantSummary?: string;
  offeredNextActions?: OfferedNextAction[];
  toolUsageSummary?: {
    tools: string[];
    totalCalls: number;
  };
};
```

### 6.3 Follow-up 解決結果

```ts
type FollowUpResolution = {
  wasResolved: boolean;
  originalQuery: string;
  resolvedQuery: string;
  reason:
    | 'direct'
    | 'short_follow_up'
    | 'numbered_action'
    | 'all_actions'
    | 'coreference';
  confidence: number;
  matchedTurnId?: string;
  matchedActionKeys?: string[];
};
```

## 7. API 仕様

## 7.1 `/api/chat`

### Request

現行互換:

```json
{
  "query": "続けて",
  "sessionId": "web-abc123"
}
```

### サーバー内部フロー

1. `sessionId` から thread を復元
2. FollowUpResolver 実行
3. `resolvedQuery` を agent に渡す
4. 完了後、turn を thread store に保存
5. SSE で `resolved_query` イベントを任意送出

### SSE 任意イベント

```json
event: resolved_query
data: {
  "originalQuery": "1,2を具体的に出して",
  "resolvedQuery": "前の回答で提案した 1 ... 2 ... を具体的に出して",
  "reason": "numbered_action"
}
```

このイベントは UI 表示用であり、未対応クライアントでも無視してよい。

## 7.2 新規 API

### `GET /api/conversations`

返却:

- 最近の thread 一覧
- `updatedAt` 降順

### `GET /api/conversations/:threadId`

返却:

- thread meta
- 全 turn

### `POST /api/conversations`

返却:

- 新しい `threadId`

備考:

- 最小実装では API を増やさず、`/api/chat` と local cache だけでもよい
- ただし履歴画面を本当に直すなら API 化を推奨する

## 8. 実装方針

### Phase 1: 壊れやすい点の解消

1. FollowUpResolver を追加
2. 完了ターンを thread store に保存
3. Web 会話を memory search 対象に入れる
4. 履歴アイテムに `threadId` を持たせる

完了条件:

- `続けて`
- `1,2`
- `両方`

が再現性高く通る

### Phase 2: 履歴 UX をスレッド化

1. 履歴一覧を thread list に変更
2. thread reopen API 追加
3. 現在スレッド表示

### Phase 3: 品質強化

1. offeredNextActions の抽出精度改善
2. metrics / debug logging 追加
3. transcript index の増分同期最適化

## 9. 受け入れ条件

### AC-1: 直前候補番号の解決

前提:

- assistant が `必要なら次に 1. 売り・保有・縮小の3分類 2. 何株減らすか を出します` と返す

期待結果:

- user が `1,2を具体的に出して` と送る
- assistant は確認質問せず、両方を具体化して返す

### AC-2: `続けて` が前提を失わない

前提:

- 3ターン以上の会話後
- page reload を挟む

期待結果:

- `続けて` で直前提案の続きを返す
- `前の流れが見えていません` と言わない

### AC-3: personalized advice 前の memory recall

前提:

- Web でポートフォリオとリスク許容度を会話済み

期待結果:

- 次の売買助言ターンで `memory_search` が Web 会話をヒットする
- 空結果で generic advice に落ちにくい

### AC-4: 履歴再開

前提:

- thread A と thread B がある

期待結果:

- 履歴から thread A を開く
- 次メッセージは thread A に接続される
- thread B の文脈は混ざらない

### AC-5: cold start 耐性

前提:

- server process が再起動される

期待結果:

- same threadId で再送すると prior turns を復元できる

## 10. テスト要件

### Unit

- FollowUpResolver
  - `続けて`
  - `両方`
  - `1`
  - `1,2`
  - `それで`
  - 低信頼ケース

- offeredNextActions extractor
  - 番号付きリスト
  - 箇条書き候補
  - 候補なし

### Integration

- `api/chat` が same sessionId で turn を蓄積する
- cold restore 後も turn が復元される
- memory search が Web transcript を返す

### UI

- 新しい会話で threadId が切り替わる
- 履歴クリックで threadId が切り替わる
- 履歴から開いた会話の続きを送れる

## 11. 実装時の注意

- Web UI は [`public/index.html`](/Users/noriaki/Desktop/claude_base/dexter/public/index.html) と [`src/web/public/index.html`](/Users/noriaki/Desktop/claude_base/dexter/src/web/public/index.html) の二重管理になっている。両方同期が必要。
- 既存の `InMemoryChatHistory` は短期コンテキスト用途として残してよい。今回必要なのは、それを超えた「継続会話の正規保存先」を持つこと。
- 解決ロジックを system prompt に追加するだけでは再発防止にならない。必ずアプリケーション層で follow-up を解決すること。
- Redis が使えないローカル環境でも動くよう、ファイルフォールバックは残すこと。

## 12. 実装完了の定義

以下が揃った時点で完了とする。

1. 短い追撃メッセージで会話が切れない
2. Web 会話が memory_search に載る
3. 履歴から本当に会話再開できる
4. reload / cold start 後も継続できる
5. 上記を担保するテストがある
