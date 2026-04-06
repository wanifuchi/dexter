import { Agent } from '../agent/agent.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { HEARTBEAT_OK_TOKEN } from './heartbeat/suppression.js';
import type { AgentEvent } from '../agent/types.js';
import type { GroupContext } from '../agent/prompts.js';
import {
  saveTurn,
  extractOfferedNextActions,
  getRecentTurns as getThreadRecentTurns,
  restoreSessionFromThreads,
} from '../conversation/index.js';
import type { ConversationTurn } from '../conversation/types.js';

type SessionState = {
  history: InMemoryChatHistory;
  tail: Promise<void>;
};

const sessions = new Map<string, SessionState>();

/**
 * セッション復元 — ThreadStore (Redis正) から InMemoryChatHistory を構築
 *
 * ThreadStoreが唯一のsource of truthなので、
 * cold start後もここから完全な会話履歴を復元できる。
 */
async function restoreFromThreadStore(sessionKey: string, history: InMemoryChatHistory): Promise<void> {
  try {
    const turns = await restoreSessionFromThreads(sessionKey);
    if (turns.length === 0) return;

    // InMemoryChatHistory.loadFromJSON互換の形式に変換
    const messages = turns.map((t, i) => ({
      id: i,
      query: t.query,
      answer: t.answer,
      summary: t.summary,
    }));
    history.loadFromJSON(messages);
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
  // ThreadStore (Redis正) から会話履歴を復元
  await restoreFromThreadStore(sessionKey, created.history);
  sessions.set(sessionKey, created);
  return created;
}

export type ImageAttachment = {
  base64: string;
  mimeType: string;
};

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
  /** Vision: attached image to include in the prompt */
  image?: ImageAttachment;
  /** 生のユーザー入力（画像前置き・follow-up解決前の原文） */
  rawUserMessage?: string;
  /** FollowUpResolverで解決済みのクエリ（解決した場合のみセット） */
  resolvedQuery?: string;
};

export async function runAgentForMessage(req: AgentRunRequest): Promise<string> {
  const isolated = req.isolatedSession ?? false;
  const session = isolated ? null : await getSession(req.sessionKey, req.model);
  let finalAnswer = '';

  const run = async () => {
    if (session) session.history.saveUserQuery(req.query);

    // ThreadStoreからrecentTurnsを取得（agent prompt context用）
    const threadTurns = await getThreadRecentTurns(req.sessionKey, 6);

    const agent = await Agent.create({
      model: req.model,
      modelProvider: req.modelProvider,
      maxIterations: req.maxIterations ?? 10,
      signal: req.signal,
      channel: req.channel,
      groupContext: req.groupContext,
      memoryEnabled: !isolated,
    });
    for await (const event of agent.run(req.query, session?.history, req.image, threadTurns)) {
      await req.onEvent?.(event);
      if (event.type === 'done') {
        finalAnswer = event.answer;
      }
    }
    if (finalAnswer && session) {
      await session.history.saveAnswer(finalAnswer);

      // ThreadStore (source of truth) にターンを保存
      try {
        const turn: ConversationTurn = {
          turnId: `${req.sessionKey}-${Date.now()}`,
          threadId: req.sessionKey,
          timestamp: new Date().toISOString(),
          userMessage: req.rawUserMessage ?? req.query,
          resolvedUserMessage: req.resolvedQuery,
          assistantMessage: finalAnswer,
          offeredNextActions: extractOfferedNextActions(finalAnswer),
        };
        await saveTurn(turn);
      } catch {}
    }

    // Prune HEARTBEAT_OK turns to avoid context pollution
    if (session && req.isHeartbeat && finalAnswer.trim().toUpperCase().includes(HEARTBEAT_OK_TOKEN)) {
      session.history.pruneLastTurn();
    }
  };

  if (session) {
    session.tail = session.tail.then(run, run);
    await session.tail;
  } else {
    await run();
  }
  return finalAnswer;
}
