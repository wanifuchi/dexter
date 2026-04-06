/**
 * Parses Dexter's chat_history.json into indexable text chunks for memory search.
 *
 * Each conversation turn (user message + agent response) becomes a searchable
 * entry so that past conversations are recallable even if never explicitly saved
 * to MEMORY.md.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { listThreads, getTurns } from '../conversation/index.js';

export type SessionEntry = {
  /** Formatted text: "User: ...\nAssistant: ..." */
  content: string;
  /** SHA-256 of content for change detection. */
  contentHash: string;
  /** ISO timestamp from the original message. */
  timestamp: string;
};

type ChatHistoryMessage = {
  id: string;
  timestamp: string;
  userMessage: string;
  agentResponse: string | null;
};

type ChatHistoryFile = {
  messages: ChatHistoryMessage[];
};

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export async function parseSessionTranscripts(chatHistoryPath: string): Promise<SessionEntry[]> {
  let raw: string;
  try {
    raw = await readFile(chatHistoryPath, 'utf-8');
  } catch {
    return [];
  }

  let parsed: ChatHistoryFile;
  try {
    parsed = JSON.parse(raw) as ChatHistoryFile;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed.messages)) {
    return [];
  }

  const entries: SessionEntry[] = [];

  for (const msg of parsed.messages) {
    if (!msg.userMessage || !msg.agentResponse) {
      continue;
    }

    const userPart = normalizeWhitespace(msg.userMessage);
    const assistantPart = normalizeWhitespace(msg.agentResponse);
    const content = `User: ${userPart}\nAssistant: ${assistantPart}`;

    entries.push({
      content,
      contentHash: hashContent(content),
      timestamp: msg.timestamp,
    });
  }

  return entries;
}

/**
 * ConversationThreadStoreからWeb会話をSessionEntryに変換
 * memory_searchの検索対象にWeb会話を載せる（FR-5対応）
 */
export async function parseThreadTranscripts(): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];

  try {
    const threads = await listThreads(50);
    for (const meta of threads) {
      try {
        const turns = await getTurns(meta.threadId);
        for (const turn of turns) {
          if (!turn.userMessage || !turn.assistantMessage) continue;

          const userPart = normalizeWhitespace(turn.userMessage);
          const assistantPart = normalizeWhitespace(turn.assistantMessage);
          const content = `User: ${userPart}\nAssistant: ${assistantPart}`;

          entries.push({
            content,
            contentHash: hashContent(content),
            timestamp: turn.timestamp,
          });
        }
      } catch {}
    }
  } catch {}

  return entries;
}
