import { resolveFollowUp } from '../follow-up-resolver.js';
import type { ConversationTurn } from '../types.js';

function makeTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    turnId: 'turn-1',
    threadId: 'test-thread',
    timestamp: new Date().toISOString(),
    userMessage: 'ポートフォリオを分析して',
    assistantMessage: '分析結果...\n\n必要なら次にすぐ出せます。\n1. 銘柄ごとの売り・保有・縮小の3分類\n2. 何株減らすとバランスが良くなるか',
    offeredNextActions: [
      { key: '1', label: '銘柄ごとの売り・保有・縮小の3分類', instruction: '銘柄ごとの売り・保有・縮小の3分類' },
      { key: '2', label: '何株減らすとバランスが良くなるか', instruction: '何株減らすとバランスが良くなるか' },
    ],
    ...overrides,
  };
}

describe('FollowUpResolver', () => {
  const recentTurns = [makeTurn()];

  // AC-1: 直前候補番号の解決
  it('「1,2を具体的に出して」で両方のアクションを解決する', () => {
    const result = resolveFollowUp('1,2を具体的に出して', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('numbered_action');
    expect(result.matchedActionKeys).toEqual(['1', '2']);
    expect(result.resolvedQuery).toContain('銘柄ごとの売り・保有・縮小の3分類');
    expect(result.resolvedQuery).toContain('何株減らすとバランスが良くなるか');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('「1」で単一アクションを解決する', () => {
    const result = resolveFollowUp('1', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('numbered_action');
    expect(result.matchedActionKeys).toEqual(['1']);
    expect(result.resolvedQuery).toContain('銘柄ごとの売り・保有・縮小の3分類');
  });

  it('「2」で単一アクションを解決する', () => {
    const result = resolveFollowUp('2', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.matchedActionKeys).toEqual(['2']);
  });

  // 「続けて」
  it('「続けて」で全アクションを実行する', () => {
    const result = resolveFollowUp('続けて', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('all_actions');
    expect(result.matchedActionKeys).toEqual(['1', '2']);
  });

  it('「そのまま」で全アクションを実行する', () => {
    const result = resolveFollowUp('そのまま', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('all_actions');
  });

  // 「両方」
  it('「両方」で全アクションを実行する', () => {
    const result = resolveFollowUp('両方', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('all_actions');
    expect(result.matchedActionKeys).toEqual(['1', '2']);
  });

  // 照応表現
  it('「それで」で照応解決する', () => {
    const result = resolveFollowUp('それで', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('coreference');
  });

  it('「具体的に」で照応解決する', () => {
    const result = resolveFollowUp('具体的に', recentTurns);
    expect(result.wasResolved).toBe(true);
  });

  // 直接クエリはそのまま通す
  it('通常のクエリはそのまま通す', () => {
    const result = resolveFollowUp('NVDAの財務を分析して', recentTurns);
    expect(result.wasResolved).toBe(false);
    expect(result.resolvedQuery).toBe('NVDAの財務を分析して');
    expect(result.reason).toBe('direct');
  });

  // offeredNextActionsがない場合
  it('offeredNextActionsがなくても「続けて」は短いfollow-upとして処理する', () => {
    const turnsNoActions = [makeTurn({ offeredNextActions: undefined })];
    const result = resolveFollowUp('続けて', turnsNoActions);
    // actionsがないのでall_actionsにはならないが、short_follow_upになる
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('short_follow_up');
  });

  // ターン履歴が空の場合
  it('履歴が空の場合はそのまま通す', () => {
    const result = resolveFollowUp('続けて', []);
    expect(result.wasResolved).toBe(false);
    expect(result.reason).toBe('direct');
  });

  // 低信頼ケース
  it('短いが明確なパターンに一致しないメッセージ', () => {
    const result = resolveFollowUp('ん？', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('short_follow_up');
    expect(result.confidence).toBeLessThan(0.9);
  });
});
