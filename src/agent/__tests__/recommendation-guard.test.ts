import {
  classifyRecommendationIntent,
  checkRecommendationEvidence,
  buildEvidenceInsufficientResponse,
} from '../recommendation-guard.js';

describe('RecommendationIntentClassifier', () => {
  it('「今日のおすすめ銘柄」を時点依存推薦と判定', () => {
    const result = classifyRecommendationIntent('今日のおすすめ銘柄を出して');
    expect(result.isRecommendation).toBe(true);
    expect(result.isTimeSensitive).toBe(true);
  });

  it('「4/7のおすすめ株」を時点依存推薦と判定', () => {
    const result = classifyRecommendationIntent('4/7のおすすめ株を教えて');
    expect(result.isRecommendation).toBe(true);
    expect(result.isTimeSensitive).toBe(true);
  });

  it('「今買うべき銘柄」を時点依存推薦と判定', () => {
    const result = classifyRecommendationIntent('今買うべき銘柄は？');
    expect(result.isRecommendation).toBe(true);
    expect(result.isTimeSensitive).toBe(true);
  });

  it('「儲かりそうなやつ」を推薦と判定（時点キーワードなしだがisRecommendation）', () => {
    const result = classifyRecommendationIntent('儲かりそうなやつ教えて');
    expect(result.isRecommendation).toBe(true);
  });

  it('「latest top picks」を時点依存推薦と判定', () => {
    const result = classifyRecommendationIntent('latest top picks today');
    expect(result.isRecommendation).toBe(true);
    expect(result.isTimeSensitive).toBe(true);
  });

  it('「ポートフォリオを分析して」は推薦ではない', () => {
    const result = classifyRecommendationIntent('ポートフォリオを分析して');
    expect(result.isRecommendation).toBe(false);
    expect(result.isTimeSensitive).toBe(false);
  });

  it('「NVDAの財務を分析して」は推薦ではない', () => {
    const result = classifyRecommendationIntent('NVDAの財務を分析して');
    expect(result.isRecommendation).toBe(false);
  });
});

describe('RecommendationEvidenceGuard', () => {
  it('memory_searchのみ成功 + current data失敗 → hasOnlyMemoryEvidence', () => {
    const result = checkRecommendationEvidence(
      ['memory_search'],
      ['get_market_data', 'web_search'],
    );
    expect(result.hasCurrentDataEvidence).toBe(false);
    expect(result.hasOnlyMemoryEvidence).toBe(true);
    expect(result.succeededMemoryTools).toEqual(['memory_search']);
    expect(result.failedTools).toEqual(['get_market_data', 'web_search']);
  });

  it('get_market_data成功 → hasCurrentDataEvidence', () => {
    const result = checkRecommendationEvidence(
      ['memory_search', 'get_market_data'],
      [],
    );
    expect(result.hasCurrentDataEvidence).toBe(true);
    expect(result.hasOnlyMemoryEvidence).toBe(false);
  });

  it('web_search + stock_screener成功 → hasCurrentDataEvidence', () => {
    const result = checkRecommendationEvidence(
      ['web_search', 'stock_screener'],
      [],
    );
    expect(result.hasCurrentDataEvidence).toBe(true);
  });

  it('何も成功していない → 両方false', () => {
    const result = checkRecommendationEvidence(
      [],
      ['get_market_data'],
    );
    expect(result.hasCurrentDataEvidence).toBe(false);
    expect(result.hasOnlyMemoryEvidence).toBe(false);
  });
});

describe('buildEvidenceInsufficientResponse', () => {
  it('フォールバック回答にデータ不足メッセージが含まれる', () => {
    const evidence = checkRecommendationEvidence(
      ['memory_search'],
      ['get_market_data', 'finnhub_news'],
    );
    const response = buildEvidenceInsufficientResponse(evidence);
    expect(response).toContain('具体的な銘柄推薦は控えます');
    expect(response).toContain('get_market_data');
  });

  it('memory補足メッセージが含まれる', () => {
    const evidence = checkRecommendationEvidence(
      ['memory_search'],
      ['web_search'],
    );
    const response = buildEvidenceInsufficientResponse(evidence);
    expect(response).toContain('過去の好み');
  });
});
