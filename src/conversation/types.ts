/**
 * 会話継続性 — 型定義
 */

export type OfferedNextAction = {
  key: string;
  label: string;
  instruction: string;
};

export type ConversationTurn = {
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

export type ThreadMeta = {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  lastUserMessage: string;
  lastAssistantPreview: string;
};

export type FollowUpResolution = {
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
