/**
 * NextActionsExtractor — assistantの回答から「次にできること」を構造化抽出
 *
 * 対象パターン:
 * - 「必要なら次に...」「続けるなら...」「次にすぐ...」
 * - 番号付きリスト（1. xxx 2. xxx）
 * - 箇条書き（- xxx）
 */
import type { OfferedNextAction } from './types.js';

// 「次にできること」の前振りパターン
const PREAMBLE_PATTERNS = [
  /(?:必要なら|続ける(?:なら)?|次に(?:すぐ)?|どれから|やりますか|出せます|できます)[^\n]*\n/gi,
  /(?:want me to|shall I|I can|next steps?|would you like)[^\n]*\n/gi,
];

// 番号付きリストのパターン
const NUMBERED_ITEM = /^(?:\s*)(\d+)[.)\]]\s*[*]*[「]?(.+?)[」]?[*]*$/gm;
// 箇条書きパターン（前振り直後のみ）
const BULLET_ITEM = /^(?:\s*)[-•]\s*[*]*[「]?(.+?)[」]?[*]*$/gm;

/**
 * assistantの回答から次アクション候補を抽出
 */
export function extractOfferedNextActions(assistantMessage: string): OfferedNextAction[] {
  if (!assistantMessage) return [];

  const actions: OfferedNextAction[] = [];

  // 前振りパターンを探し、その後のリストを抽出
  for (const pattern of PREAMBLE_PATTERNS) {
    pattern.lastIndex = 0;
    let preambleMatch: RegExpExecArray | null;

    while ((preambleMatch = pattern.exec(assistantMessage)) !== null) {
      const afterPreamble = assistantMessage.slice(preambleMatch.index);

      // 番号付きリストを試す
      const numbered = extractNumberedItems(afterPreamble);
      if (numbered.length > 0) {
        for (const item of numbered) {
          if (!actions.some(a => a.key === item.key)) {
            actions.push(item);
          }
        }
      }
    }
  }

  // 前振りがなくても、末尾付近の番号付きリストを拾う
  if (actions.length === 0) {
    // 最後の半分から番号リストを探す（短い回答でも拾えるよう半分で切る）
    const tailStart = Math.max(0, Math.floor(assistantMessage.length * 0.4));
    const tail = assistantMessage.slice(tailStart);
    const numbered = extractNumberedItems(tail);
    if (numbered.length >= 2) {
      actions.push(...numbered);
    }
  }

  return actions;
}

function extractNumberedItems(text: string): OfferedNextAction[] {
  const items: OfferedNextAction[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/^\s*(\d+)[.)\]]\s*[*]*[「]?(.+?)[」]?[*]*\s*$/);
    if (match) {
      const key = match[1];
      const rawLabel = match[2].trim();
      items.push({
        key,
        label: rawLabel.replace(/[。、]$/, ''),
        instruction: rawLabel,
      });
    }
  }

  return items;
}
