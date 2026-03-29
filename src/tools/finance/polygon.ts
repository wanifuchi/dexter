/**
 * Polygon.io API - ティックデータ、集約バー、銘柄詳細
 * 無料枠: 5回/分
 * 環境変数: POLYGON_API_KEY
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const PG_BASE = 'https://api.polygon.io';

async function pgFetch(endpoint: string, params: Record<string, string>, label: string): Promise<unknown> {
  const apiKey = process.env.POLYGON_API_KEY || '';
  if (!apiKey) throw new Error('[Polygon] POLYGON_API_KEY not set');

  const url = new URL(`${PG_BASE}${endpoint}`);
  url.searchParams.set('apiKey', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`[Polygon] ${label}: ${response.status}`);
  return await response.json();
}

/**
 * Polygon 前日終値（全銘柄対応）
 */
export const polygonPrevClose = new DynamicStructuredTool({
  name: 'polygon_prev_close',
  description: 'Fetches previous day close price, volume, VWAP, and OHLC from Polygon.io. Works for all US-listed stocks and ETFs.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'CIFR'"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await pgFetch(`/v2/aggs/ticker/${ticker}/prev`, {}, `prev ${ticker}`) as Record<string, unknown>;

    const results = (data.results as Record<string, unknown>[]) ?? [];
    if (results.length === 0) {
      return formatToolResult({ error: `No Polygon data for ${ticker}` });
    }

    const r = results[0];
    return formatToolResult({
      ticker,
      close: r.c,
      open: r.o,
      high: r.h,
      low: r.l,
      volume: r.v,
      vwap: r.vw,
      trades: r.n,
      date: r.t ? new Date(r.t as number).toISOString().split('T')[0] : null,
    });
  },
});

/**
 * Polygon 集約バー（日足等）
 */
export const polygonAggregates = new DynamicStructuredTool({
  name: 'polygon_aggregates',
  description: 'Fetches aggregate bars (OHLCV) from Polygon.io over a date range. Supports minute, hour, day, week, month intervals.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol"),
    from: z.string().describe("Start date YYYY-MM-DD"),
    to: z.string().describe("End date YYYY-MM-DD"),
    timespan: z.enum(['minute', 'hour', 'day', 'week', 'month']).default('day'),
    multiplier: z.number().default(1).describe("Timespan multiplier, e.g. 5 with minute = 5min bars"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await pgFetch(
      `/v2/aggs/ticker/${ticker}/range/${input.multiplier}/${input.timespan}/${input.from}/${input.to}`,
      { limit: '50' },
      `aggs ${ticker}`,
    ) as Record<string, unknown>;

    const results = (data.results as Record<string, unknown>[]) ?? [];
    const bars = results.slice(0, 30).map((r) => ({
      date: r.t ? new Date(r.t as number).toISOString().split('T')[0] : null,
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
      vwap: r.vw,
    }));

    return formatToolResult({ ticker, count: bars.length, bars });
  },
});

/**
 * Polygon 銘柄詳細
 */
export const polygonTickerDetails = new DynamicStructuredTool({
  name: 'polygon_ticker_details',
  description: 'Fetches detailed ticker information from Polygon.io including company name, description, SIC code, share count, and market info.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await pgFetch(`/v3/reference/tickers/${ticker}`, {}, `details ${ticker}`) as Record<string, unknown>;

    const r = (data.results as Record<string, unknown>) ?? {};
    return formatToolResult({
      ticker: r.ticker,
      name: r.name,
      market: r.market,
      locale: r.locale,
      type: r.type,
      currency: r.currency_name,
      description: typeof r.description === 'string' ? (r.description as string).slice(0, 300) : null,
      sicCode: r.sic_code,
      sicDescription: r.sic_description,
      totalEmployees: r.total_employees,
      listDate: r.list_date,
      shareClassSharesOutstanding: r.share_class_shares_outstanding,
      weightedSharesOutstanding: r.weighted_shares_outstanding,
      homepage: r.homepage_url,
    });
  },
});

export const POLYGON_PREV_CLOSE_DESCRIPTION = `Fetches previous day OHLCV + VWAP from Polygon.io. Reliable price data for all US stocks/ETFs.`;
export const POLYGON_AGGREGATES_DESCRIPTION = `Fetches historical OHLCV bars from Polygon.io. Supports minute to month intervals. Good for charting and backtesting.`;
export const POLYGON_TICKER_DETAILS_DESCRIPTION = `Fetches detailed ticker info from Polygon.io (company description, SIC code, share count, employees).`;
