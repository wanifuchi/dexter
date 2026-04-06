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

  // === 明示パターンの解決 ===

  it('「1,2を具体的に出して」で両方のアクションを解決する', () => {
    const result = resolveFollowUp('1,2を具体的に出して', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('numbered_action');
    expect(result.matchedActionKeys).toEqual(['1', '2']);
    expect(result.resolvedQuery).toContain('銘柄ごとの売り・保有・縮小の3分類');
    expect(result.resolvedQuery).toContain('何株減らすとバランスが良くなるか');
  });

  it('「1」で単一アクションを解決する', () => {
    const result = resolveFollowUp('1', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('numbered_action');
    expect(result.matchedActionKeys).toEqual(['1']);
  });

  it('「2」で単一アクションを解決する', () => {
    const result = resolveFollowUp('2', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.matchedActionKeys).toEqual(['2']);
  });

  it('「1と2」で両方のアクションを解決する', () => {
    const result = resolveFollowUp('1と2', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.matchedActionKeys).toEqual(['1', '2']);
  });

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

  it('「両方」で全アクションを実行する', () => {
    const result = resolveFollowUp('両方', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('all_actions');
    expect(result.matchedActionKeys).toEqual(['1', '2']);
  });

  it('「それで」で照応解決する', () => {
    const result = resolveFollowUp('それで', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('coreference');
  });

  it('「具体的に」で照応解決する', () => {
    const result = resolveFollowUp('具体的に', recentTurns);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('coreference');
  });

  it('「yes」で全アクションを実行する', () => {
    const result = resolveFollowUp('yes', recentTurns);
    expect(result.wasResolved).toBe(true);
  });

  it('「go ahead」で全アクションを実行する', () => {
    const result = resolveFollowUp('go ahead', recentTurns);
    expect(result.wasResolved).toBe(true);
  });

  // === 誤爆防止: 短い新規質問はdirect ===

  it('「SOXLは?」はdirect扱い', () => {
    const result = resolveFollowUp('SOXLは?', recentTurns);
    expect(result.wasResolved).toBe(false);
    expect(result.reason).toBe('direct');
  });

  it('「NVDA?」はdirect扱い', () => {
    const result = resolveFollowUp('NVDA?', recentTurns);
    expect(result.wasResolved).toBe(false);
    expect(result.reason).toBe('direct');
  });

  it('「買うべき?」はdirect扱い', () => {
    const result = resolveFollowUp('買うべき?', recentTurns);
    expect(result.wasResolved).toBe(false);
    expect(result.reason).toBe('direct');
  });

  it('「ん？」はdirect扱い（低信頼で無理にrewriteしない）', () => {
    const result = resolveFollowUp('ん？', recentTurns);
    expect(result.wasResolved).toBe(false);
    expect(result.reason).toBe('direct');
  });

  it('通常のクエリはそのまま通す', () => {
    const result = resolveFollowUp('NVDAの財務を分析して', recentTurns);
    expect(result.wasResolved).toBe(false);
    expect(result.resolvedQuery).toBe('NVDAの財務を分析して');
    expect(result.reason).toBe('direct');
  });

  // === エッジケース ===

  it('offeredNextActionsがなくても「続けて」はshort_follow_upで処理する', () => {
    const turnsNoActions = [makeTurn({ offeredNextActions: undefined })];
    const result = resolveFollowUp('続けて', turnsNoActions);
    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('short_follow_up');
  });

  it('履歴が空の場合はそのまま通す', () => {
    const result = resolveFollowUp('続けて', []);
    expect(result.wasResolved).toBe(false);
    expect(result.reason).toBe('direct');
  });

  it('数字参照だがactionsなし → direct', () => {
    const turnsNoActions = [makeTurn({ offeredNextActions: [] })];
    const result = resolveFollowUp('1', turnsNoActions);
    expect(result.wasResolved).toBe(false);
    expect(result.reason).toBe('direct');
  });

  // === 長文継続要求（offeredNextActionsの文言を列挙） ===

  it('3項目をそのまま列挙した長文要求を継続として解決する', () => {
    const turnsWith3Actions = [makeTurn({
      offeredNextActions: [
        { key: '1', label: '売却後の新ポートフォリオ比率', instruction: '売却後の新ポートフォリオ比率を出す' },
        { key: '2', label: '特定/NISAどちらから先に売るべきか', instruction: '税金まで加味した特定/NISAどちらから先に売るべきかを出す' },
        { key: '3', label: '指値一覧を注文メモ形式で出す', instruction: '指値一覧をそのまま注文メモ形式で出す' },
      ],
    })];

    const longQuery = '1. この売買を反映した「売却後の新ポートフォリオ比率」 2. 税金まで加味した「特定/NISAどちらから先に売るべきか」 3. 指値一覧をそのまま注文メモ形式で出す たのむ';
    const result = resolveFollowUp(longQuery, turnsWith3Actions);

    expect(result.wasResolved).toBe(true);
    expect(result.reason).toBe('all_actions');
    expect(result.matchedActionKeys?.length).toBeGreaterThanOrEqual(2);
  });

  it('offeredActionsのラベルを含む長文要求を継続として解決する', () => {
    const turnsWith3Actions = [makeTurn({
      offeredNextActions: [
        { key: '1', label: '売却後の新ポートフォリオ比率', instruction: '売却後の新ポートフォリオ比率' },
        { key: '2', label: '特定/NISAどちらから先に売るべきか', instruction: '特定/NISAどちらから先に売るべきか' },
        { key: '3', label: '指値一覧を注文メモ形式で出す', instruction: '指値一覧を注文メモ形式で出す' },
      ],
    })];

    const longQuery = '売却後の新ポートフォリオ比率と、特定/NISAどちらから先に売るべきかと、指値一覧を注文メモ形式で出す、全部やって';
    const result = resolveFollowUp(longQuery, turnsWith3Actions);

    expect(result.wasResolved).toBe(true);
    expect(result.matchedActionKeys?.length).toBeGreaterThanOrEqual(2);
  });

  it('長文だがofferedActionsと無関係な質問はdirect', () => {
    const result = resolveFollowUp('来週のFOMCに向けてポートフォリオをどう調整すべきか詳しく教えて', recentTurns);
    expect(result.wasResolved).toBe(false);
    expect(result.reason).toBe('direct');
  });
});
