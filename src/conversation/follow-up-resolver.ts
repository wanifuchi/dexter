/**
 * FollowUpResolver — 短い追撃メッセージをアプリケーション層で解決
 *
 * 「続けて」「1,2を出して」「両方」等のメッセージを、
 * 直前のassistant回答の offeredNextActions を参照して
 * 具体的なクエリに展開する。
 */
import type { ConversationTurn, FollowUpResolution, OfferedNextAction } from './types.js';

// 既知のfollow-upパターン
const CONTINUE_PATTERNS = [
  /^(続けて|そのまま続けて|そのまま|続き|go\s*ahead|do\s*it|proceed|continue)$/i,
];

const BOTH_PATTERNS = [
  /^(両方|どちらも|全部|all|both)$/i,
  /^両方(出して|やって|お願い)?$/i,
];

const YES_PATTERNS = [
  /^(はい|yes|ok|うん|ええ|お願い|頼む|やって)$/i,
];

const COREFERENCE_PATTERNS = [
  /^(それ|これ|じゃあそれ|それで|それでいい|それやって|具体的に)$/i,
  /^(それ|これ)を?(出して|やって|お願い|教えて|見せて)/i,
];

// 数字参照パターン（1, 2, 1と2, 1,2 等）
const NUMBER_REF_PATTERN = /^(\d+)\s*[,、と]\s*(\d+)(?:\s*.+)?$/;
const SINGLE_NUMBER_PATTERN = /^(\d+)(?:\s*.+)?$/;
// 「1,2を具体的に出して」のような形
const NUMBER_WITH_INSTRUCTION = /^(\d+(?:\s*[,、と]\s*\d+)*)\s*を?\s*(.+)$/;

/**
 * メッセージが短い追撃かどうかを判定
 */
function isShortFollowUp(query: string): boolean {
  const trimmed = query.trim();
  // 10文字以下は短い追撃の可能性が高い
  if (trimmed.length <= 10) return true;
  // 30文字以下で既知パターンに一致
  if (trimmed.length <= 30) {
    const allPatterns = [
      ...CONTINUE_PATTERNS, ...BOTH_PATTERNS, ...YES_PATTERNS,
      ...COREFERENCE_PATTERNS, NUMBER_REF_PATTERN, SINGLE_NUMBER_PATTERN,
      NUMBER_WITH_INSTRUCTION,
    ];
    return allPatterns.some(p => p.test(trimmed));
  }
  return false;
}

/**
 * 数字参照を解析（"1,2" → ["1","2"], "1" → ["1"]）
 */
function parseNumberRefs(query: string): string[] {
  const trimmed = query.trim();

  // "1,2を具体的に出して" パターン
  const withInstr = NUMBER_WITH_INSTRUCTION.exec(trimmed);
  if (withInstr) {
    return withInstr[1].split(/[,、と]/).map(s => s.trim()).filter(Boolean);
  }

  // "1,2" or "1と2" パターン
  const multi = NUMBER_REF_PATTERN.exec(trimmed);
  if (multi) {
    return [multi[1], multi[2]];
  }

  // "1" 単体
  const single = SINGLE_NUMBER_PATTERN.exec(trimmed);
  if (single) {
    return [single[1]];
  }

  return [];
}

/**
 * offeredNextActionsから対応するアクションを解決
 */
function resolveNumberedActions(
  keys: string[],
  actions: OfferedNextAction[],
  originalQuery: string,
  additionalInstruction: string,
): FollowUpResolution | null {
  const matched = keys
    .map(k => actions.find(a => a.key === k))
    .filter((a): a is OfferedNextAction => a !== null && a !== undefined);

  if (matched.length === 0) return null;

  const actionDescriptions = matched
    .map((a, i) => `${i + 1}. ${a.instruction}`)
    .join(' と ');

  const suffix = additionalInstruction ? ` を、${additionalInstruction}` : '';
  const resolvedQuery = `前の回答で提案した ${actionDescriptions}${suffix}`;

  return {
    wasResolved: true,
    originalQuery,
    resolvedQuery,
    reason: 'numbered_action',
    confidence: 0.95,
    matchedActionKeys: matched.map(a => a.key),
  };
}

/**
 * 直近ターンからfollow-upを解決
 */
export function resolveFollowUp(
  query: string,
  recentTurns: ConversationTurn[],
): FollowUpResolution {
  const trimmed = query.trim();

  // 短い追撃でなければそのまま返す
  if (!isShortFollowUp(trimmed)) {
    return {
      wasResolved: false,
      originalQuery: query,
      resolvedQuery: query,
      reason: 'direct',
      confidence: 1.0,
    };
  }

  // 直前のターンを取得
  const lastTurn = recentTurns.length > 0 ? recentTurns[recentTurns.length - 1] : null;
  const actions = lastTurn?.offeredNextActions ?? [];

  // 1. 数字参照の解決（"1,2を具体的に出して"等）
  const numberRefs = parseNumberRefs(trimmed);
  if (numberRefs.length > 0 && actions.length > 0) {
    // 追加指示を抽出（"を具体的に出して"の部分）
    const withInstr = NUMBER_WITH_INSTRUCTION.exec(trimmed);
    const additionalInstruction = withInstr ? withInstr[2] : '';

    const resolution = resolveNumberedActions(numberRefs, actions, query, additionalInstruction);
    if (resolution) {
      resolution.matchedTurnId = lastTurn?.turnId;
      return resolution;
    }
  }

  // 2. 「両方」「全部」→ 全候補を実行
  if (BOTH_PATTERNS.some(p => p.test(trimmed)) && actions.length > 0) {
    const allDescriptions = actions
      .map((a, i) => `${i + 1}. ${a.instruction}`)
      .join(' と ');

    return {
      wasResolved: true,
      originalQuery: query,
      resolvedQuery: `前の回答で提案した ${allDescriptions} の両方を実行して`,
      reason: 'all_actions',
      confidence: 0.95,
      matchedTurnId: lastTurn?.turnId,
      matchedActionKeys: actions.map(a => a.key),
    };
  }

  // 3. 「続けて」「そのまま」「はい」→ 提案があれば全実行、なければ会話を続行
  const isContinue = CONTINUE_PATTERNS.some(p => p.test(trimmed));
  const isYes = YES_PATTERNS.some(p => p.test(trimmed));
  if ((isContinue || isYes) && actions.length > 0) {
    const allDescriptions = actions
      .map((a, i) => `${i + 1}. ${a.instruction}`)
      .join(' と ');

    return {
      wasResolved: true,
      originalQuery: query,
      resolvedQuery: `前の回答で提案した ${allDescriptions} を実行して`,
      reason: 'all_actions',
      confidence: 0.9,
      matchedTurnId: lastTurn?.turnId,
      matchedActionKeys: actions.map(a => a.key),
    };
  }

  // 4. 照応表現（「それ」「具体的に」）→ 直前assistantの内容を参照
  if (COREFERENCE_PATTERNS.some(p => p.test(trimmed)) && lastTurn) {
    // 直前の回答の最後の部分（提案部分）を参照
    const preview = lastTurn.assistantMessage.slice(-200);
    return {
      wasResolved: true,
      originalQuery: query,
      resolvedQuery: `前の回答の内容について、${trimmed}。\n\n前の回答の関連部分: ${preview}`,
      reason: 'coreference',
      confidence: 0.8,
      matchedTurnId: lastTurn.turnId,
    };
  }

  // 5. 短いが解決できない場合 → 直前のコンテキストを付加して通す
  if (lastTurn && trimmed.length <= 10) {
    const preview = lastTurn.assistantMessage.slice(-300);
    return {
      wasResolved: true,
      originalQuery: query,
      resolvedQuery: `${query}\n\n[コンテキスト: 直前の回答の末尾] ${preview}`,
      reason: 'short_follow_up',
      confidence: 0.7,
      matchedTurnId: lastTurn.turnId,
    };
  }

  return {
    wasResolved: false,
    originalQuery: query,
    resolvedQuery: query,
    reason: 'direct',
    confidence: 1.0,
  };
}
