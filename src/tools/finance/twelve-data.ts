/**
 * Twelve Data API - テクニカル指標（RSI, MACD, BB, SMA, EMA等）
 * 無料枠: 800回/日, 8回/分
 * 環境変数: TWELVE_DATA_API_KEY
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const TD_BASE = 'https://api.twelvedata.com';

async function tdFetch(endpoint: string, params: Record<string, string>, label: string): Promise<unknown> {
  const apiKey = process.env.TWELVE_DATA_API_KEY || '';
  if (!apiKey) throw new Error('[Twelve Data] TWELVE_DATA_API_KEY not set');

  const url = new URL(`${TD_BASE}${endpoint}`);
  url.searchParams.set('apikey', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`[Twelve Data] ${label}: ${response.status}`);

  const data = await response.json() as Record<string, unknown>;
  if (data.status === 'error') throw new Error(`[Twelve Data] ${data.message}`);
  return data;
}

/**
 * テクニカル指標を一括取得
 */
export const twelveDataTechnicals = new DynamicStructuredTool({
  name: 'td_technicals',
  description: 'Fetches technical indicators (RSI, MACD, Bollinger Bands, SMA, EMA) from Twelve Data. Essential for technical analysis and identifying buy/sell signals.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol, e.g. 'NVDA'"),
    indicators: z
      .string()
      .default('rsi,macd,bbands')
      .describe("Comma-separated indicators: rsi, macd, bbands, sma, ema, stoch, adx, atr"),
    interval: z.enum(['1day', '1week', '1month']).default('1day').describe("Time interval"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const indicators = input.indicators.split(',').map((i) => i.trim().toLowerCase());
    const results: Record<string, unknown> = { ticker };

    // 並列でテクニカル指標を取得
    await Promise.all(
      indicators.map(async (indicator) => {
        try {
          const params: Record<string, string> = {
            symbol: ticker,
            interval: input.interval,
            outputsize: '10',
          };

          // 指標別パラメータ
          if (indicator === 'sma' || indicator === 'ema') {
            params.time_period = '20';
          }

          const data = await tdFetch(`/${indicator}`, params, `${indicator} ${ticker}`) as Record<string, unknown>;
          const values = (data.values as Record<string, unknown>[])?.slice(0, 5) ?? [];
          results[indicator] = values;
        } catch (error) {
          results[indicator] = { error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );

    return formatToolResult(results);
  },
});

/**
 * 株価タイムシリーズ
 */
export const twelveDataTimeSeries = new DynamicStructuredTool({
  name: 'td_time_series',
  description: 'Fetches OHLCV time series data from Twelve Data. Supports stocks, ETFs, forex, and crypto with various intervals.',
  schema: z.object({
    ticker: z.string().describe("Ticker symbol"),
    interval: z.enum(['1min', '5min', '15min', '1h', '1day', '1week', '1month']).default('1day'),
    outputsize: z.number().default(20).describe("Number of data points (max 30 for free tier)"),
  }),
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await tdFetch('/time_series', {
      symbol: ticker,
      interval: input.interval,
      outputsize: String(Math.min(input.outputsize, 30)),
    }, `timeseries ${ticker}`) as Record<string, unknown>;

    const values = (data.values as Record<string, unknown>[]) ?? [];
    return formatToolResult({ ticker, meta: data.meta, prices: values });
  },
});

export const TD_TECHNICALS_DESCRIPTION = `Fetches technical indicators (RSI, MACD, Bollinger Bands, SMA, EMA, Stochastic, ADX, ATR) from Twelve Data. Use for technical analysis, identifying overbought/oversold conditions, trend strength, and buy/sell signals.`;
export const TD_TIME_SERIES_DESCRIPTION = `Fetches OHLCV time series from Twelve Data. Supports stocks, ETFs, forex, crypto. Various intervals from 1min to 1month.`;
