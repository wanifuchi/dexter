/**
 * Financial Modeling Prep (FMP) API - 企業プロフィール、DCF、財務諸表、格付け
 * 無料枠: 250回/日
 * 環境変数: FMP_API_KEY
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const FMP_BASE = 'https://financialmodelingprep.com';

async function fmpFetch(endpoint: string, params: Record<string, string>, label: string): Promise<unknown> {
  const apiKey = process.env.FMP_API_KEY || '';
  if (!apiKey) throw new Error('[FMP] FMP_API_KEY not set');

  const url = new URL(`${FMP_BASE}${endpoint}`);
  url.searchParams.set('apikey', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`[FMP] ${label}: ${response.status}`);
  return await response.json();
}

/**
 * FMP 企業プロフィール（新API: /stable/profile）
 */
export const fmpProfile = new DynamicStructuredTool({
  name: 'fmp_profile',
  description: 'Fetches detailed company profile from FMP including price, market cap, beta, industry, description. Works for stocks, ETFs, and ADRs.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'NVDA'"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await fmpFetch('/stable/profile', { symbol: ticker }, `profile ${ticker}`) as Record<string, unknown>[];

    if (!Array.isArray(data) || data.length === 0) {
      return formatToolResult({ error: `No FMP profile for ${ticker}` });
    }

    const p = data[0];
    return formatToolResult({
      ticker: p.symbol,
      name: p.companyName,
      price: p.price,
      marketCap: p.marketCap,
      beta: p.beta,
      change: p.change,
      changePercent: p.changePercentage,
      volume: p.volume,
      avgVolume: p.averageVolume,
      range: p.range,
      currency: p.currency,
      exchange: p.exchange,
      industry: p.industry,
      sector: p.sector,
      country: p.country,
      description: typeof p.description === 'string' ? (p.description as string).slice(0, 300) : null,
      website: p.website,
      ipoDate: p.ipoDate,
      isEtf: p.isEtf,
      isFund: p.isFund,
    });
  },
});

/**
 * FMP 財務諸表（損益計算書）
 */
export const fmpIncomeStatement = new DynamicStructuredTool({
  name: 'fmp_income_statement',
  description: 'Fetches income statements from FMP. Returns revenue, net income, EPS, margins for the last several quarters/years.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol"),
    period: z.enum(['annual', 'quarter']).default('annual').describe("Annual or quarterly"),
    limit: z.number().default(4).describe("Number of periods"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await fmpFetch('/stable/income-statement', {
      symbol: ticker,
      period: input.period,
      limit: String(input.limit),
    }, `income ${ticker}`) as Record<string, unknown>[];

    if (!Array.isArray(data)) return formatToolResult({ error: `No data for ${ticker}` });

    const results = data.map((d) => ({
      date: d.date,
      revenue: d.revenue,
      grossProfit: d.grossProfit,
      operatingIncome: d.operatingIncome,
      netIncome: d.netIncome,
      eps: d.eps,
      epsDiluted: d.epsDiluted,
      grossProfitRatio: d.grossProfitRatio,
      operatingIncomeRatio: d.operatingIncomeRatio,
      netIncomeRatio: d.netIncomeRatio,
    }));

    return formatToolResult(results);
  },
});

/**
 * FMP 株式スクリーナー
 */
export const fmpScreener = new DynamicStructuredTool({
  name: 'fmp_screener',
  description: 'Screens stocks using FMP with filters like market cap, sector, price, beta, volume, dividend yield. Useful for finding investment opportunities.',
  schema: z.object({
    marketCapMoreThan: z.number().optional().describe("Min market cap in USD"),
    marketCapLowerThan: z.number().optional().describe("Max market cap in USD"),
    sector: z.string().optional().describe("Sector filter, e.g. 'Technology'"),
    industry: z.string().optional().describe("Industry filter"),
    betaMoreThan: z.number().optional().describe("Min beta"),
    betaLowerThan: z.number().optional().describe("Max beta"),
    dividendMoreThan: z.number().optional().describe("Min dividend yield"),
    priceMoreThan: z.number().optional().describe("Min price"),
    priceLowerThan: z.number().optional().describe("Max price"),
    volumeMoreThan: z.number().optional().describe("Min volume"),
    limit: z.number().default(20).describe("Max results"),
  }),
  func: async (input) => {
    const params: Record<string, string> = { limit: String(input.limit) };
    if (input.marketCapMoreThan) params.marketCapMoreThan = String(input.marketCapMoreThan);
    if (input.marketCapLowerThan) params.marketCapLowerThan = String(input.marketCapLowerThan);
    if (input.sector) params.sector = input.sector;
    if (input.industry) params.industry = input.industry;
    if (input.betaMoreThan) params.betaMoreThan = String(input.betaMoreThan);
    if (input.betaLowerThan) params.betaLowerThan = String(input.betaLowerThan);
    if (input.dividendMoreThan) params.dividendMoreThan = String(input.dividendMoreThan);
    if (input.priceMoreThan) params.priceMoreThan = String(input.priceMoreThan);
    if (input.priceLowerThan) params.priceLowerThan = String(input.priceLowerThan);
    if (input.volumeMoreThan) params.volumeMoreThan = String(input.volumeMoreThan);

    const data = await fmpFetch('/stable/stock-screener', params, 'screener') as Record<string, unknown>[];

    if (!Array.isArray(data)) return formatToolResult({ error: 'Screener failed' });

    const results = data.map((d) => ({
      symbol: d.symbol,
      companyName: d.companyName,
      marketCap: d.marketCap,
      sector: d.sector,
      industry: d.industry,
      price: d.price,
      beta: d.beta,
      volume: d.volume,
      lastAnnualDividend: d.lastAnnualDividend,
      exchange: d.exchange,
      country: d.country,
    }));

    return formatToolResult(results);
  },
});

/**
 * FMP キーメトリクス
 */
export const fmpKeyMetrics = new DynamicStructuredTool({
  name: 'fmp_key_metrics',
  description: 'Fetches key financial metrics from FMP including P/E, P/B, EV/EBITDA, ROE, ROA, debt ratios, and more. Essential for valuation analysis.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol"),
    period: z.enum(['annual', 'quarter']).default('annual'),
    limit: z.number().default(4),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await fmpFetch('/stable/key-metrics', {
      symbol: ticker,
      period: input.period,
      limit: String(input.limit),
    }, `metrics ${ticker}`) as Record<string, unknown>[];

    if (!Array.isArray(data)) return formatToolResult({ error: `No metrics for ${ticker}` });

    const results = data.map((d) => ({
      date: d.date,
      peRatio: d.peRatio,
      pbRatio: d.pbRatio,
      evToEbitda: d.enterpriseValueOverEBITDA,
      roe: d.roe,
      roa: d.returnOnTangibleAssets,
      debtToEquity: d.debtToEquity,
      currentRatio: d.currentRatio,
      dividendYield: d.dividendYield,
      freeCashFlowPerShare: d.freeCashFlowPerShare,
      revenuePerShare: d.revenuePerShare,
      netIncomePerShare: d.netIncomePerShare,
      bookValuePerShare: d.bookValuePerShare,
    }));

    return formatToolResult(results);
  },
});

export const FMP_PROFILE_DESCRIPTION = `Fetches detailed company profile from FMP (price, market cap, beta, industry, description). Works for stocks, ETFs, ADRs.`;
export const FMP_INCOME_DESCRIPTION = `Fetches income statements from FMP (revenue, net income, EPS, margins). Use for fundamental analysis.`;
export const FMP_SCREENER_DESCRIPTION = `Screens stocks by market cap, sector, beta, dividend, price, volume using FMP. Great for finding investment candidates.`;
export const FMP_KEY_METRICS_DESCRIPTION = `Fetches key valuation metrics from FMP (P/E, P/B, EV/EBITDA, ROE, debt ratios). Essential for valuation.`;
