/**
 * Finnhub API - 無料枠60回/分、ニュース・レーティング・決算・内部者取引
 * 環境変数: FINNHUB_API_KEY
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const FH_BASE = 'https://finnhub.io/api/v1';

function getFhApiKey(): string {
  return process.env.FINNHUB_API_KEY || '';
}

async function fhFetch(endpoint: string, params: Record<string, string>, label: string): Promise<unknown> {
  const apiKey = getFhApiKey();
  if (!apiKey) {
    throw new Error('[Finnhub] FINNHUB_API_KEY not set');
  }

  const url = new URL(`${FH_BASE}${endpoint}`);
  url.searchParams.set('token', apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`[Finnhub] ${label}: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Finnhub アナリストレーティング
 */
export const finnhubRecommendation = new DynamicStructuredTool({
  name: 'finnhub_recommendation',
  description: 'Fetches analyst recommendation trends (buy/hold/sell counts) from Finnhub. Shows how Wall Street analysts rate a stock over recent months.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'NVDA'"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await fhFetch('/stock/recommendation', { symbol: ticker }, `recommendation ${ticker}`) as Record<string, unknown>[];

    // 直近6ヶ月分に制限
    const recent = (data ?? []).slice(0, 6).map((r) => ({
      period: r.period,
      strongBuy: r.strongBuy,
      buy: r.buy,
      hold: r.hold,
      sell: r.sell,
      strongSell: r.strongSell,
    }));

    return formatToolResult(recent);
  },
});

/**
 * Finnhub 企業ニュース
 */
export const finnhubNews = new DynamicStructuredTool({
  name: 'finnhub_news',
  description: 'Fetches recent company news from Finnhub. Returns headlines, summaries, and source URLs for a specific stock.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'PBR'"),
    days: z.number().default(7).describe("Number of days of news to fetch (default 7)"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - input.days * 86400000).toISOString().split('T')[0];

    const data = await fhFetch('/company-news', { symbol: ticker, from, to }, `news ${ticker}`) as Record<string, unknown>[];

    // 最新10件に制限してトークン節約
    const news = (data ?? []).slice(0, 10).map((n) => ({
      headline: n.headline,
      summary: typeof n.summary === 'string' ? (n.summary as string).slice(0, 200) : '',
      source: n.source,
      url: n.url,
      datetime: n.datetime ? new Date((n.datetime as number) * 1000).toISOString().split('T')[0] : null,
    }));

    return formatToolResult(news);
  },
});

/**
 * Finnhub リアルタイム株価
 */
export const finnhubQuote = new DynamicStructuredTool({
  name: 'finnhub_quote',
  description: 'Fetches real-time stock quote from Finnhub. Returns current price, high, low, open, previous close, and change. Works for stocks and ETFs.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'SOXL'"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await fhFetch('/quote', { symbol: ticker }, `quote ${ticker}`) as Record<string, unknown>;

    return formatToolResult({
      ticker,
      price: data.c,
      change: data.d,
      changePercent: data.dp,
      high: data.h,
      low: data.l,
      open: data.o,
      previousClose: data.pc,
      timestamp: data.t ? new Date((data.t as number) * 1000).toISOString() : null,
    });
  },
});

/**
 * Finnhub 決算カレンダー
 */
export const finnhubEarningsCalendar = new DynamicStructuredTool({
  name: 'finnhub_earnings_calendar',
  description: 'Fetches upcoming and recent earnings dates, EPS estimates vs actuals from Finnhub. Useful for tracking earnings season.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'AAPL'"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const from = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
    const to = new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0];

    const data = await fhFetch('/calendar/earnings', { symbol: ticker, from, to }, `earnings ${ticker}`) as Record<string, unknown>;
    const earnings = data.earningsCalendar as Record<string, unknown>[] ?? [];

    const results = earnings.slice(0, 8).map((e) => ({
      date: e.date,
      epsActual: e.epsActual,
      epsEstimate: e.epsEstimate,
      revenueActual: e.revenueActual,
      revenueEstimate: e.revenueEstimate,
      quarter: e.quarter,
      year: e.year,
    }));

    return formatToolResult(results);
  },
});

/**
 * Finnhub 企業プロフィール
 */
export const finnhubProfile = new DynamicStructuredTool({
  name: 'finnhub_profile',
  description: 'Fetches company profile from Finnhub including industry, market cap, shares outstanding, and IPO date. Works for most US-listed stocks.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'GRAB'"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await fhFetch('/stock/profile2', { symbol: ticker }, `profile ${ticker}`) as Record<string, unknown>;

    if (!data.ticker) {
      return formatToolResult({ error: `No profile for ${ticker}` });
    }

    return formatToolResult({
      ticker: data.ticker,
      name: data.name,
      country: data.country,
      currency: data.currency,
      exchange: data.exchange,
      industry: data.finnhubIndustry,
      ipo: data.ipo,
      marketCap: data.marketCapitalization,
      sharesOutstanding: data.shareOutstanding,
      weburl: data.weburl,
    });
  },
});

/**
 * Finnhub 目標株価コンセンサス
 */
export const finnhubPriceTarget = new DynamicStructuredTool({
  name: 'finnhub_price_target',
  description: 'Fetches analyst price target consensus from Finnhub. Returns high, low, mean, and median target prices.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'NVDA'"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await fhFetch('/stock/price-target', { symbol: ticker }, `target ${ticker}`) as Record<string, unknown>;

    return formatToolResult({
      ticker,
      targetHigh: data.targetHigh,
      targetLow: data.targetLow,
      targetMean: data.targetMean,
      targetMedian: data.targetMedian,
      lastUpdated: data.lastUpdated,
    });
  },
});

export const FINNHUB_RECOMMENDATION_DESCRIPTION = `Fetches analyst recommendation trends (buy/hold/sell counts over recent months) from Finnhub. Use to gauge Wall Street sentiment on a stock.`;
export const FINNHUB_NEWS_DESCRIPTION = `Fetches recent company-specific news headlines from Finnhub. Use for sentiment analysis and staying current on stock-moving events.`;
export const FINNHUB_QUOTE_DESCRIPTION = `Fetches real-time stock quote from Finnhub. Supports stocks and ETFs. Use as alternative price source.`;
export const FINNHUB_EARNINGS_DESCRIPTION = `Fetches earnings calendar with EPS estimates vs actuals from Finnhub. Use to track upcoming/recent earnings.`;
export const FINNHUB_PROFILE_DESCRIPTION = `Fetches company profile (industry, market cap, IPO date) from Finnhub. Use for basic company info on any ticker.`;
export const FINNHUB_PRICE_TARGET_DESCRIPTION = `Fetches analyst price target consensus (high/low/mean/median) from Finnhub. Essential for BUY/HOLD/SELL analysis.`;
