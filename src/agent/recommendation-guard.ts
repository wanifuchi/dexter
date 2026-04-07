/**
 * Recommendation Guard — 時点依存の推薦クエリでmemory-onlyの推薦を防止
 *
 * 1. RecommendationIntentClassifier: クエリが時点依存の推薦要求か判定
 * 2. RecommendationEvidenceGuard: current data toolの成功を確認、不足時はブロック
 */

// === Intent Classification ===

// 時点依存キーワード（日本語 + 英語）
const TIME_SENSITIVE_PATTERNS = [
  /今日/,
  /本日/,
  /今/,
  /直近/,
  /最新/,
  /最近/,
  /\d{1,2}\/\d{1,2}/,         // 4/7 形式
  /\d{4}[\-\/]\d{1,2}[\-\/]\d{1,2}/, // 2026-04-07 形式
  /today/i,
  /latest/i,
  /current/i,
  /right now/i,
  /this week/i,
  /今週/,
];

// 推薦キーワード
const RECOMMENDATION_PATTERNS = [
  /おすすめ/,
  /お勧め/,
  /推薦/,
  /選んで/,
  /教えて.*銘柄/,
  /銘柄.*教えて/,
  /買うべき/,
  /売るべき/,
  /儲かり/,
  /注目/,
  /狙い目/,
  /ピック/,
  /picks?/i,
  /recommend/i,
  /suggest/i,
  /what.*buy/i,
  /top.*stocks?/i,
  /best.*stocks?/i,
];

export type RecommendationIntent = {
  isRecommendation: boolean;
  isTimeSensitive: boolean;
};

/**
 * クエリが時点依存の推薦要求かどうかを判定
 */
export function classifyRecommendationIntent(query: string): RecommendationIntent {
  const isRecommendation = RECOMMENDATION_PATTERNS.some(p => p.test(query));
  const isTimeSensitive = TIME_SENSITIVE_PATTERNS.some(p => p.test(query));

  return {
    isRecommendation,
    isTimeSensitive: isRecommendation && isTimeSensitive,
  };
}

// === Evidence Guard ===

// current data を提供するツール（これらの成功が推薦の根拠になる）
const CURRENT_DATA_TOOLS = new Set([
  'get_market_data',
  'get_financials',
  'web_search',
  'stock_screener',
  'prediction_market',
  'yahoo_quote',
  'yahoo_chart',
  'finnhub_quote',
  'finnhub_news',
  'finnhub_recommendation',
  'finnhub_price_target',
  'fmp_screener',
  'fmp_profile',
  'polygon_prev_close',
  'td_technicals',
  'td_time_series',
  'av_global_quote',
  'jp_stock_price',
  'jp_screener',
]);

// memory/preference系ツール（推薦の主根拠にしてはいけない）
const MEMORY_ONLY_TOOLS = new Set([
  'memory_search',
  'memory_get',
  'memory_update',
  'learning_engine',
]);

export type EvidenceCheckResult = {
  hasCurrentDataEvidence: boolean;
  hasOnlyMemoryEvidence: boolean;
  succeededCurrentTools: string[];
  succeededMemoryTools: string[];
  failedTools: string[];
};

/**
 * 成功/失敗したツール呼び出しからevidence判定
 */
export function checkRecommendationEvidence(
  succeededTools: string[],
  failedTools: string[],
): EvidenceCheckResult {
  const succeededCurrentTools = succeededTools.filter(t => CURRENT_DATA_TOOLS.has(t));
  const succeededMemoryTools = succeededTools.filter(t => MEMORY_ONLY_TOOLS.has(t));

  const hasCurrentDataEvidence = succeededCurrentTools.length > 0;
  const hasOnlyMemoryEvidence = !hasCurrentDataEvidence && succeededMemoryTools.length > 0;

  return {
    hasCurrentDataEvidence,
    hasOnlyMemoryEvidence,
    succeededCurrentTools,
    succeededMemoryTools,
    failedTools,
  };
}

/**
 * evidence不足時のフォールバック回答を生成
 */
export function buildEvidenceInsufficientResponse(evidence: EvidenceCheckResult): string {
  const parts: string[] = [];
  parts.push('今回は最新の市場データ/ニュースを十分に取得できなかったため、具体的な銘柄推薦は控えます。');
  parts.push('');

  if (evidence.failedTools.length > 0) {
    const uniqueFailed = [...new Set(evidence.failedTools)];
    parts.push(`**取得に失敗したデータ:** ${uniqueFailed.slice(0, 5).join(', ')}`);
  }

  if (evidence.succeededMemoryTools.length > 0) {
    parts.push('**補足:** あなたの過去の好みやリスク許容度は把握していますが、時点依存の推薦は最新データなしには出せません。');
  }

  parts.push('');
  parts.push('**代わりにできること:**');
  parts.push('- 特定の銘柄を指定して分析を依頼する（例: 「NVDAを分析して」）');
  parts.push('- ポートフォリオの現状評価を依頼する（例: 「今の保有銘柄を分析して」）');
  parts.push('- 条件を指定してスクリーニングする（例: 「配当利回り5%以上の銘柄」）');

  return parts.join('\n');
}
