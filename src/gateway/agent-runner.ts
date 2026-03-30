import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent } from '../agent/agent.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { dexterPath } from '../utils/paths.js';
import { HEARTBEAT_OK_TOKEN } from './heartbeat/suppression.js';
import type { AgentEvent } from '../agent/types.js';
import type { GroupContext } from '../agent/prompts.js';

type SessionState = {
  history: InMemoryChatHistory;
  tail: Promise<void>;
};

const sessions = new Map<string, SessionState>();

// セッション永続化用ディレクトリ（ファイルフォールバック）
const SESSIONS_DIR = dexterPath('sessions');

// Redis（セッション永続化の主ストア）
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

/**
 * セッション履歴をRedis + ファイルに保存
 */
async function persistSession(sessionKey: string, history: InMemoryChatHistory): Promise<void> {
  const safeName = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const data = history.toJSON();
  const json = JSON.stringify(data);

  // Redis優先
  const redis = await getRedis();
  if (redis) {
    try { await redis.set(`finx:session:${safeName}`, json); } catch {}
  }

  // ファイルフォールバック
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(`${SESSIONS_DIR}/${safeName}.json`, json, 'utf-8');
  } catch {}
}

/**
 * Redisまたはファイルからセッション履歴を復元
 */
async function restoreSession(sessionKey: string, history: InMemoryChatHistory): Promise<void> {
  const safeName = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');

  // Redis優先
  const redis = await getRedis();
  if (redis) {
    try {
      let data = await redis.get(`finx:session:${safeName}`);
      while (typeof data === 'string') { try { data = JSON.parse(data); } catch { break; } }
      if (Array.isArray(data) && data.length > 0) {
        history.loadFromJSON(data);
        return;
      }
    } catch {}
  }

  // ファイルフォールバック
  try {
    const raw = readFileSync(`${SESSIONS_DIR}/${safeName}.json`, 'utf-8');
    const data = JSON.parse(raw);
    history.loadFromJSON(data);
  } catch {}
}

async function getSession(sessionKey: string, model: string): Promise<SessionState> {
  const existing = sessions.get(sessionKey);
  if (existing) {
    return existing;
  }
  const created: SessionState = {
    history: new InMemoryChatHistory(model),
    tail: Promise.resolve(),
  };
  // コールドスタート後はRedis/ファイルから復元を試みる
  await restoreSession(sessionKey, created.history);
  sessions.set(sessionKey, created);
  return created;
}

export type AgentRunRequest = {
  sessionKey: string;
  query: string;
  model: string;
  modelProvider: string;
  maxIterations?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  isHeartbeat?: boolean;
  /** Run without persistent session history or memory (minimal context, ~95% token savings). */
  isolatedSession?: boolean;
  channel?: string;
  groupContext?: GroupContext;
};

export async function runAgentForMessage(req: AgentRunRequest): Promise<string> {
  const isolated = req.isolatedSession ?? false;
  const session = isolated ? null : await getSession(req.sessionKey, req.model);
  let finalAnswer = '';

  const run = async () => {
    if (session) session.history.saveUserQuery(req.query);
    const agent = await Agent.create({
      model: req.model,
      modelProvider: req.modelProvider,
      maxIterations: req.maxIterations ?? 10,
      signal: req.signal,
      channel: req.channel,
      groupContext: req.groupContext,
      memoryEnabled: !isolated,
    });
    for await (const event of agent.run(req.query, session?.history)) {
      await req.onEvent?.(event);
      if (event.type === 'done') {
        finalAnswer = event.answer;
      }
    }
    if (finalAnswer && session) {
      await session.history.saveAnswer(finalAnswer);
      // ターン完了時にファイルへ永続化
      await persistSession(req.sessionKey, session.history);
    }

    // Prune HEARTBEAT_OK turns to avoid context pollution
    if (session && req.isHeartbeat && finalAnswer.trim().toUpperCase().includes(HEARTBEAT_OK_TOKEN)) {
      session.history.pruneLastTurn();
      await persistSession(req.sessionKey, session.history);
    }
  };

  if (session) {
    // Serialize per-session turns while allowing cross-session concurrency.
    session.tail = session.tail.then(run, run);
    await session.tail;
  } else {
    await run();
  }
  return finalAnswer;
}
