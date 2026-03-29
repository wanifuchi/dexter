/**
 * Alpha Vantage API - 無料枠あり（日25回）、ETF/ADR対応
 * APIキー: https://www.alphavantage.co/support/#api-key で無料取得
 * 環境変数: ALPHA_VANTAGE_API_KEY
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

const AV_BASE = 'https://www.alphavantage.co/query';

function getAvApiKey(): string {
  return process.env.ALPHA_VANTAGE_API_KEY || '';
}

async function avFetch(params: Record<string, string>, label: string): Promise<Record<string, unknown>> {
  const apiKey = getAvApiKey();
  if (!apiKey) {
    throw new Error('[Alpha Vantage] ALPHA_VANTAGE_API_KEY not set. Get free key at https://www.alphavantage.co/support/#api-key');
  }

  const url = new URL(AV_BASE);
  url.searchParams.set('apikey', apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`[Alpha Vantage] ${label}: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  // Alpha Vantageのエラーメッセージチェック
  if (data['Error Message']) {
    throw new Error(`[Alpha Vantage] ${data['Error Message']}`);
  }
  if (data['Note']?.toString().includes('call volume')) {
    throw new Error('[Alpha Vantage] API rate limit reached (25 calls/day for free tier)');
  }

  return data;
}

/**
 * Alpha Vantage Global Quote - リアルタイム株価
 */
export const avGlobalQuote = new DynamicStructuredTool({
  name: 'av_global_quote',
  description: 'Fetches real-time stock quote from Alpha Vantage. Supports stocks, ETFs, and ADRs.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'SOXL'"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await avFetch(
      { function: 'GLOBAL_QUOTE', symbol: ticker },
      `quote ${ticker}`,
    );

    const quote = data['Global Quote'] as Record<string, string> | undefined;
    if (!quote) {
      return formatToolResult({ error: `No data for ${ticker}` });
    }

    return formatToolResult({
      ticker,
      price: parseFloat(quote['05. price'] || '0'),
      change: parseFloat(quote['09. change'] || '0'),
      changePercent: quote['10. change percent'],
      open: parseFloat(quote['02. open'] || '0'),
      high: parseFloat(quote['03. high'] || '0'),
      low: parseFloat(quote['04. low'] || '0'),
      previousClose: parseFloat(quote['08. previous close'] || '0'),
      volume: parseInt(quote['06. volume'] || '0', 10),
      latestTradingDay: quote['07. latest trading day'],
    });
  },
});

/**
 * Alpha Vantage Company Overview - 企業概要・財務指標
 */
export const avCompanyOverview = new DynamicStructuredTool({
  name: 'av_company_overview',
  description: 'Fetches detailed company overview with financial metrics from Alpha Vantage. Includes P/E, EPS, market cap, dividend yield, 52-week range, and more.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'MO'"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await avFetch(
      { function: 'OVERVIEW', symbol: ticker },
      `overview ${ticker}`,
    );

    if (!data['Symbol']) {
      return formatToolResult({ error: `No overview data for ${ticker}` });
    }

    // 重要なフィールドだけ抽出
    return formatToolResult({
      ticker: data['Symbol'],
      name: data['Name'],
      description: data['Description'],
      exchange: data['Exchange'],
      currency: data['Currency'],
      country: data['Country'],
      sector: data['Sector'],
      industry: data['Industry'],
      marketCap: data['MarketCapitalization'],
      peRatio: data['PERatio'],
      pegRatio: data['PEGRatio'],
      bookValue: data['BookValue'],
      dividendPerShare: data['DividendPerShare'],
      dividendYield: data['DividendYield'],
      eps: data['EPS'],
      revenuePerShare: data['RevenuePerShareTTM'],
      profitMargin: data['ProfitMargin'],
      operatingMargin: data['OperatingMarginTTM'],
      returnOnAssets: data['ReturnOnAssetsTTM'],
      returnOnEquity: data['ReturnOnEquityTTM'],
      revenue: data['RevenueTTM'],
      grossProfit: data['GrossProfitTTM'],
      ebitda: data['EBITDA'],
      beta: data['Beta'],
      fiftyTwoWeekHigh: data['52WeekHigh'],
      fiftyTwoWeekLow: data['52WeekLow'],
      fiftyDayMA: data['50DayMovingAverage'],
      twoHundredDayMA: data['200DayMovingAverage'],
      sharesOutstanding: data['SharesOutstanding'],
      analystTargetPrice: data['AnalystTargetPrice'],
      analystRatingBuy: data['AnalystRatingStrongBuy'],
    });
  },
});

export const AV_GLOBAL_QUOTE_DESCRIPTION = `
Fetches real-time stock quote from Alpha Vantage (free API, 25 calls/day). Supports stocks, ETFs, and ADRs. Use as fallback when other sources fail.
`.trim();

export const AV_COMPANY_OVERVIEW_DESCRIPTION = `
Fetches detailed company overview with financial metrics (P/E, EPS, market cap, margins, analyst target price) from Alpha Vantage. Use for comprehensive fundamental data.
`.trim();
