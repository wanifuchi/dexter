import { saveTurn, getTurns, getRecentTurns, listThreads, restoreSessionFromThreads } from '../thread-store.js';
import { resolveFollowUp } from '../follow-up-resolver.js';
import type { ConversationTurn } from '../types.js';

// テスト用に環境変数をクリア（Redisを使わずファイルのみ）
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

beforeAll(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_KV_REST_API_URL;
  delete process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
});

afterAll(() => {
  if (originalUrl) process.env.UPSTASH_REDIS_REST_URL = originalUrl;
  if (originalToken) process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
});

function makeTurn(threadId: string, idx: number, overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    turnId: `${threadId}-${idx}`,
    threadId,
    timestamp: new Date(Date.now() + idx * 1000).toISOString(),
    userMessage: `質問 ${idx}`,
    assistantMessage: `回答 ${idx}`,
    ...overrides,
  };
}

describe('ThreadStore', () => {
  const testThreadId = `test-thread-${Date.now()}`;

  // === 基本CRUD ===

  it('saveTurn + getTurns でターンを保存・復元できる', async () => {
    const turn1 = makeTurn(testThreadId, 1);
    const turn2 = makeTurn(testThreadId, 2);

    await saveTurn(turn1);
    await saveTurn(turn2);

    const turns = await getTurns(testThreadId);
    expect(turns.length).toBe(2);
    expect(turns[0].userMessage).toBe('質問 1');
    expect(turns[1].userMessage).toBe('質問 2');
  });

  it('getRecentTurns は最新N件を返す', async () => {
    const recent = await getRecentTurns(testThreadId, 1);
    expect(recent.length).toBe(1);
    expect(recent[0].userMessage).toBe('質問 2');
  });

  it('userMessage と resolvedUserMessage が分離保存される', async () => {
    const threadId = `test-separation-${Date.now()}`;
    const turn: ConversationTurn = {
      turnId: `${threadId}-1`,
      threadId,
      timestamp: new Date().toISOString(),
      userMessage: '続けて',
      resolvedUserMessage: '前の回答で提案した 1. 銘柄ごとの3分類 と 2. 何株減らすか を実行して',
      assistantMessage: '了解。',
    };
    await saveTurn(turn);

    const turns = await getTurns(threadId);
    expect(turns[0].userMessage).toBe('続けて');
    expect(turns[0].resolvedUserMessage).toContain('銘柄ごとの3分類');
  });

  it('存在しないthreadIdでは空配列を返す', async () => {
    const turns = await getTurns('nonexistent-thread');
    expect(turns).toEqual([]);
  });

  // === スレッド一覧 ===

  it('listThreads でスレッド一覧を取得できる', async () => {
    const threads = await listThreads(50);
    expect(threads.length).toBeGreaterThan(0);
    const found = threads.find(t => t.threadId === testThreadId);
    expect(found).toBeDefined();
    expect(found!.turnCount).toBe(2);
  });

  // === cold restore テスト ===

  it('restoreSessionFromThreads でInMemoryChatHistory互換データを復元できる', async () => {
    const messages = await restoreSessionFromThreads(testThreadId);
    expect(messages.length).toBe(2);
    expect(messages[0].query).toBe('質問 1');
    expect(messages[0].answer).toBe('回答 1');
    expect(messages[1].query).toBe('質問 2');
  });

  // === 履歴から開いたthreadIdでfollow-upが解決できる ===

  it('ThreadStoreのターンを使ってfollow-upが解決できる', async () => {
    const threadId = `test-followup-${Date.now()}`;
    const turn: ConversationTurn = {
      turnId: `${threadId}-1`,
      threadId,
      timestamp: new Date().toISOString(),
      userMessage: 'ポートフォリオを分析して',
      assistantMessage: '分析結果...\n\n必要なら次に\n1. 売却案\n2. 買い候補\nを出せます。',
      offeredNextActions: [
        { key: '1', label: '売却案', instruction: '売却案を出す' },
        { key: '2', label: '買い候補', instruction: '買い候補を出す' },
      ],
    };
    await saveTurn(turn);

    // 同じthreadIdの直近ターンを取得してfollow-up解決
    const recentTurns = await getRecentTurns(threadId, 6);
    const resolution = resolveFollowUp('両方', recentTurns);

    expect(resolution.wasResolved).toBe(true);
    expect(resolution.reason).toBe('all_actions');
    expect(resolution.matchedActionKeys).toEqual(['1', '2']);
  });

  // === 長い継続要求でも前提会話を失わない ===

  it('長文継続要求がThreadStore経由で解決できる', async () => {
    const threadId = `test-long-${Date.now()}`;
    const turn: ConversationTurn = {
      turnId: `${threadId}-1`,
      threadId,
      timestamp: new Date().toISOString(),
      userMessage: '保有銘柄を分析して',
      assistantMessage: '分析完了。\n\n次にすぐ出せます。\n1. 売却後の新ポートフォリオ比率\n2. 税金加味の売却順序\n3. 指値一覧',
      offeredNextActions: [
        { key: '1', label: '売却後の新ポートフォリオ比率', instruction: '売却後の新ポートフォリオ比率を出す' },
        { key: '2', label: '税金加味の売却順序', instruction: '税金加味の売却順序を出す' },
        { key: '3', label: '指値一覧', instruction: '指値一覧を出す' },
      ],
    };
    await saveTurn(turn);

    const recentTurns = await getRecentTurns(threadId, 6);
    const longQuery = '1. 売却後の新ポートフォリオ比率 2. 税金加味の売却順序 3. 指値一覧 全部出して';
    const resolution = resolveFollowUp(longQuery, recentTurns);

    expect(resolution.wasResolved).toBe(true);
    expect(resolution.matchedActionKeys?.length).toBeGreaterThanOrEqual(2);
  });
});
