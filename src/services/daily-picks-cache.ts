/**
 * Daily Picks キャッシュ（Redis優先 + in-memoryフォールバック）
 * TTL: 10分
 */
import type { DailyPicksResponse } from './daily-picks-types.js';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10分
const REDIS_KEY_PREFIX = 'finx:daily-picks';

let redisClient: any = null;
let redisInitialized = false;

async function getRedis() {
  if (redisInitialized) return redisClient;
  redisInitialized = true;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    redisClient = new Redis({ url, token });
    return redisClient;
  } catch { return null; }
}

// in-memoryフォールバック
const memCache = new Map<string, { data: DailyPicksResponse; expiry: number }>();

function cacheKey(market: string, mode: string): string {
  return `${market}:${mode}`;
}

export async function getCachedPicks(market: string, mode: string): Promise<DailyPicksResponse | null> {
  const key = cacheKey(market, mode);

  // Redis優先
  const redis = await getRedis();
  if (redis) {
    try {
      let data = await redis.get(`${REDIS_KEY_PREFIX}:${key}`);
      while (typeof data === 'string') { try { data = JSON.parse(data); } catch { break; } }
      if (data && typeof data === 'object') return data as DailyPicksResponse;
    } catch {}
  }

  // in-memoryフォールバック
  const entry = memCache.get(key);
  if (entry && entry.expiry > Date.now()) return entry.data;

  return null;
}

export async function setCachedPicks(market: string, mode: string, data: DailyPicksResponse): Promise<void> {
  const key = cacheKey(market, mode);

  // Redis
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(`${REDIS_KEY_PREFIX}:${key}`, JSON.stringify(data), { ex: Math.floor(CACHE_TTL_MS / 1000) });
    } catch {}
  }

  // in-memory
  memCache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
}
