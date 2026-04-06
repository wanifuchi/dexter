import { saveTurn, getTurns, getRecentTurns } from '../thread-store.js';
import type { ConversationTurn } from '../types.js';
import { mkdirSync, rmSync } from 'node:fs';

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

function makeTurn(threadId: string, idx: number): ConversationTurn {
  return {
    turnId: `${threadId}-${idx}`,
    threadId,
    timestamp: new Date(Date.now() + idx * 1000).toISOString(),
    userMessage: `質問 ${idx}`,
    assistantMessage: `回答 ${idx}`,
  };
}

describe('ThreadStore', () => {
  const testThreadId = `test-thread-${Date.now()}`;

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
});
