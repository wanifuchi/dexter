/**
 * Vercel Serverless Function — /api/portfolio
 * ポートフォリオの現在状況を返すAPI
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio } from '../src/tools/trading/portfolio-store.js';
import { loadAlertStore } from '../src/tools/trading/alert-store.js';

export const maxDuration = 30;

interface PriceData {
  ticker: string;
  price: number | null;
  previousClose: number | null;
  name: string | null;
}

async function fetchPrice(ticker: string): Promise<PriceData> {
  try {
    const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2d&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { ticker, price: null, previousClose: null, name: null };

    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    if (!result) return { ticker, price: null, previousClose: null, name: null };

    const meta = result.meta ?? {};
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const price = meta.regularMarketPrice ?? closes[closes.length - 1];
    const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? closes[closes.length - 2];

    return {
      ticker,
      price: typeof price === 'number' ? price : null,
      previousClose: typeof previousClose === 'number' ? previousClose : null,
      name: meta.shortName ?? meta.symbol ?? null,
    };
  } catch {
    return { ticker, price: null, previousClose: null, name: null };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const [portfolio, alertStore] = await Promise.all([
      loadPortfolio(),
      loadAlertStore(),
    ]);

    // USD/JPY為替レート取得
    let usdJpy = 150; // フォールバック
    try {
      const fxRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?range=1d&interval=1d', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (fxRes.ok) {
        const fxJson = await fxRes.json() as any;
        const rate = fxJson?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (typeof rate === 'number') usdJpy = rate;
      }
    } catch {}

    // ユニークなtickerを収集して株価取得
    const tickers = [...new Set(portfolio.positions.map((p) => p.ticker))];
    const prices = await Promise.all(tickers.map(fetchPrice));
    const priceMap = new Map(prices.map((p) => [p.ticker, p]));

    // ポジションにリアルタイム価格を付与
    let totalCost = 0;
    let totalValue = 0;

    const enrichedPositions = portfolio.positions.map((pos) => {
      const pd = priceMap.get(pos.ticker);
      const currentPrice = pd?.price ?? null;
      const marketValue = currentPrice !== null ? currentPrice * pos.shares : null;
      const costBasis = pos.avgCost * pos.shares;
      const pnl = marketValue !== null ? marketValue - costBasis : null;
      const pnlPct = currentPrice !== null ? ((currentPrice - pos.avgCost) / pos.avgCost) * 100 : null;
      const dayChange = pd?.price && pd?.previousClose
        ? ((pd.price - pd.previousClose) / pd.previousClose) * 100
        : null;

      if (marketValue !== null) {
        totalCost += costBasis;
        totalValue += marketValue;
      }

      return {
        ticker: pos.ticker,
        name: pos.name,
        shares: pos.shares,
        avgCost: pos.avgCost,
        account: pos.account,
        currentPrice,
        marketValue,
        costBasis,
        pnl,
        pnlPct,
        dayChange,
      };
    });

    const totalPnl = totalValue - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

    // 口座別サマリー
    const accountSummary: Record<string, { cost: number; value: number; count: number }> = {};
    for (const pos of enrichedPositions) {
      if (!accountSummary[pos.account]) {
        accountSummary[pos.account] = { cost: 0, value: 0, count: 0 };
      }
      accountSummary[pos.account].count++;
      accountSummary[pos.account].cost += pos.costBasis;
      if (pos.marketValue !== null) {
        accountSummary[pos.account].value += pos.marketValue;
      }
    }

    return res.json({
      positions: enrichedPositions,
      alerts: alertStore.rules,
      summary: {
        totalCost,
        totalValue,
        totalPnl,
        totalPnlPct,
        positionCount: enrichedPositions.length,
      },
      accountSummary,
      usdJpy,
      updatedAt: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
