/**
 * Vercel Serverless Function — /api/paper-trade
 * ペーパートレードAPI
 * GET: アカウント状況 + 現在価格
 * POST: 注文発注 / キャンセル / リセット
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  loadPaperAccount,
  placeMarketOrder,
  placeLimitOrder,
  cancelOrder,
  resetPaperAccount,
  checkPendingOrders,
} from '../src/trading/paper-engine.js';

export const maxDuration = 30;

async function fetchPrice(ticker: string): Promise<number | null> {
  try {
    const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json() as any;
    return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch { return null; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const account = await loadPaperAccount();

      // ポジションの現在価格を取得
      const tickers = account.positions.map(p => p.ticker);
      const priceResults = await Promise.all(tickers.map(fetchPrice));
      const priceMap = new Map(tickers.map((t, i) => [t, priceResults[i]]));

      // 未約定注文のチェック
      const newlyFilled = await checkPendingOrders(priceMap as Map<string, number>);

      // 再読み込み（約定でデータが変わった可能性）
      const current = newlyFilled.length > 0 ? await loadPaperAccount() : account;

      let positionsValue = 0;
      const enrichedPositions = current.positions.map(p => {
        const price = priceMap.get(p.ticker) ?? null;
        const mv = price !== null ? price * p.shares : null;
        const pnl = price !== null ? (price - p.avgCost) * p.shares : null;
        const pnlPct = price !== null ? ((price - p.avgCost) / p.avgCost) * 100 : null;
        if (mv !== null) positionsValue += mv;
        return { ...p, currentPrice: price, marketValue: mv, pnl, pnlPct };
      });

      const equity = current.cash + positionsValue;
      const totalPnl = equity - current.initialCash;

      return res.json({
        cash: current.cash,
        initialCash: current.initialCash,
        equity,
        positionsValue,
        totalPnl,
        totalPnlPct: current.initialCash > 0 ? (totalPnl / current.initialCash) * 100 : 0,
        positions: enrichedPositions,
        recentOrders: current.orders.slice(-20).reverse(),
        pendingOrders: current.orders.filter(o => o.status === 'pending'),
        newlyFilled,
        updatedAt: current.updatedAt,
      });
    }

    // POST: 注文操作
    const body = req.body as {
      action: 'buy' | 'sell' | 'cancel' | 'reset';
      ticker?: string;
      shares?: number;
      orderType?: 'market' | 'limit';
      limitPrice?: number;
      orderId?: string;
      initialCash?: number;
      reason?: string;
    };

    if (!body?.action) return res.status(400).json({ error: 'action は必須です' });

    switch (body.action) {
      case 'buy':
      case 'sell': {
        if (!body.ticker || !body.shares) return res.status(400).json({ error: 'ticker, shares は必須です' });
        const price = await fetchPrice(body.ticker);
        if (price === null) return res.status(400).json({ error: `${body.ticker}の価格を取得できません` });

        if (body.orderType === 'limit' && body.limitPrice) {
          const { order, account } = await placeLimitOrder(
            body.ticker, body.action, body.shares, body.limitPrice, body.reason ?? '手動発注',
          );
          return res.json({ order, cash: account.cash });
        } else {
          const { order, account } = await placeMarketOrder(
            body.ticker, body.action, body.shares, price, body.reason ?? '手動発注',
          );
          return res.json({ order, cash: account.cash });
        }
      }
      case 'cancel': {
        if (!body.orderId) return res.status(400).json({ error: 'orderId は必須です' });
        const cancelled = await cancelOrder(body.orderId);
        return res.json({ cancelled });
      }
      case 'reset': {
        const account = await resetPaperAccount(body.initialCash);
        return res.json({ message: 'アカウントをリセットしました', cash: account.cash });
      }
      default:
        return res.status(400).json({ error: `不明なaction: ${body.action}` });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
