/**
 * Vercel Serverless Function — /api/watchlist
 * ウォッチリスト銘柄の現在価格付きデータを返す
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadWatchlist } from '../tools/trading/watchlist-store.js';

export const maxDuration = 30;

async function fetchPrice(ticker: string) {
  try {
    const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d&events=div`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta ?? {};
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const price = meta.regularMarketPrice ?? closes[closes.length - 1];
    const previousClose = meta.chartPreviousClose ?? closes[closes.length - 2];
    return {
      price: typeof price === 'number' ? price : null,
      previousClose: typeof previousClose === 'number' ? previousClose : null,
      name: meta.shortName ?? meta.symbol ?? null,
    };
  } catch { return null; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const wl = await loadWatchlist();
    const tickers = wl.items.map(i => i.ticker);
    const priceResults = await Promise.all(tickers.map(fetchPrice));

    const items = wl.items.map((item, i) => {
      const pd = priceResults[i];
      const dayChange = pd?.price && pd?.previousClose
        ? ((pd.price - pd.previousClose) / pd.previousClose) * 100
        : null;
      return {
        ...item,
        currentPrice: pd?.price ?? null,
        previousClose: pd?.previousClose ?? null,
        dayChange,
        yahooName: pd?.name ?? null,
      };
    });

    return res.json({ items, updatedAt: Date.now() });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
