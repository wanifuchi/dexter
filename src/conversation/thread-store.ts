/**
 * ConversationThreadStore — 会話スレッドの永続化
 *
 * Source of truth: Upstash Redis
 * ファイルフォールバック: ローカル開発専用
 *
 * Redis キー設計:
 *   finx:thread:{threadId}:turns  — ConversationTurn[] (JSON)
 *   finx:thread:{threadId}:meta   — ThreadMeta (JSON)
 *   finx:thread:index             — string[] threadIdリスト
 *
 * 履歴表示・FollowUpResolver・agent prompt context のすべてが
 * このストアを唯一のsource of truthとして参照する。
 */
import type { ConversationTurn, ThreadMeta } from './types.js';
import { dexterPath } from '../utils/paths.js';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';

const THREAD_DIR = dexterPath('threads');
const REDIS_PREFIX = 'finx:thread';

let redisClient: any = null;
let redisInitialized = false;

async function getRedis() {
  if (redisInitialized) return redisClient;
  redisInitialized = true;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    redisClient = new Redis({ url, token });
    return redisClient;
  } catch { return null; }
}

function parseRedisData(data: unknown): unknown {
  while (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { break; }
  }
  return data;
}

// ============================================================================
// Primary API (Redis正)
// ============================================================================

/**
 * スレッドにターンを追加（Redis正 + ファイルフォールバック）
 */
export async function saveTurn(turn: ConversationTurn): Promise<void> {
  const { threadId } = turn;

  const redis = await getRedis();
  if (redis) {
    try {
      const turnsKey = `${REDIS_PREFIX}:${threadId}:turns`;
      let existing = parseRedisData(await redis.get(turnsKey));
      const turns: ConversationTurn[] = Array.isArray(existing) ? existing : [];
      turns.push(turn);
      await redis.set(turnsKey, JSON.stringify(turns));

      // メタ更新
      const meta: ThreadMeta = {
        threadId,
        title: turns[0]?.userMessage?.slice(0, 50) ?? '',
        createdAt: new Date(turns[0]?.timestamp ?? Date.now()).getTime(),
        updatedAt: Date.now(),
        turnCount: turns.length,
        lastUserMessage: turn.userMessage,
        lastAssistantPreview: turn.assistantMessage.slice(0, 100),
      };
      await redis.set(`${REDIS_PREFIX}:${threadId}:meta`, JSON.stringify(meta));

      // インデックスに追加
      const indexKey = `${REDIS_PREFIX}:index`;
      let index = parseRedisData(await redis.get(indexKey));
      const threadIds: string[] = Array.isArray(index) ? index : [];
      if (!threadIds.includes(threadId)) {
        threadIds.push(threadId);
        await redis.set(indexKey, JSON.stringify(threadIds));
      }
      return; // Redis成功 → ファイルフォールバック不要
    } catch {}
  }

  // ファイルフォールバック（ローカル開発用）
  saveToFile(turn);
}

/**
 * スレッドの全ターンを取得（Redis正 → ファイルフォールバック）
 */
export async function getTurns(threadId: string): Promise<ConversationTurn[]> {
  const redis = await getRedis();
  if (redis) {
    try {
      const data = parseRedisData(await redis.get(`${REDIS_PREFIX}:${threadId}:turns`));
      if (Array.isArray(data) && data.length > 0) return data;
    } catch {}
  }

  // ファイルフォールバック
  return getFromFile(threadId);
}

/**
 * 直近のターンを取得（FollowUpResolver + agent context用）
 */
export async function getRecentTurns(threadId: string, limit: number = 6): Promise<ConversationTurn[]> {
  const turns = await getTurns(threadId);
  return turns.slice(-limit);
}

/**
 * スレッド一覧を取得（updatedAt降順）
 */
export async function listThreads(limit: number = 50): Promise<ThreadMeta[]> {
  const metas: ThreadMeta[] = [];

  const redis = await getRedis();
  if (redis) {
    try {
      const index = parseRedisData(await redis.get(`${REDIS_PREFIX}:index`));
      const threadIds: string[] = Array.isArray(index) ? index : [];

      // 並列でメタ取得
      const metaPromises = threadIds.map(async (id) => {
        try {
          const meta = parseRedisData(await redis.get(`${REDIS_PREFIX}:${id}:meta`));
          if (meta && typeof meta === 'object') return meta as ThreadMeta;
        } catch {}
        return null;
      });
      const results = await Promise.all(metaPromises);
      for (const m of results) {
        if (m) metas.push(m);
      }

      if (metas.length > 0) {
        return metas.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
      }
    } catch {}
  }

  // ファイルフォールバック
  return listFromFiles(limit);
}

/**
 * Web会話のtranscriptをmemory search用にテキスト化
 */
export async function getThreadTranscript(threadId: string): Promise<string> {
  const turns = await getTurns(threadId);
  return turns
    .map(t => `User: ${t.userMessage}\nAssistant: ${t.assistantMessage}`)
    .join('\n\n');
}

/**
 * ThreadStoreの会話ターンからInMemoryChatHistory互換のデータを生成
 * agent-runnerのcold start復元で使用
 */
export async function restoreSessionFromThreads(threadId: string): Promise<Array<{ query: string; answer: string; summary: string | null }>> {
  const turns = await getTurns(threadId);
  return turns.map(t => ({
    query: t.userMessage,
    answer: t.assistantMessage,
    summary: t.assistantSummary ?? null,
  }));
}

// ============================================================================
// ファイルフォールバック（ローカル開発用）
// ============================================================================

function saveToFile(turn: ConversationTurn): void {
  try {
    mkdirSync(THREAD_DIR, { recursive: true });
    const filePath = `${THREAD_DIR}/${turn.threadId}.json`;
    let turns: ConversationTurn[] = [];
    try {
      const raw = readFileSync(filePath, 'utf-8');
      turns = JSON.parse(raw);
    } catch {}
    turns.push(turn);
    writeFileSync(filePath, JSON.stringify(turns, null, 2), 'utf-8');
  } catch {}
}

function getFromFile(threadId: string): ConversationTurn[] {
  try {
    const raw = readFileSync(`${THREAD_DIR}/${threadId}.json`, 'utf-8');
    return JSON.parse(raw);
  } catch {}
  return [];
}

function listFromFiles(limit: number): ThreadMeta[] {
  const metas: ThreadMeta[] = [];
  try {
    mkdirSync(THREAD_DIR, { recursive: true });
    const files = readdirSync(THREAD_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = readFileSync(`${THREAD_DIR}/${file}`, 'utf-8');
        const turns: ConversationTurn[] = JSON.parse(raw);
        if (turns.length === 0) continue;
        const threadId = file.replace('.json', '');
        metas.push({
          threadId,
          title: turns[0].userMessage.slice(0, 50),
          createdAt: new Date(turns[0].timestamp).getTime(),
          updatedAt: new Date(turns[turns.length - 1].timestamp).getTime(),
          turnCount: turns.length,
          lastUserMessage: turns[turns.length - 1].userMessage,
          lastAssistantPreview: turns[turns.length - 1].assistantMessage.slice(0, 100),
        });
      } catch {}
    }
  } catch {}
  return metas.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
