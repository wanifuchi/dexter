/**
 * FollowUpResolver — 短い追撃メッセージをアプリケーション層で解決
 *
 * 明示的パターン（続けて/1,2/両方等）のみ解決する。
 * 短いだけの銘柄質問・価格質問・新規分析依頼はdirect扱い。
 * 低信頼ケースでは無理にrewriteせず、未解決のまま通す。
 */
import type { ConversationTurn, FollowUpResolution, OfferedNextAction } from './types.js';

// === 明示的follow-upパターン（これらに一致する場合のみ解決する） ===

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
  /^(それで|じゃあそれ|それでいい|それやって|具体的に)$/i,
  /^(それ|これ)を?(出して|やって|お願い|教えて|見せて)$/i,
];

// 数字参照パターン
const NUMBER_REF_PATTERN = /^(\d+)\s*[,、と]\s*(\d+)(?:\s*.+)?$/;
const SINGLE_NUMBER_PATTERN = /^(\d+)$/;
// 「1,2を具体的に出して」— 必ず「を」が必要（「1と2」だけだと誤マッチするため）
const NUMBER_WITH_INSTRUCTION = /^(\d+(?:\s*[,、と]\s*\d+)*)\s*を\s*(.+)$/;

/**
 * 明示的follow-upパターンに一致するか判定
 * 「短いだけ」では判定しない — 明示パターンのみ
 */
function matchesFollowUpPattern(query: string): boolean {
  const trimmed = query.trim();
  const allExplicitPatterns = [
    ...CONTINUE_PATTERNS, ...BOTH_PATTERNS, ...YES_PATTERNS, ...COREFERENCE_PATTERNS,
  ];
  // 明示パターンに完全一致
  if (allExplicitPatterns.some(p => p.test(trimmed))) return true;
  // 数字参照（"1", "1,2", "1,2を具体的に出して"等）
  if (SINGLE_NUMBER_PATTERN.test(trimmed)) return true;
  if (NUMBER_REF_PATTERN.test(trimmed)) return true;
  if (NUMBER_WITH_INSTRUCTION.test(trimmed)) return true;
  return false;
}

/**
 * 数字参照を解析
 */
function parseNumberRefs(query: string): string[] {
  const trimmed = query.trim();

  const withInstr = NUMBER_WITH_INSTRUCTION.exec(trimmed);
  if (withInstr) {
    return withInstr[1].split(/[,、と]/).map(s => s.trim()).filter(Boolean);
  }

  const multi = NUMBER_REF_PATTERN.exec(trimmed);
  if (multi) return [multi[1], multi[2]];

  const single = SINGLE_NUMBER_PATTERN.exec(trimmed);
  if (single) return [single[1]];

  return [];
}

function resolveNumberedActions(
  keys: string[],
  actions: OfferedNextAction[],
  originalQuery: string,
  additionalInstruction: string,
): FollowUpResolution | null {
  const matched = keys
    .map(k => actions.find(a => a.key === k))
    .filter((a): a is OfferedNextAction => a != null);

  if (matched.length === 0) return null;

  const actionDescriptions = matched.map((a, i) => `${i + 1}. ${a.instruction}`).join(' と ');
  const suffix = additionalInstruction ? ` を、${additionalInstruction}` : '';

  return {
    wasResolved: true,
    originalQuery,
    resolvedQuery: `前の回答で提案した ${actionDescriptions}${suffix}`,
    reason: 'numbered_action',
    confidence: 0.95,
    matchedActionKeys: matched.map(a => a.key),
  };
}

/**
 * ユーザーの入力がofferedNextActionsの文言を列挙しているか判定
 * 「1. xxx 2. xxx 3. xxx たのむ」のような長文継続要求を拾う
 */
function matchesOfferedActions(query: string, actions: OfferedNextAction[]): OfferedNextAction[] | null {
  if (actions.length === 0) return null;

  // 番号付きリストパターン: "1. xxx 2. xxx 3. xxx"
  const numberedPattern = /(\d+)[.)\s]+/g;
  const numbers: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = numberedPattern.exec(query)) !== null) {
    numbers.push(match[1]);
  }

  // offeredActionsのキーと照合
  if (numbers.length >= 2) {
    const matched = numbers
      .map(n => actions.find(a => a.key === n))
      .filter((a): a is OfferedNextAction => a != null);
    if (matched.length >= 2 && matched.length >= actions.length * 0.5) {
      return matched;
    }
  }

  // ラベル文言の部分一致: offeredActionsのlabelがクエリに含まれているか
  const labelMatches = actions.filter(a =>
    query.includes(a.label) || query.includes(a.instruction)
  );
  if (labelMatches.length >= 2 && labelMatches.length >= actions.length * 0.5) {
    return labelMatches;
  }

  return null;
}

/**
 * 直近ターンからfollow-upを解決
 */
export function resolveFollowUp(
  query: string,
  recentTurns: ConversationTurn[],
): FollowUpResolution {
  const trimmed = query.trim();
  const directResult: FollowUpResolution = {
    wasResolved: false,
    originalQuery: query,
    resolvedQuery: query,
    reason: 'direct',
    confidence: 1.0,
  };

  const lastTurn = recentTurns.length > 0 ? recentTurns[recentTurns.length - 1] : null;
  const actions = lastTurn?.offeredNextActions ?? [];

  // 長文でもofferedNextActionsの文言を列挙している場合は継続要求として解決
  if (lastTurn && actions.length > 0) {
    const matched = matchesOfferedActions(trimmed, actions);
    if (matched) {
      const allDescriptions = matched.map((a, i) => `${i + 1}. ${a.instruction}`).join(' と ');
      return {
        wasResolved: true,
        originalQuery: query,
        resolvedQuery: `前の回答で提案した ${allDescriptions} を実行して`,
        reason: 'all_actions',
        confidence: 0.9,
        matchedTurnId: lastTurn.turnId,
        matchedActionKeys: matched.map(a => a.key),
      };
    }
  }

  // 明示パターンに一致しなければ即direct
  if (!matchesFollowUpPattern(trimmed)) return directResult;

  // 履歴がなければ解決不可 → direct
  if (!lastTurn) return directResult;

  // 1. 数字参照の解決
  const numberRefs = parseNumberRefs(trimmed);
  if (numberRefs.length > 0 && actions.length > 0) {
    const withInstr = NUMBER_WITH_INSTRUCTION.exec(trimmed);
    const additionalInstruction = withInstr ? withInstr[2] : '';
    const resolution = resolveNumberedActions(numberRefs, actions, query, additionalInstruction);
    if (resolution) {
      resolution.matchedTurnId = lastTurn.turnId;
      return resolution;
    }
  }

  // 2. 「両方」→ 全候補
  if (BOTH_PATTERNS.some(p => p.test(trimmed)) && actions.length > 0) {
    const allDescriptions = actions.map((a, i) => `${i + 1}. ${a.instruction}`).join(' と ');
    return {
      wasResolved: true,
      originalQuery: query,
      resolvedQuery: `前の回答で提案した ${allDescriptions} の両方を実行して`,
      reason: 'all_actions',
      confidence: 0.95,
      matchedTurnId: lastTurn.turnId,
      matchedActionKeys: actions.map(a => a.key),
    };
  }

  // 3. 「続けて」「はい」→ 提案があれば全実行
  const isContinue = CONTINUE_PATTERNS.some(p => p.test(trimmed));
  const isYes = YES_PATTERNS.some(p => p.test(trimmed));
  if ((isContinue || isYes) && actions.length > 0) {
    const allDescriptions = actions.map((a, i) => `${i + 1}. ${a.instruction}`).join(' と ');
    return {
      wasResolved: true,
      originalQuery: query,
      resolvedQuery: `前の回答で提案した ${allDescriptions} を実行して`,
      reason: 'all_actions',
      confidence: 0.9,
      matchedTurnId: lastTurn.turnId,
      matchedActionKeys: actions.map(a => a.key),
    };
  }

  // 4. 照応表現 → 直前回答の末尾を参照
  if (COREFERENCE_PATTERNS.some(p => p.test(trimmed))) {
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

  // 5. パターンに一致したがactionsがない場合（「続けて」だがofferedActionsなし）
  //    → コンテキスト付きで通す
  if (isContinue || isYes) {
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

  // 数字参照だがactionsなし → direct（数字が新規質問の可能性）
  return directResult;
}
