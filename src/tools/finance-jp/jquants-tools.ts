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
 * 日本株 株価データ（J-Quants V2）
 */
export const jpStockPrice = new DynamicStructuredTool({
  name: 'jp_stock_price',
  description: 'Fetches stock price data for Japanese equities from J-Quants (Tokyo Stock Exchange official data). Returns OHLC, volume, and split-adjusted prices. Specify date range for historical data, or omit for latest price.',
  schema: z.object({
    ticker: z.string().describe("証券コード（例: '7203'）、企業名（例: 'トヨタ'）、またはEDINETコード"),
    from: z.string().optional().describe("開始日（YYYY-MM-DD）。省略時は最新データ"),
    to: z.string().optional().describe("終了日（YYYY-MM-DD）"),
  }),
  func: async (input) => {
    const code = await resolveJQuantsCode(input.ticker);
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

    // 日付範囲指定なし → 最新のみ
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
      }, []);
    }

    // 日付範囲指定あり → コンパクトな配列
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
