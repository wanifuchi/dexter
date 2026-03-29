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

// セッション永続化用ディレクトリ
const SESSIONS_DIR = dexterPath('sessions');

/**
 * セッション履歴をファイルに保存
 */
function persistSession(sessionKey: string, history: InMemoryChatHistory): void {
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const safeName = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = `${SESSIONS_DIR}/${safeName}.json`;
    const data = history.toJSON();
    writeFileSync(filePath, JSON.stringify(data), 'utf-8');
  } catch {
    // 永続化失敗は致命的ではない — メモリ上では動作し続ける
  }
}

/**
 * ファイルからセッション履歴を復元
 */
function restoreSession(sessionKey: string, history: InMemoryChatHistory): void {
  try {
    const safeName = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = `${SESSIONS_DIR}/${safeName}.json`;
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    history.loadFromJSON(data);
  } catch {
    // ファイルが無い or パース失敗 → 新規セッションとして扱う
  }
}

function getSession(sessionKey: string, model: string): SessionState {
  const existing = sessions.get(sessionKey);
  if (existing) {
    return existing;
  }
  const created: SessionState = {
    history: new InMemoryChatHistory(model),
    tail: Promise.resolve(),
  };
  // コールドスタート後はファイルから復元を試みる
  restoreSession(sessionKey, created.history);
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
  const session = isolated ? null : getSession(req.sessionKey, req.model);
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
      persistSession(req.sessionKey, session.history);
    }

    // Prune HEARTBEAT_OK turns to avoid context pollution
    if (session && req.isHeartbeat && finalAnswer.trim().toUpperCase().includes(HEARTBEAT_OK_TOKEN)) {
      session.history.pruneLastTurn();
      persistSession(req.sessionKey, session.history);
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
