/**
 * Vercel Cron Job — /api/cron/snapshot
 * 日次ポートフォリオスナップショットをRedisに記録。
 * パフォーマンスチャート用の時系列データを蓄積する。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio } from '../../src/tools/trading/portfolio-store.js';

export const maxDuration = 30;

interface Snapshot {
  date: string;
  totalCost: number;
  totalValue: number;
  totalPnl: number;
  totalPnlPct: number;
  positions: Record<string, { price: number; shares: number; value: number }>;
}

async function fetchPrice(ticker: string): Promise<number | null> {
  try {
    const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json() as any;
    return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const { Redis } = await import('@upstash/redis');
  return new Redis({ url, token });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const portfolio = await loadPortfolio();
    if (portfolio.positions.length === 0) {
      return res.json({ status: 'ok', message: 'No positions' });
    }

    const tickers = [...new Set(portfolio.positions.map((p) => p.ticker))];
    const prices = await Promise.all(tickers.map(async (t) => ({ ticker: t, price: await fetchPrice(t) })));
    const priceMap = new Map(prices.map((p) => [p.ticker, p.price]));

    let totalCost = 0;
    let totalValue = 0;
    const posData: Record<string, { price: number; shares: number; value: number }> = {};

    for (const pos of portfolio.positions) {
      const price = priceMap.get(pos.ticker);
      if (price === null || price === undefined) continue;
      const costBasis = pos.avgCost * pos.shares;
      const marketValue = price * pos.shares;
      totalCost += costBasis;
      totalValue += marketValue;

      const key = `${pos.ticker}:${pos.account}`;
      posData[key] = { price, shares: pos.shares, value: marketValue };
    }

    const today = new Date().toISOString().split('T')[0];
    const snapshot: Snapshot = {
      date: today,
      totalCost,
      totalValue,
      totalPnl: totalValue - totalCost,
      totalPnlPct: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
      positions: posData,
    };

    // Redisに保存（リスト形式、最大365日分）
    const redis = await getRedis();
    if (redis) {
      const SNAPSHOTS_KEY = 'finx:snapshots';

      // 既存のスナップショットを取得
      let existing: Snapshot[] = [];
      try {
        let raw = await redis.get(SNAPSHOTS_KEY);
        while (typeof raw === 'string') {
          try { raw = JSON.parse(raw); } catch { break; }
        }
        if (Array.isArray(raw)) existing = raw;
      } catch {}

      // 同じ日のデータがあれば上書き、なければ追加
      const idx = existing.findIndex((s) => s.date === today);
      if (idx >= 0) {
        existing[idx] = snapshot;
      } else {
        existing.push(snapshot);
      }

      // 最新365日分だけ保持
      if (existing.length > 365) {
        existing = existing.slice(-365);
      }

      await redis.set(SNAPSHOTS_KEY, JSON.stringify(existing));
    }

    return res.json({ status: 'ok', date: today, totalValue, totalPnl: snapshot.totalPnl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
