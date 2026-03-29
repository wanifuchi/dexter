/**
 * J-Quants V2 API - 東証公式の日本株価データ
 * APIキー不要のトークンリフレッシュなし（V2）
 * 環境変数: JQUANTS_API_KEY
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { edinetApi, resolveEdinetCode } from './edinetdb-api.js';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

const JQUANTS_BASE = 'https://api.jquants.com/v2';

function getJQuantsApiKey(): string {
  return process.env.JQUANTS_API_KEY || '';
}

async function jquantsGet(
  endpoint: string,
  params: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const apiKey = getJQuantsApiKey();
  if (!apiKey) {
    throw new Error('[J-Quants] JQUANTS_API_KEY not set. Get key at https://jpx-jquants.com');
  }

  const url = new URL(`${JQUANTS_BASE}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: { 'x-api-key': apiKey },
  });

  if (!response.ok) {
    throw new Error(`[J-Quants] ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

/**
 * 証券コードをJ-Quants形式（5桁）に変換
 */
async function resolveJQuantsCode(ticker: string): Promise<string> {
  if (/^\d{5}$/.test(ticker)) return ticker;
  if (/^\d{4}$/.test(ticker)) return ticker + '0';

  // EDINET DB経由で証券コードを取得
  const edinetCode = await resolveEdinetCode(ticker);
  const { data: response } = await edinetApi.get(`/companies/${edinetCode}`, {});
  const company = (response.data || response) as Record<string, unknown>;
  const secCode = (company.sec_code || company.secCode) as string | undefined;
  if (!secCode) throw new Error(`証券コードが見つかりません: ${ticker}`);
  return secCode.replace(/\D/g, '').slice(0, 4) + '0';
}

/**
 * Yahoo Finance経由で日本株のリアルタイム株価を取得
 * J-Quantsの無料プランはデータが数ヶ月遅れるため、最新価格はYahoo Financeを使う
 */
async function fetchYahooJpQuote(secCode4: string): Promise<Record<string, unknown> | null> {
  const ticker = secCode4 + '.T';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1d`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    const chart = data.chart as Record<string, unknown> | undefined;
    const results = (chart?.result as Record<string, unknown>[]) ?? [];
    if (results.length === 0) return null;

    const meta = results[0].meta as Record<string, unknown>;
    const timestamps = (results[0].timestamp as number[]) ?? [];
    const indicators = results[0].indicators as Record<string, unknown>;
    const quoteArr = (indicators?.quote as Record<string, unknown>[]) ?? [];
    const q = quoteArr[0] ?? {};
    const closes = (q.close as number[]) ?? [];
    const volumes = (q.volume as number[]) ?? [];

    const price = meta.regularMarketPrice as number;
    const previousClose = meta.chartPreviousClose as number;
    const marketTime = meta.regularMarketTime as number;
    const date = marketTime ? new Date(marketTime * 1000).toISOString().split('T')[0] : undefined;

    return {
      code: secCode4,
      date,
      price,
      previousClose,
      change: price && previousClose ? Number((price - previousClose).toFixed(1)) : null,
      changePercent: price && previousClose ? Number(((price - previousClose) / previousClose * 100).toFixed(2)) : null,
      high: meta.regularMarketDayHigh ?? (closes.length > 0 ? Math.max(...closes.filter(Boolean)) : null),
      low: meta.regularMarketDayLow ?? (closes.length > 0 ? Math.min(...closes.filter(Boolean)) : null),
      volume: volumes.length > 0 ? volumes[volumes.length - 1] : null,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      source: 'yahoo_finance',
    };
  } catch (error) {
    logger.warn(`[Yahoo JP] failed for ${ticker}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * 日本株 株価データ
 * 最新価格: Yahoo Finance（リアルタイム）
 * 履歴データ: J-Quants（東証公式、無料プランは数ヶ月遅延あり）
 */
export const jpStockPrice = new DynamicStructuredTool({
  name: 'jp_stock_price',
  description: 'Fetches stock price data for Japanese equities. Returns real-time price from Yahoo Finance for latest quotes, or historical OHLC from J-Quants when date range is specified.',
  schema: z.object({
    ticker: z.string().describe("証券コード（例: '7203'）、企業名（例: 'トヨタ'）、またはEDINETコード"),
    from: z.string().optional().describe("開始日（YYYY-MM-DD）。省略時は最新データ"),
    to: z.string().optional().describe("終了日（YYYY-MM-DD）"),
  }),
  func: async (input) => {
    const code = await resolveJQuantsCode(input.ticker);
    const secCode4 = code.slice(0, 4);

    // 日付範囲指定なし → Yahoo Financeでリアルタイム取得
    if (!input.from && !input.to) {
      const yahoo = await fetchYahooJpQuote(secCode4);
      if (yahoo) {
        return formatToolResult(yahoo, [`https://finance.yahoo.co.jp/quote/${secCode4}.T`]);
      }
      // Yahoo失敗時はJ-Quantsにフォールバック
      logger.info(`[jp_stock_price] Yahoo failed for ${secCode4}, falling back to J-Quants`);
    }

    // 日付範囲指定あり or Yahooフォールバック → J-Quants
    const params: Record<string, string | undefined> = {
      code,
      from: input.from,
      to: input.to,
    };

    const response = await jquantsGet('/equities/bars/daily', params);
    const bars = response.data as Array<Record<string, unknown>> | undefined;

    if (!bars || bars.length === 0) {
      return formatToolResult({ error: `株価データが見つかりません: ${input.ticker}` }, []);
    }

    if (!input.from && !input.to) {
      const latest = bars[bars.length - 1];
      return formatToolResult({
        code: latest.Code,
        date: latest.Date,
        open: latest.AdjO,
        high: latest.AdjH,
        low: latest.AdjL,
        close: latest.AdjC,
        volume: latest.AdjVo,
        turnover: latest.Va,
        source: 'jquants',
      }, []);
    }

    const compact = bars.map((q) => ({
      date: q.Date,
      open: q.AdjO,
      high: q.AdjH,
      low: q.AdjL,
      close: q.AdjC,
      volume: q.AdjVo,
    }));

    return formatToolResult(compact, []);
  },
});

export const JP_STOCK_PRICE_DESCRIPTION = `日本株の株価データをJ-Quants（東証公式）から取得。OHLC・出来高・分割調整済み。証券コード・企業名で検索可能。JQUANTS_API_KEY設定時のみ利用可能。`;

/**
 * J-Quants APIが利用可能か
 */
export function isJQuantsAvailable(): boolean {
  return Boolean(process.env.JQUANTS_API_KEY);
}
