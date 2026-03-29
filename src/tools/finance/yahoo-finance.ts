/**
 * Yahoo Finance API - APIキー不要、ETF/ADR/小型株すべて対応
 * Financial Datasets APIで取得できない銘柄のフォールバックとして使用
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

const YF_BASE = 'https://query1.finance.yahoo.com';

/**
 * Yahoo Finance APIへのリクエスト実行
 */
async function yfFetch(url: string, label: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    },
  });

  if (!response.ok) {
    throw new Error(`[Yahoo Finance] ${label}: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

/**
 * Yahoo Finance v8 chart API - リアルタイム株価取得（複数銘柄対応）
 * v7 quote APIは廃止済みのため、chart APIのmetaデータから現在値を取得
 * ETF, ADR, 小型株すべて対応
 */
export const yahooQuote = new DynamicStructuredTool({
  name: 'yahoo_quote',
  description: 'Fetches real-time stock/ETF/ADR quotes from Yahoo Finance. Supports all US-listed tickers including ETFs (SOXL, SPYD), ADRs (PBR, EC, GRAB), and small-caps (IREN, CIFR, WULF).',
  schema: z.object({
    tickers: z
      .string()
      .describe("Comma-separated ticker symbols. Example: 'SOXL,PBR,IREN,MO'"),
  }),
  func: async (input) => {
    const symbols = input.tickers
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);

    // chart APIで並列取得
    const quotes = await Promise.all(
      symbols.map(async (ticker) => {
        try {
          const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`;
          const data = await yfFetch(url, `quote ${ticker}`);

          const chart = data.chart as Record<string, unknown> | undefined;
          const results = (chart?.result as Record<string, unknown>[]) ?? [];

          if (results.length === 0) {
            return { symbol: ticker, error: 'No data' };
          }

          const meta = results[0].meta as Record<string, unknown>;
          const timestamps = (results[0].timestamp as number[]) ?? [];
          const indicators = results[0].indicators as Record<string, unknown>;
          const quoteArr = (indicators?.quote as Record<string, unknown>[]) ?? [];
          const q = quoteArr[0] ?? {};
          const closes = (q.close as number[]) ?? [];
          const volumes = (q.volume as number[]) ?? [];

          // 前日終値を計算
          const currentPrice = meta.regularMarketPrice as number;
          const previousClose = meta.chartPreviousClose as number;
          const change = currentPrice && previousClose ? Number((currentPrice - previousClose).toFixed(2)) : null;
          const changePercent = currentPrice && previousClose ? Number(((change! / previousClose) * 100).toFixed(2)) : null;

          return {
            symbol: ticker,
            price: currentPrice,
            previousClose,
            change,
            changePercent,
            currency: meta.currency,
            exchange: meta.exchangeName,
            instrumentType: meta.instrumentType,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
            volume: volumes.length > 0 ? volumes[volumes.length - 1] : null,
          };
        } catch (error) {
          return { symbol: ticker, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );

    const sourceUrls = symbols.map((t) => `${YF_BASE}/v8/finance/chart/${t}?range=5d&interval=1d`);
    return formatToolResult(quotes, sourceUrls);
  },
});

/**
 * Yahoo Finance v8 chart API - 履歴株価データ取得
 */
export const yahooChart = new DynamicStructuredTool({
  name: 'yahoo_chart',
  description: 'Fetches historical price data from Yahoo Finance for any US-listed ticker (stocks, ETFs, ADRs). Supports configurable date ranges and intervals.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'SOXL'"),
    range: z
      .enum(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'max'])
      .default('3mo')
      .describe("Time range. Default '3mo'."),
    interval: z
      .enum(['1d', '1wk', '1mo'])
      .default('1d')
      .describe("Data interval. Default '1d'."),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?range=${input.range}&interval=${input.interval}`;

    const data = await yfFetch(url, `chart ${ticker}`);

    const chart = data.chart as Record<string, unknown> | undefined;
    const results = (chart?.result as Record<string, unknown>[]) ?? [];

    if (results.length === 0) {
      return formatToolResult({ error: `No chart data for ${ticker}` }, [url]);
    }

    const result = results[0];
    const timestamps = (result.timestamp as number[]) ?? [];
    const indicators = result.indicators as Record<string, unknown>;
    const quoteArr = (indicators?.quote as Record<string, unknown>[]) ?? [];
    const quote = quoteArr[0] ?? {};

    const opens = (quote.open as number[]) ?? [];
    const highs = (quote.high as number[]) ?? [];
    const lows = (quote.low as number[]) ?? [];
    const closes = (quote.close as number[]) ?? [];
    const volumes = (quote.volume as number[]) ?? [];

    // 最新20件に制限してトークン節約
    const limit = Math.min(timestamps.length, 20);
    const startIdx = timestamps.length - limit;

    const prices = [];
    for (let i = startIdx; i < timestamps.length; i++) {
      prices.push({
        date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
        open: opens[i] != null ? Number(opens[i].toFixed(2)) : null,
        high: highs[i] != null ? Number(highs[i].toFixed(2)) : null,
        low: lows[i] != null ? Number(lows[i].toFixed(2)) : null,
        close: closes[i] != null ? Number(closes[i].toFixed(2)) : null,
        volume: volumes[i],
      });
    }

    const meta = result.meta as Record<string, unknown> | undefined;

    return formatToolResult(
      {
        ticker,
        currency: meta?.currency,
        exchangeName: meta?.exchangeName,
        instrumentType: meta?.instrumentType,
        prices,
      },
      [url],
    );
  },
});

/**
 * Yahoo Finance v10 summary API - 企業概要・財務サマリー取得
 */
export const yahooSummary = new DynamicStructuredTool({
  name: 'yahoo_summary',
  description: 'Fetches company profile, financial summary, and key statistics from Yahoo Finance. Works for stocks, ETFs, and ADRs.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'PBR'"),
    modules: z
      .string()
      .default('price,summaryDetail,defaultKeyStatistics,financialData,assetProfile')
      .describe("Comma-separated Yahoo Finance modules to fetch."),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const modules = input.modules || 'price,summaryDetail,defaultKeyStatistics,financialData,assetProfile';
    const url = `${YF_BASE}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${encodeURIComponent(modules)}`;

    const data = await yfFetch(url, `summary ${ticker}`);
    const quoteSummary = data.quoteSummary as Record<string, unknown> | undefined;
    const results = (quoteSummary?.result as Record<string, unknown>[]) ?? [];

    if (results.length === 0) {
      return formatToolResult({ error: `No summary data for ${ticker}` }, [url]);
    }

    // 各モジュールの値を rawフィールドから抽出して簡略化
    const result = results[0];
    const simplified: Record<string, unknown> = { ticker };

    for (const [key, value] of Object.entries(result)) {
      if (value && typeof value === 'object') {
        simplified[key] = simplifyYahooValues(value as Record<string, unknown>);
      }
    }

    return formatToolResult(simplified, [url]);
  },
});

/**
 * Yahoo Financeのraw/fmt形式の値を簡略化
 */
function simplifyYahooValues(obj: Record<string, unknown>): unknown {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const val = value as Record<string, unknown>;
      // {raw: 123, fmt: "123"} 形式 → rawの値だけ取得
      if ('raw' in val) {
        result[key] = val.raw;
      } else {
        result[key] = simplifyYahooValues(val);
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

export const YAHOO_QUOTE_DESCRIPTION = `
Fetches real-time quotes for ANY US-listed ticker from Yahoo Finance — stocks, ETFs (SOXL, SPYD, QQQ), ADRs (PBR, EC, GRAB), and small-caps (IREN, CIFR, WULF). Supports multiple tickers in one call. Use when Financial Datasets API doesn't have data for a ticker.
`.trim();

export const YAHOO_CHART_DESCRIPTION = `
Fetches historical price data from Yahoo Finance for any US-listed ticker. Use for ETFs, ADRs, or small-cap stocks not covered by Financial Datasets API. Supports various time ranges (1d to max) and intervals.
`.trim();

export const YAHOO_SUMMARY_DESCRIPTION = `
Fetches company profile, financial summary, and key statistics from Yahoo Finance. Use for detailed information on ETFs, ADRs, or any ticker not fully covered by Financial Datasets API.
`.trim();
