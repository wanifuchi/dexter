import {
  classifyRecommendationIntent,
  checkRecommendationEvidence,
  buildEvidenceInsufficientResponse,
  isToolResultValid,
  containsPersonalizationExpressions,
  shouldBlockMemory,
} from '../recommendation-guard.js';

describe('RecommendationIntentClassifier', () => {
  it('「今日のおすすめ銘柄」を時点依存推薦と判定', () => {
    const r = classifyRecommendationIntent('今日のおすすめ銘柄を出して');
    expect(r.isRecommendation).toBe(true);
    expect(r.isTimeSensitive).toBe(true);
    expect(r.isExplicitlyPersonalized).toBe(false);
  });

  it('「4/7のおすすめ株」を時点依存推薦と判定', () => {
    const r = classifyRecommendationIntent('4/7のおすすめ株を教えて');
    expect(r.isTimeSensitive).toBe(true);
  });

  it('「今買うべき銘柄」を時点依存推薦と判定', () => {
    const r = classifyRecommendationIntent('今買うべき銘柄は？');
    expect(r.isTimeSensitive).toBe(true);
  });

  it('「latest top picks」を時点依存推薦と判定', () => {
    const r = classifyRecommendationIntent('latest top picks today');
    expect(r.isTimeSensitive).toBe(true);
  });

  it('「私の好み込みで今日の3銘柄」はexplicitly personalizedと判定', () => {
    const r = classifyRecommendationIntent('私の好み込みで今日の3銘柄を選んで');
    expect(r.isTimeSensitive).toBe(true);
    expect(r.isExplicitlyPersonalized).toBe(true);
  });

  it('「ポートフォリオを分析して」は推薦ではない', () => {
    const r = classifyRecommendationIntent('ポートフォリオを分析して');
    expect(r.isRecommendation).toBe(false);
  });

  it('「NVDAの財務を分析して」は推薦ではない', () => {
    const r = classifyRecommendationIntent('NVDAの財務を分析して');
    expect(r.isRecommendation).toBe(false);
  });
});

describe('shouldBlockMemory', () => {
  it('time-sensitive + non-personalized → block', () => {
    expect(shouldBlockMemory({ isRecommendation: true, isTimeSensitive: true, isExplicitlyPersonalized: false })).toBe(true);
  });

  it('time-sensitive + explicitly personalized → allow', () => {
    expect(shouldBlockMemory({ isRecommendation: true, isTimeSensitive: true, isExplicitlyPersonalized: true })).toBe(false);
  });

  it('non-time-sensitive → allow', () => {
    expect(shouldBlockMemory({ isRecommendation: true, isTimeSensitive: false, isExplicitlyPersonalized: false })).toBe(false);
  });
});

describe('isToolResultValid', () => {
  it('get_market_dataが_errorsのみ → 無効', () => {
    const result = JSON.stringify({ data: { _errors: ['API failed'] } });
    expect(isToolResultValid('get_market_data', result)).toBe(false);
  });

  it('get_market_dataがerrorのみ → 無効', () => {
    const result = JSON.stringify({ data: { error: 'not found' } });
    expect(isToolResultValid('get_market_data', result)).toBe(false);
  });

  it('空配列 → 無効', () => {
    const result = JSON.stringify({ data: [] });
    expect(isToolResultValid('get_market_data', result)).toBe(false);
  });

  it('空オブジェクト → 無効', () => {
    const result = JSON.stringify({ data: {} });
    expect(isToolResultValid('get_market_data', result)).toBe(false);
  });

  it('data null → 無効', () => {
    const result = JSON.stringify({ data: null });
    expect(isToolResultValid('get_market_data', result)).toBe(false);
  });

  it('有効なquote/newsデータ → 有効', () => {
    const result = JSON.stringify({ data: { price: 177.39, change: -6.07, volume: 12345678 } });
    expect(isToolResultValid('get_market_data', result)).toBe(true);
  });

  it('有効なfinancialsデータ → 有効', () => {
    const result = JSON.stringify({ data: { revenue: '416.2B', pe_ratio: 36 } });
    expect(isToolResultValid('get_financials', result)).toBe(true);
  });

  it('空文字列 → 無効', () => {
    expect(isToolResultValid('web_search', '')).toBe(false);
  });
});

describe('RecommendationEvidenceGuard (結果中身ベース)', () => {
  it('memory_searchのみ成功 + current data失敗 → evidence不足', () => {
    const result = checkRecommendationEvidence(
      [{ tool: 'memory_search', result: JSON.stringify({ data: { results: ['user likes growth'] } }) }],
      ['get_market_data', 'web_search'],
    );
    expect(result.hasCurrentDataEvidence).toBe(false);
    expect(result.hasSufficientEvidence).toBe(false);
    expect(result.hasOnlyMemoryEvidence).toBe(true);
  });

  it('get_market_dataが有効データを返した → evidence 1件（不十分）', () => {
    const result = checkRecommendationEvidence(
      [
        { tool: 'memory_search', result: JSON.stringify({ data: { results: [] } }) },
        { tool: 'get_market_data', result: JSON.stringify({ data: { price: 177, news: ['headline'] } }) },
      ],
      [],
    );
    expect(result.hasCurrentDataEvidence).toBe(true);
    expect(result.hasSufficientEvidence).toBe(false); // 1件では不十分
    expect(result.validCurrentToolCount).toBe(1);
  });

  it('2件の有効current dataツール → 十分', () => {
    const result = checkRecommendationEvidence(
      [
        { tool: 'get_market_data', result: JSON.stringify({ data: { price: 177 } }) },
        { tool: 'web_search', result: JSON.stringify({ data: { results: ['news article'] } }) },
      ],
      [],
    );
    expect(result.hasSufficientEvidence).toBe(true);
    expect(result.validCurrentToolCount).toBe(2);
  });

  it('get_market_dataがtool_endだが中身は_errorsのみ → evidence不足', () => {
    const result = checkRecommendationEvidence(
      [{ tool: 'get_market_data', result: JSON.stringify({ data: { _errors: ['API rate limited'] } }) }],
      [],
    );
    expect(result.hasCurrentDataEvidence).toBe(false);
    expect(result.hasSufficientEvidence).toBe(false);
    expect(result.invalidCurrentTools).toEqual(['get_market_data']);
  });
});

describe('containsPersonalizationExpressions', () => {
  it('「あなた向け」を検出', () => {
    expect(containsPersonalizationExpressions('あなた向けの銘柄として以下を推薦します')).toBe(true);
  });

  it('「過去履歴」を検出', () => {
    expect(containsPersonalizationExpressions('過去履歴を見ると成長株が好みのようです')).toBe(true);
  });

  it('「好みに合う」を検出', () => {
    expect(containsPersonalizationExpressions('好みに合う銘柄を選びました')).toBe(true);
  });

  it('通常の分析文はパスする', () => {
    expect(containsPersonalizationExpressions('NVDAは現在PER36倍で、営業利益率65.6%です')).toBe(false);
  });
});

describe('buildEvidenceInsufficientResponse', () => {
  it('フォールバック回答に推薦控えメッセージが含まれる', () => {
    const evidence = checkRecommendationEvidence(
      [{ tool: 'memory_search', result: JSON.stringify({ data: {} }) }],
      ['get_market_data'],
    );
    const response = buildEvidenceInsufficientResponse(evidence);
    expect(response).toContain('具体的な銘柄推薦は控えます');
  });
});

describe('Personalized query with current data failure', () => {
  it('「私の好み込みで今日の3銘柄」でもcurrent data全滅なら推薦禁止', () => {
    const intent = classifyRecommendationIntent('私の好み込みで今日の3銘柄を選んで');
    expect(intent.isTimeSensitive).toBe(true);
    expect(intent.isExplicitlyPersonalized).toBe(true);

    const evidence = checkRecommendationEvidence(
      [{ tool: 'memory_search', result: JSON.stringify({ data: { results: ['growth OK'] } }) }],
      ['get_market_data', 'web_search'],
    );
    // even explicitly personalized, insufficient evidence should block
    expect(evidence.hasSufficientEvidence).toBe(false);
  });
});
