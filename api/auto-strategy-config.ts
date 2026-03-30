/**
 * Vercel Serverless Function — /api/auto-strategy-config
 * 自動戦略の設定を読み書き
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getStrategies } from '../src/backtest/registry.js';

export const maxDuration = 10;

async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const { Redis } = await import('@upstash/redis');
  return new Redis({ url, token });
}

const KEY = 'finx:auto-strategy';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = await getRedis();

  if (req.method === 'GET') {
    let config = null;
    if (redis) {
      try {
        let data = await redis.get(KEY);
        while (typeof data === 'string') { try { data = JSON.parse(data); } catch { break; } }
        config = data;
      } catch {}
    }
    const strategies = getStrategies().map(s => ({ id: s.id, name: s.name, paramDefs: s.paramDefs }));
    return res.json({ config, strategies });
  }

  if (req.method === 'POST') {
    const body = req.body as { enabled?: boolean; strategyId?: string; tickers?: string[]; params?: Record<string, unknown> };
    if (!redis) return res.status(500).json({ error: 'Redis not configured' });
    const config = {
      enabled: body.enabled ?? false,
      strategyId: body.strategyId ?? 'buy-and-hold',
      tickers: body.tickers ?? [],
      params: body.params ?? {},
    };
    await redis.set(KEY, JSON.stringify(config));
    return res.json({ config });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
