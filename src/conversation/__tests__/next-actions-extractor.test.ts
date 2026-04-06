import { extractOfferedNextActions } from '../next-actions-extractor.js';

describe('NextActionsExtractor', () => {
  it('番号付きリスト（前振りあり）を抽出する', () => {
    const message = `分析結果です。

必要なら次にすぐ出せます。
1. SOXL vs SOXX の比較
2. 今の価格帯でのエントリー戦略`;

    const actions = extractOfferedNextActions(message);
    expect(actions).toHaveLength(2);
    expect(actions[0].key).toBe('1');
    expect(actions[0].label).toContain('SOXL vs SOXX');
    expect(actions[1].key).toBe('2');
    expect(actions[1].label).toContain('エントリー戦略');
  });

  it('「続けるなら」パターンを拾う', () => {
    const message = `以上がレポートです。

続けるなら次を出せます。
1. 売却候補のリスト
2. 買い増し候補`;

    const actions = extractOfferedNextActions(message);
    expect(actions).toHaveLength(2);
  });

  it('番号付きリスト（前振りなし、末尾）を拾う', () => {
    const message = `長い分析内容...\n\n1. 銘柄ごとの3分類\n2. リバランス案\n3. 税効率の最適化`;

    const actions = extractOfferedNextActions(message);
    expect(actions.length).toBeGreaterThanOrEqual(2);
  });

  it('候補なしの場合は空配列を返す', () => {
    const message = '分析結果: NVDAは割高です。以上。';
    const actions = extractOfferedNextActions(message);
    expect(actions).toHaveLength(0);
  });

  it('空文字列でも壊れない', () => {
    expect(extractOfferedNextActions('')).toHaveLength(0);
  });
});
