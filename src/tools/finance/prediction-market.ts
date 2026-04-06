/**
 * 予測市場ツール — Polymarket/Kalshi のパブリックAPIから
 * 経済・政治イベントのオッズ（確率）を取得
 *
 * 金利決定、選挙、地政学イベント等の市場予測をFinxの分析に活用
 * APIキー不要（パブリックエンドポイント）
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

// Polymarket CLOB API (パブリック)
const POLYMARKET_API = 'https://clob.polymarket.com';
// Kalshi パブリックAPI
const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';

interface PolymarketEvent {
  title: string;
  slug: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  endDate: string;
  active: boolean;
}

interface KalshiMarket {
  title: string;
  ticker: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  volume: number;
  close_time: string;
  status: string;
  category: string;
}

/**
 * Polymarketからイベント検索
 */
async function searchPolymarket(query: string, limit: number = 10): Promise<PolymarketEvent[]> {
  try {
    const url = `https://gamma-api.polymarket.com/events?closed=false&limit=${limit}&title=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return [];
    const data = await res.json() as any[];

    return data.map((e: any) => ({
      title: e.title ?? '',
      slug: e.slug ?? '',
      outcomes: (e.markets ?? []).flatMap((m: any) => m.outcomes ? JSON.parse(m.outcomes) : []),
      outcomePrices: (e.markets ?? []).flatMap((m: any) => m.outcomePrices ? JSON.parse(m.outcomePrices) : []),
      volume: e.volume ?? '0',
      endDate: e.endDate ?? '',
      active: e.active ?? false,
    }));
  } catch {
    return [];
  }
}

/**
 * Kalshiからマーケット検索
 */
async function searchKalshi(query: string, limit: number = 10): Promise<KalshiMarket[]> {
  try {
    const url = `${KALSHI_API}/markets?limit=${limit}&status=open`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    const markets = data.markets ?? [];

    const q = query.toLowerCase();
    return markets
      .filter((m: any) => (m.title ?? '').toLowerCase().includes(q) || (m.category ?? '').toLowerCase().includes(q))
      .slice(0, limit)
      .map((m: any) => ({
        title: m.title ?? '',
        ticker: m.ticker ?? '',
        yes_bid: m.yes_bid ?? 0,
        yes_ask: m.yes_ask ?? 0,
        no_bid: m.no_bid ?? 0,
        no_ask: m.no_ask ?? 0,
        volume: m.volume ?? 0,
        close_time: m.close_time ?? '',
        status: m.status ?? '',
        category: m.category ?? '',
      }));
  } catch {
    return [];
  }
}

/**
 * 結果を読みやすくフォーマット
 */
function formatResults(polyResults: PolymarketEvent[], kalshiResults: KalshiMarket[]): Record<string, unknown> {
  const formatted: Record<string, unknown> = {};

  if (polyResults.length > 0) {
    formatted.polymarket = polyResults.map(e => {
      const odds: Record<string, string> = {};
      for (let i = 0; i < e.outcomes.length; i++) {
        const price = parseFloat(e.outcomePrices[i] ?? '0');
        odds[e.outcomes[i]] = `${(price * 100).toFixed(1)}%`;
      }
      return {
        title: e.title,
        odds,
        volume: `$${parseFloat(e.volume).toLocaleString()}`,
        endDate: e.endDate ? new Date(e.endDate).toLocaleDateString() : 'N/A',
        url: `https://polymarket.com/event/${e.slug}`,
      };
    });
  }

  if (kalshiResults.length > 0) {
    formatted.kalshi = kalshiResults.map(m => ({
      title: m.title,
      ticker: m.ticker,
      yesProbability: `${(m.yes_bid * 100).toFixed(0)}-${(m.yes_ask * 100).toFixed(0)}%`,
      noProbability: `${(m.no_bid * 100).toFixed(0)}-${(m.no_ask * 100).toFixed(0)}%`,
      volume: m.volume,
      closeTime: m.close_time ? new Date(m.close_time).toLocaleDateString() : 'N/A',
      category: m.category,
    }));
  }

  if (polyResults.length === 0 && kalshiResults.length === 0) {
    formatted.message = '該当する予測市場が見つかりませんでした。キーワードを変えて試してください（例: "Fed", "rate", "election", "GDP"）';
  }

  return formatted;
}

export const predictionMarketTool = new DynamicStructuredTool({
  name: 'prediction_market',
  description: 'Search prediction markets (Polymarket, Kalshi) for event odds/probabilities. Useful for Fed rate decisions, elections, geopolitical events, economic indicators. Returns market-implied probabilities.',
  schema: z.object({
    query: z.string().describe("Search query. Examples: 'Fed rate cut', 'US election', 'recession 2026', 'CPI', 'tariff'"),
    limit: z.number().optional().default(5).describe('Max results per platform (default: 5)'),
  }),
  func: async (input) => {
    const [polyResults, kalshiResults] = await Promise.all([
      searchPolymarket(input.query, input.limit),
      searchKalshi(input.query, input.limit),
    ]);

    const formatted = formatResults(polyResults, kalshiResults);
    return formatToolResult(formatted);
  },
});

export const PREDICTION_MARKET_DESCRIPTION = `Searches Polymarket and Kalshi prediction markets for event probabilities.
Use for: Fed rate decisions, elections, GDP forecasts, geopolitical events, tariff odds, recession probability.
Returns market-implied probabilities (crowd-sourced forecasts).
No API key required — uses public endpoints.
Examples: "Fed rate cut June", "US recession 2026", "CPI above 3%", "tariff China"
Combine with macro analysis for more informed investment decisions.`;
