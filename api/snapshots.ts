/**
 * Vercel Serverless Function — /api/snapshots
 * パフォーマンスチャート用の時系列データを返す
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const maxDuration = 10;

async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const { Redis } = await import('@upstash/redis');
  return new Redis({ url, token });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const redis = await getRedis();
    if (!redis) {
      return res.json({ snapshots: [], message: 'Redis not configured' });
    }

    let raw = await redis.get('finx:snapshots');
    while (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { break; }
    }

    const snapshots = Array.isArray(raw) ? raw : [];

    // ベンチマーク（S&P500）データも返す
    let sp500: { date: string; close: number }[] = [];
    try {
      const spRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1y&interval=1d', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (spRes.ok) {
        const spJson = await spRes.json() as any;
        const result = spJson?.chart?.result?.[0];
        if (result) {
          const timestamps = result.timestamp ?? [];
          const closes = result.indicators?.quote?.[0]?.close ?? [];
          sp500 = timestamps.map((t: number, i: number) => ({
            date: new Date(t * 1000).toISOString().split('T')[0],
            close: closes[i],
          })).filter((d: any) => d.close !== null);
        }
      }
    } catch {}

    return res.json({ snapshots, sp500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
