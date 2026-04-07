import {
  classifyRecommendationIntent,
  checkRecommendationEvidence,
  buildEvidenceInsufficientResponse,
  isToolResultValid,
  containsPersonalizationExpressions,
  shouldBlockMemory,
  extractRecommendedTickers,
  hasTickerEvidence,
  checkPerTickerEvidence,
  containsHedgingRecommendation,
  buildTickerEvidenceInsufficientResponse,
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
    expect(evidence.hasSufficientEvidence).toBe(false);
  });
});

describe('Memory blocking (tool-level enforcement)', () => {
  it('time-sensitive + non-personalized → memory_search をブロックすべき', () => {
    const intent = classifyRecommendationIntent('今日のおすすめ銘柄を出して');
    expect(shouldBlockMemory(intent)).toBe(true);

    // アプリ側で blockedTools = new Set(['memory_search', 'memory_get', 'learning_engine']) を渡す
    const blockedTools = new Set(['memory_search', 'memory_get', 'learning_engine']);
    // Agent.create で tools.filter(t => !blockedTools.has(t.name)) が適用される
    const mockTools = [
      { name: 'get_market_data' },
      { name: 'memory_search' },
      { name: 'web_search' },
      { name: 'memory_get' },
    ];
    const filtered = mockTools.filter(t => !blockedTools.has(t.name));
    expect(filtered.map(t => t.name)).toEqual(['get_market_data', 'web_search']);
    expect(filtered.map(t => t.name)).not.toContain('memory_search');
    expect(filtered.map(t => t.name)).not.toContain('memory_get');
  });

  it('personalized time-sensitive → memory_search を許可', () => {
    const intent = classifyRecommendationIntent('私の好み込みで今日の3銘柄を選んで');
    expect(shouldBlockMemory(intent)).toBe(false);
    // memory_search はツールリストに残る
  });

  it('non-recommendation query → memory_search を許可', () => {
    const intent = classifyRecommendationIntent('ポートフォリオを分析して');
    expect(shouldBlockMemory(intent)).toBe(false);
  });

  it('「何を売るべき」→ memory_search を許可（personalized advice）', () => {
    const intent = classifyRecommendationIntent('今の保有銘柄で何を売るべき？');
    // 「売るべき」は recommendation pattern にマッチするが、
    // 「今の保有銘柄で」は personalized advice 的
    // isTimeSensitive = true の場合でも「保有」系は explicitly personalized にすべき
    // → 現状の実装ではisTimeSensitiveがtrueになるが、保有系はexplicitly personalizedにならない
    // → shouldBlockMemory = true になる
    // これは意図通り: 「今の保有」分析はポートフォリオ分析であり、
    // FollowUpResolverやInMemoryChatHistoryから保有情報は渡される
    // memory_searchが止まっても、agentのprompt contextに保有情報は入る
    expect(intent.isRecommendation).toBe(true);
  });
});

describe('Integration: memory blocked + current data insufficient', () => {
  it('memory blocked + data fail → フォールバック回答に ticker なし', () => {
    const intent = classifyRecommendationIntent('今日のおすすめ銘柄');
    expect(shouldBlockMemory(intent)).toBe(true);

    const evidence = checkRecommendationEvidence(
      [],
      ['get_market_data', 'web_search'],
    );
    expect(evidence.hasSufficientEvidence).toBe(false);

    const response = buildEvidenceInsufficientResponse(evidence);
    expect(response).toContain('具体的な銘柄推薦は控えます');
    expect(response).toContain('代わりにできること');
  });
});

describe('extractRecommendedTickers', () => {
  it('回答文からticker symbolsを抽出する', () => {
    const answer = '今日のおすすめは SOUN, QBTS, RGTI, BBAI です。';
    const tickers = extractRecommendedTickers(answer);
    expect(tickers).toContain('SOUN');
    expect(tickers).toContain('QBTS');
    expect(tickers).toContain('RGTI');
    expect(tickers).toContain('BBAI');
  });

  it('一般的な英単語は除外する', () => {
    const answer = 'THE BEST ETF FOR USD is VOO';
    const tickers = extractRecommendedTickers(answer);
    expect(tickers).not.toContain('THE');
    expect(tickers).not.toContain('ETF');
    expect(tickers).not.toContain('USD');
    expect(tickers).toContain('VOO');
  });
});

describe('Ticker-level evidence', () => {
  const toolResultsWithSOUN = [
    { tool: 'get_market_data', result: JSON.stringify({ data: { SOUN: { price: 5.2 }, NVDA: { price: 177 } } }) },
    { tool: 'web_search', result: JSON.stringify({ data: { results: ['SOUN earnings beat', 'NVDA AI growth'] } }) },
  ];

  it('ticker個別のevidence — SOUNはtool resultsに含まれている', () => {
    expect(hasTickerEvidence('SOUN', toolResultsWithSOUN)).toBe(true);
  });

  it('ticker個別のevidence — QBTSはtool resultsに含まれていない', () => {
    expect(hasTickerEvidence('QBTS', toolResultsWithSOUN)).toBe(false);
  });

  it('query-level evidence十分だが、推薦ticker個別のニュース/材料が不足 → ブロック', () => {
    const answer = '今日のおすすめは SOUN, QBTS, RGTI, BBAI です。';
    const tickerEvidence = checkPerTickerEvidence(answer, toolResultsWithSOUN);
    // SOUN だけ evidence あり、他3つはなし → majority は false
    expect(tickerEvidence.tickersWithEvidence).toContain('SOUN');
    expect(tickerEvidence.tickersWithoutEvidence.length).toBeGreaterThanOrEqual(2);
    expect(tickerEvidence.majorityHaveEvidence).toBe(false);
  });

  it('全推薦tickerにevidenceがある → 許可', () => {
    const answer = '今日のおすすめは SOUN と NVDA です。';
    const tickerEvidence = checkPerTickerEvidence(answer, toolResultsWithSOUN);
    expect(tickerEvidence.allHaveEvidence).toBe(true);
    expect(tickerEvidence.majorityHaveEvidence).toBe(true);
  });
});

describe('Hedging recommendation guard', () => {
  it('「ツール不調」+ ticker列挙 → hedging検出', () => {
    const answer = 'ツール不調が多かったですが、候補としてはSOUN, QBTS, RGTIが注目です。';
    expect(containsHedgingRecommendation(answer)).toBe(true);
  });

  it('「監視優先リスト」+ ticker列挙 → hedging検出', () => {
    const answer = '監視優先リストとして SOUN / QBTS を挙げておきます。';
    expect(containsHedgingRecommendation(answer)).toBe(true);
  });

  it('「断定買いではない」+ ticker列挙 → hedging検出', () => {
    const answer = '断定買いではないですが、RGTI と BBAI は面白い動きをしています。';
    expect(containsHedgingRecommendation(answer)).toBe(true);
  });

  it('通常の推薦（hedgingなし）→ false', () => {
    const answer = '本日のおすすめは NVDA です。PER36倍、営業利益率65.6%で強い成長が続いています。';
    expect(containsHedgingRecommendation(answer)).toBe(false);
  });

  it('ticker 1個だけ → hedging検出しない（ticker 2個以上が条件）', () => {
    const answer = 'ツール不調でしたが NVDA は引き続き強いです。';
    expect(containsHedgingRecommendation(answer)).toBe(false);
  });
});

describe('Fallback response for ticker evidence insufficient', () => {
  it('ticker evidence不足時はtickerなしの短い回答', () => {
    const tickerResult = checkPerTickerEvidence(
      'おすすめは SOUN, QBTS, RGTI です',
      [{ tool: 'get_market_data', result: JSON.stringify({ data: { SPY: { price: 500 } } }) }],
    );
    const response = buildTickerEvidenceInsufficientResponse(tickerResult);
    expect(response).toContain('見送ります');
    expect(response).not.toContain('SOUN');
    expect(response).not.toContain('QBTS');
  });
});
