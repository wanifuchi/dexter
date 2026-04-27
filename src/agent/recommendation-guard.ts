/**
 * Recommendation Guard — 時点依存の推薦クエリで不十分なデータによる推薦を防止
 *
 * 3層のガード:
 * 1. Intent Classification: クエリが時点依存の推薦か判定
 * 2. Evidence Guard: ツール結果の中身を検査し、有効なcurrent dataがあるか判定
 * 3. Final Answer Guard: 回答文にpersonalization表現が混ざっていないか検査
 */

// === Intent Classification ===

const TIME_SENSITIVE_PATTERNS = [
  /今日/, /本日/, /今(?!の保有|の)/, /直近/, /最新/, /最近/,
  /\d{1,2}\/\d{1,2}/,
  /\d{4}[\-\/]\d{1,2}[\-\/]\d{1,2}/,
  /today/i, /latest/i, /current/i, /right now/i, /this week/i, /今週/,
];

const RECOMMENDATION_PATTERNS = [
  /おすすめ/, /お勧め/, /推薦/, /選んで/,
  /教えて.*銘柄/, /銘柄.*教えて/,
  /買うべき/, /売るべき/, /儲かり/, /注目/, /狙い目/, /ピック/,
  /picks?/i, /recommend/i, /suggest/i, /what.*buy/i, /top.*stocks?/i, /best.*stocks?/i,
];

// ユーザーが明示的にpersonalizationを求めるパターン
const EXPLICIT_PERSONALIZATION_PATTERNS = [
  /好み.*込み/, /好み.*踏まえ/, /好み.*合わせ/,
  /過去.*会話.*踏まえ/, /過去.*踏まえ/,
  /ポートフォリオ.*合わせ/, /私の.*合わせ/,
  /自分の.*込み/, /自分の.*踏まえ/,
  /保有.*踏まえ/, /保有.*合わせ/,
];

export type RecommendationIntent = {
  isRecommendation: boolean;
  isTimeSensitive: boolean;
  isExplicitlyPersonalized: boolean;
};

export function classifyRecommendationIntent(query: string): RecommendationIntent {
  const isRecommendation = RECOMMENDATION_PATTERNS.some(p => p.test(query));
  const isTimeSensitive = TIME_SENSITIVE_PATTERNS.some(p => p.test(query));
  const isExplicitlyPersonalized = EXPLICIT_PERSONALIZATION_PATTERNS.some(p => p.test(query));

  return {
    isRecommendation,
    isTimeSensitive: isRecommendation && isTimeSensitive,
    isExplicitlyPersonalized,
  };
}

/**
 * time-sensitive recommendation で memory_search を使うべきでないか判定
 */
export function shouldBlockMemory(intent: RecommendationIntent): boolean {
  return intent.isTimeSensitive && !intent.isExplicitlyPersonalized;
}

// === Evidence Guard (結果の中身ベース) ===

const CURRENT_DATA_TOOLS = new Set([
  'get_market_data', 'get_financials', 'web_search', 'stock_screener',
  'prediction_market', 'prediction_market_history', 'fred_data', 'news_sentiment',
  'congress_trading', 'insider_trading', 'yahoo_quote', 'yahoo_chart',
  'finnhub_quote', 'finnhub_news', 'finnhub_recommendation', 'finnhub_price_target',
  'fmp_screener', 'fmp_profile', 'polygon_prev_close',
  'td_technicals', 'td_time_series', 'av_global_quote',
  'jp_stock_price', 'jp_screener',
]);

const MEMORY_ONLY_TOOLS = new Set([
  'memory_search', 'memory_get', 'memory_update', 'learning_engine',
]);

export type ToolCallResult = {
  tool: string;
  result: string;
};

/**
 * ツール結果の中身が実質的に有効なデータを含むか判定
 */
export function isToolResultValid(tool: string, resultStr: string): boolean {
  if (!resultStr || resultStr.trim().length === 0) return false;

  try {
    const parsed = JSON.parse(resultStr);
    const data = parsed?.data;

    // data が null/undefined
    if (data == null) return false;

    // data が空オブジェクト/空配列
    if (typeof data === 'object') {
      if (Array.isArray(data) && data.length === 0) return false;
      const keys = Object.keys(data);
      if (keys.length === 0) return false;

      // _errors のみ
      if (keys.length === 1 && keys[0] === '_errors') return false;
      // error のみ
      if (keys.length === 1 && keys[0] === 'error') return false;
      // 全プロパティが _errors
      if (keys.every(k => k === '_errors' || k.endsWith('_error'))) return false;

      // 値が全てnull/error
      const values = Object.values(data);
      if (values.every(v => v == null || (typeof v === 'object' && v !== null && '_errors' in (v as Record<string, unknown>)))) {
        return false;
      }
    }

    // 文字列の場合: error/failed が主内容
    if (typeof data === 'string') {
      const lower = data.toLowerCase();
      if (lower.includes('error') || lower.includes('failed') || lower.includes('not found')) {
        return false;
      }
    }

    return true;
  } catch {
    // JSONパース失敗 → 文字列として簡易チェック
    const lower = resultStr.toLowerCase();
    if (lower.includes('"error"') || lower.includes('"_errors"')) return false;
    return resultStr.trim().length > 50; // 短すぎるものはデータなし扱い
  }
}

export type EvidenceCheckResult = {
  hasCurrentDataEvidence: boolean;
  hasSufficientEvidence: boolean;
  hasOnlyMemoryEvidence: boolean;
  validCurrentToolCount: number;
  succeededMemoryTools: string[];
  failedTools: string[];
  invalidCurrentTools: string[];
};

/**
 * ツール呼び出し結果からevidence判定（結果の中身ベース）
 */
export function checkRecommendationEvidence(
  toolResults: ToolCallResult[],
  failedTools: string[],
): EvidenceCheckResult {
  const validCurrentTools: string[] = [];
  const invalidCurrentTools: string[] = [];
  const succeededMemoryTools: string[] = [];

  for (const { tool, result } of toolResults) {
    if (MEMORY_ONLY_TOOLS.has(tool)) {
      succeededMemoryTools.push(tool);
      continue;
    }
    if (CURRENT_DATA_TOOLS.has(tool)) {
      if (isToolResultValid(tool, result)) {
        validCurrentTools.push(tool);
      } else {
        invalidCurrentTools.push(tool);
      }
    }
  }

  const validCount = validCurrentTools.length;
  const hasCurrentDataEvidence = validCount > 0;
  // 閾値: 有効結果2件以上、または market/news 1件 + financial/search 1件
  const hasSufficientEvidence = validCount >= 2;
  const hasOnlyMemoryEvidence = !hasCurrentDataEvidence && succeededMemoryTools.length > 0;

  return {
    hasCurrentDataEvidence,
    hasSufficientEvidence,
    hasOnlyMemoryEvidence,
    validCurrentToolCount: validCount,
    succeededMemoryTools,
    failedTools,
    invalidCurrentTools,
  };
}

// === Final Answer Guard ===

const PERSONALIZATION_EXPRESSIONS = [
  /あなた向け/,
  /あなたの好み/,
  /過去(?:の)?履歴/,
  /好みに合[うい]/,
  /これまでの会話/,
  /以前.*好(?:き|んで)/,
  /あなた(?:は|が).*好(?:き|み)/,
  /過去.*嗜好/,
  /ユーザー.*嗜好/,
  /your preference/i,
  /based on your history/i,
];

/**
 * 回答文にpersonalization表現が含まれているか検査
 */
export function containsPersonalizationExpressions(answer: string): boolean {
  return PERSONALIZATION_EXPRESSIONS.some(p => p.test(answer));
}

// === Ticker-level Evidence Guard ===

// ティッカーシンボルを抽出（大文字1-5文字、$接頭辞対応）
const TICKER_PATTERN = /\$?([A-Z]{1,5})\b/g;

// ティッカーとして誤検出しやすい一般的な英単語を除外
const TICKER_EXCLUDE = new Set([
  'THE', 'FOR', 'AND', 'BUT', 'NOT', 'ARE', 'WAS', 'HAS', 'HAD', 'HAVE',
  'WITH', 'THIS', 'THAT', 'FROM', 'WILL', 'BEEN', 'EACH', 'SOME', 'SUCH',
  'ALL', 'ANY', 'CAN', 'MAY', 'NOW', 'HOW', 'WHO', 'WHY', 'TOP', 'NEW',
  'ONE', 'TWO', 'DAY', 'BUY', 'ETF', 'IPO', 'CEO', 'CFO', 'EPS', 'RSI',
  'GDP', 'CPI', 'FED', 'SEC', 'USA', 'NYSE', 'API', 'URL', 'SSE', 'OK',
  'VS', 'PE', 'PB', 'ROE', 'ROA', 'ADR', 'NISA', 'SBI',
  'MAX', 'MIN', 'AVG', 'USD', 'JPY', 'EUR', 'GBP',
  'BULL', 'BEAR', 'LONG', 'SHORT', 'HOLD', 'SELL',
]);

/**
 * 回答文から推薦ティッカーを抽出
 */
export function extractRecommendedTickers(answer: string): string[] {
  const tickers = new Set<string>();
  let match: RegExpExecArray | null;
  TICKER_PATTERN.lastIndex = 0;
  while ((match = TICKER_PATTERN.exec(answer)) !== null) {
    const t = match[1];
    if (!TICKER_EXCLUDE.has(t) && t.length >= 2) {
      tickers.add(t);
    }
  }
  return [...tickers];
}

/**
 * 特定のtickerに関するevidenceがtool resultsに含まれるか判定
 */
export function hasTickerEvidence(ticker: string, toolResults: ToolCallResult[]): boolean {
  const t = ticker.toUpperCase();
  for (const { tool, result } of toolResults) {
    if (MEMORY_ONLY_TOOLS.has(tool)) continue;
    if (!CURRENT_DATA_TOOLS.has(tool)) continue;
    if (!isToolResultValid(tool, result)) continue;

    // tool result にこの ticker が含まれているか
    const upper = result.toUpperCase();
    if (upper.includes(t)) return true;
  }
  return false;
}

export type TickerEvidenceResult = {
  totalTickers: number;
  tickersWithEvidence: string[];
  tickersWithoutEvidence: string[];
  allHaveEvidence: boolean;
  majorityHaveEvidence: boolean;
};

/**
 * 推薦された各tickerにper-ticker evidenceがあるか判定
 */
export function checkPerTickerEvidence(
  answer: string,
  toolResults: ToolCallResult[],
): TickerEvidenceResult {
  const tickers = extractRecommendedTickers(answer);
  const withEvidence: string[] = [];
  const withoutEvidence: string[] = [];

  for (const ticker of tickers) {
    if (hasTickerEvidence(ticker, toolResults)) {
      withEvidence.push(ticker);
    } else {
      withoutEvidence.push(ticker);
    }
  }

  const total = tickers.length;
  return {
    totalTickers: total,
    tickersWithEvidence: withEvidence,
    tickersWithoutEvidence: withoutEvidence,
    allHaveEvidence: total > 0 && withoutEvidence.length === 0,
    majorityHaveEvidence: total > 0 && withEvidence.length > total / 2,
  };
}

// === Hedging Recommendation Guard ===

const HEDGING_PATTERNS = [
  /ツール不調/,
  /裏取り不足/,
  /監視優先/,
  /断定買いではない/,
  /十分な定量裏取りがない/,
  /候補というより/,
  /データが不十分.*(?:だが|ですが|けど).*(?:候補|銘柄|ティッカー)/,
  /不十分.*(?:だが|ですが).*(?:挙げ|出し|リスト)/,
  /十分.*検証.*でき(?:てい)?ない.*(?:が|けど)/,
  /裏付け.*(?:取れ|でき)(?:てい)?ない/,
  /あくまで.*(?:候補|参考|モニタリング)/,
  /tool.*(?:fail|error|issue)/i,
  /insufficient.*data.*(?:but|however)/i,
];

/**
 * 回答が「言い訳しながらticker推薦」しているか検出
 */
export function containsHedgingRecommendation(answer: string): boolean {
  const hasTickers = extractRecommendedTickers(answer).length >= 2;
  if (!hasTickers) return false;
  return HEDGING_PATTERNS.some(p => p.test(answer));
}

/**
 * Ticker-level evidence不足時のfallback
 */
export function buildTickerEvidenceInsufficientResponse(
  tickerResult: TickerEvidenceResult,
): string {
  return '今回は推薦候補の個別銘柄について十分な最新データ（価格・ニュース・材料）を取得できなかったため、具体的な銘柄推薦は見送ります。\n\n特定の銘柄を指定して分析を依頼するか、条件を指定してスクリーニングしてください。';
}

/**
 * evidence不足時のフォールバック回答を生成
 */
export function buildEvidenceInsufficientResponse(evidence: EvidenceCheckResult): string {
  const parts: string[] = [];
  parts.push('今回は最新の市場データ/ニュースを十分に取得できなかったため、具体的な銘柄推薦は控えます。');
  parts.push('');

  const allFailed = [...evidence.failedTools, ...evidence.invalidCurrentTools];
  if (allFailed.length > 0) {
    const unique = [...new Set(allFailed)];
    parts.push(`**取得に失敗/不十分だったデータ:** ${unique.slice(0, 5).join(', ')}`);
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
