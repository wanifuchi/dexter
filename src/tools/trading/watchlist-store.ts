/**
 * ウォッチリスト（監視銘柄）の永続化ストア
 * Upstash Redis優先、ローカルファイルフォールバック
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dexterPath } from '../../utils/paths.js';

export interface WatchlistItem {
  ticker: string;
  name: string;
  note?: string;
  addedAt: number;
}

export interface Watchlist {
  version: 1;
  items: WatchlistItem[];
  updatedAt: number;
}

// Upstash Redis
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

const WATCHLIST_KEY = 'finx:watchlist';
const WATCHLIST_PATH = dexterPath('trading', 'watchlist.json');
const EMPTY: Watchlist = { version: 1, items: [], updatedAt: Date.now() };

export async function loadWatchlist(): Promise<Watchlist> {
  const redis = await getRedis();
  if (redis) {
    try {
      let data = await redis.get(WATCHLIST_KEY);
      while (typeof data === 'string') { try { data = JSON.parse(data); } catch { break; } }
      if (data && typeof data === 'object') return data as Watchlist;
    } catch {}
  }
  if (existsSync(WATCHLIST_PATH)) {
    try { return JSON.parse(readFileSync(WATCHLIST_PATH, 'utf-8')); } catch {}
  }
  return { ...EMPTY, updatedAt: Date.now() };
}

async function save(wl: Watchlist): Promise<void> {
  wl.updatedAt = Date.now();
  const redis = await getRedis();
  if (redis) { try { await redis.set(WATCHLIST_KEY, JSON.stringify(wl)); } catch {} }
  try {
    mkdirSync(dirname(WATCHLIST_PATH), { recursive: true });
    writeFileSync(WATCHLIST_PATH, JSON.stringify(wl, null, 2), 'utf-8');
  } catch {}
}

export async function addToWatchlist(item: Omit<WatchlistItem, 'addedAt'>): Promise<Watchlist> {
  const wl = await loadWatchlist();
  const idx = wl.items.findIndex(i => i.ticker === item.ticker);
  if (idx >= 0) {
    wl.items[idx] = { ...item, addedAt: wl.items[idx].addedAt };
  } else {
    wl.items.push({ ...item, addedAt: Date.now() });
  }
  await save(wl);
  return wl;
}

export async function removeFromWatchlist(ticker: string): Promise<Watchlist> {
  const wl = await loadWatchlist();
  wl.items = wl.items.filter(i => i.ticker !== ticker);
  await save(wl);
  return wl;
}
