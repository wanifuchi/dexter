/**
 * 予測市場ツール — Polymarket のパブリックAPIから
 * 経済・政治イベントのオッズ（確率）を取得
 *
 * 金利決定、選挙、地政学イベント等の市場予測をFinxの分析に活用
 * APIキー不要（パブリックエンドポイント）
 *
 * 注意: Polymarket gamma APIのtitle検索パラメータは機能しないため、
 * volume順で大量取得→ローカルでキーワードフィルタする方式を採用
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';

// 検索キーワードの同義語マッピング（日本語→英語対応）
const KEYWORD_ALIASES: Record<string, string[]> = {
  'fed': ['fed', 'federal reserve', 'fomc', 'interest rate', 'rate cut', 'rate hike', 'funds rate'],
  'frb': ['fed', 'federal reserve', 'fomc', 'interest rate', 'rate cut', 'rate hike', 'funds rate'],
  '利下げ': ['fed', 'rate cut', 'interest rate', 'fomc', 'funds rate', 'decrease'],
  '利上げ': ['fed', 'rate hike', 'interest rate', 'fomc', 'funds rate', 'increase'],
  '金利': ['fed', 'interest rate', 'fomc', 'funds rate', 'rate cut', 'rate hike'],
  'fomc': ['fed', 'fomc', 'interest rate', 'rate cut', 'funds rate'],
  'rate': ['fed', 'interest rate', 'rate cut', 'rate hike', 'funds rate'],
  'recession': ['recession', 'gdp', 'economic'],
  '景気後退': ['recession', 'gdp', 'economic'],
  '不況': ['recession', 'gdp', 'economic'],
  'inflation': ['inflation', 'cpi', 'pce'],
  'インフレ': ['inflation', 'cpi', 'pce'],
  'cpi': ['inflation', 'cpi', 'pce'],
  'tariff': ['tariff', 'trade war', 'china', 'trade'],
  '関税': ['tariff', 'trade war', 'china', 'trade'],
  'election': ['election', 'president', 'vote', 'congress'],
  '選挙': ['election', 'president', 'vote'],
  '大統領': ['president', 'election', 'trump', 'biden'],
  'gdp': ['gdp', 'economic', 'recession', 'growth'],
  'war': ['war', 'military', 'conflict', 'invasion'],
  '戦争': ['war', 'military', 'conflict', 'invasion'],
};

interface MarketResult {
  question: string;
  outcomes: string[];
  prices: string[];
  volume: number;
  endDate: string;
  slug: string;
}

/**
 * クエリからフィルタ用キーワードリストを生成
 * Polymarketは英語なので、日本語トークンは同義語展開のみに使い、
 * 最終的なキーワードリストには英語のみを含める
 */
function expandKeywords(query: string): string[] {
  const q = query.toLowerCase();
  const keywords = new Set<string>();

  // 同義語展開（日本語→英語変換の要）
  for (const [trigger, aliases] of Object.entries(KEYWORD_ALIASES)) {
    if (q.includes(trigger)) {
      for (const a of aliases) keywords.add(a);
    }
  }

  // 英語トークンのみ追加（日本語・記号は除外）
  // Polymarketのデータは全て英語なので、ASCII文字のみ有効
  for (const token of q.split(/\s+/)) {
    if (token.length >= 2 && /^[a-z0-9]+$/i.test(token)) {
      keywords.add(token);
    }
  }

  return [...keywords];
}

/**
 * Polymarketからvolume順で大量取得し、キーワードでフィルタ
 */
async function searchPolymarket(query: string, limit: number): Promise<MarketResult[]> {
  try {
    // volume順で上位200イベントを取得（APIの検索パラメータは機能しないため）
    const url = `${GAMMA_API}/events?closed=false&order=volume&ascending=false&limit=200`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return [];
    const events = await res.json() as any[];

    const keywords = expandKeywords(query);

    // キーワードが空なら検索不可（日本語のみのクエリで同義語にもヒットしない場合）
    if (keywords.length === 0) return [];

    const results: MarketResult[] = [];

    for (const event of events) {
      const markets = event.markets ?? [];
      const eventTitle = (event.title ?? '').toLowerCase();
      const eventSlug = event.slug ?? '';

      // イベントレベルでキーワードマッチ
      const eventMatches = keywords.some(k => eventTitle.includes(k));

      for (const market of markets) {
        const question = (market.question ?? '').toLowerCase();
        const matches = eventMatches || keywords.some(k => question.includes(k));

        if (!matches) continue;

        let outcomes: string[] = [];
        let prices: string[] = [];
        try {
          outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : (market.outcomes ?? []);
          prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : (market.outcomePrices ?? []);
        } catch { continue; }

        // 価格データがないものはスキップ
        if (prices.length === 0 || prices.every((p: string) => !p)) continue;

        results.push({
          question: market.question ?? event.title ?? '',
          outcomes,
          prices,
          volume: parseFloat(event.volume ?? '0'),
          endDate: market.endDate ?? event.endDate ?? '',
          slug: eventSlug,
        });
      }
    }

    // volume順で上位を返す
    return results
      .sort((a, b) => b.volume - a.volume)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 結果をフォーマット
 */
function formatResults(markets: MarketResult[]): Record<string, unknown> {
  if (markets.length === 0) {
    return {
      message: '該当する予測市場が見つかりませんでした。別のキーワードを試してください。',
      suggestions: ['Fed rate', 'recession', 'tariff', 'election', 'inflation CPI'],
    };
  }

  return {
    markets: markets.map(m => {
      const odds: Record<string, string> = {};
      for (let i = 0; i < m.outcomes.length; i++) {
        const price = parseFloat(m.prices[i] ?? '0');
        if (price > 0) {
          odds[m.outcomes[i]] = `${(price * 100).toFixed(1)}%`;
        }
      }
      return {
        question: m.question,
        odds,
        volume: `$${m.volume.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        endDate: m.endDate ? new Date(m.endDate).toLocaleDateString('ja-JP') : 'N/A',
        url: `https://polymarket.com/event/${m.slug}`,
      };
    }),
    source: 'Polymarket（予測市場 — 群衆の予測確率）',
    note: '予測市場の確率は賭けに基づく市場参加者のコンセンサスであり、確定予測ではありません。CME FedWatch等の先物市場の織り込みと併せて参考にしてください。',
  };
}

export const predictionMarketTool = new DynamicStructuredTool({
  name: 'prediction_market',
  description: 'Search Polymarket prediction markets for event odds/probabilities. Useful for Fed rate decisions, elections, geopolitical events, economic indicators. Returns market-implied probabilities.',
  schema: z.object({
    query: z.string().describe("Search query. Examples: 'Fed rate cut', 'election', 'recession', 'CPI inflation', 'tariff'. Japanese queries also supported: '利下げ', '景気後退', '関税'"),
    limit: z.number().optional().default(10).describe('Max results to return (default: 10)'),
  }),
  func: async (input) => {
    const markets = await searchPolymarket(input.query, input.limit ?? 10);
    const formatted = formatResults(markets);
    return formatToolResult(formatted);
  },
});

export const PREDICTION_MARKET_DESCRIPTION = `Searches Polymarket prediction markets for event probabilities.
Use for: Fed rate decisions, elections, GDP forecasts, geopolitical events, tariff odds, recession probability.
Returns market-implied probabilities (crowd-sourced forecasts).
No API key required — uses public endpoints.
Supports Japanese keywords: '利下げ', '利上げ', '景気後退', 'インフレ', '関税', '選挙'
Examples: "Fed rate cut", "recession 2026", "tariff China", "利下げ"
Combine with macro analysis for more informed investment decisions.`;
