/**
 * Key-Value ストア — Upstash Redis / ローカルファイル フォールバック
 *
 * Vercel環境: Upstash Redis（永続、コールドスタート耐性あり）
 * ローカル環境: .dexter/trading/ のJSONファイル（フォールバック）
 *
 * 必要な環境変数:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dexterPath } from '../../utils/paths.js';
import type { Portfolio, AlertStore } from './types.js';

// Upstash Redis（動的import）
let redisClient: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<unknown> } | null = null;
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
  } catch {
    return null;
  }
}

// ---------- 汎用 get / set ----------

async function kvGet<T>(key: string, fallbackPath: string, defaultValue: T): Promise<T> {
  // Upstash優先
  const redis = await getRedis();
  if (redis) {
    try {
      const data = await redis.get(key);
      if (data !== null && data !== undefined) {
        return (typeof data === 'string' ? JSON.parse(data) : data) as T;
      }
    } catch {
      // Redis失敗 → ファイルフォールバック
    }
  }

  // ファイルフォールバック
  if (existsSync(fallbackPath)) {
    try {
      return JSON.parse(readFileSync(fallbackPath, 'utf-8')) as T;
    } catch {
      // パース失敗
    }
  }

  return defaultValue;
}

async function kvSet<T>(key: string, fallbackPath: string, value: T): Promise<void> {
  // Upstashに書き込み
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(value));
    } catch {
      // Redis失敗 → ファイルにだけ保存
    }
  }

  // ファイルにも常に書き込み（ローカル開発用）
  try {
    const dir = dirname(fallbackPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(fallbackPath, JSON.stringify(value, null, 2), 'utf-8');
  } catch {
    // ファイル書き込み失敗（Vercelの読み取り専用FSなど）
  }
}

// ---------- ポートフォリオ ----------

const PORTFOLIO_KEY = 'finx:portfolio';
const PORTFOLIO_PATH = dexterPath('trading', 'portfolio.json');

const EMPTY_PORTFOLIO: Portfolio = { version: 1, positions: [], updatedAt: Date.now() };

export async function loadPortfolioKV(): Promise<Portfolio> {
  return kvGet<Portfolio>(PORTFOLIO_KEY, PORTFOLIO_PATH, EMPTY_PORTFOLIO);
}

export async function savePortfolioKV(portfolio: Portfolio): Promise<void> {
  portfolio.updatedAt = Date.now();
  await kvSet(PORTFOLIO_KEY, PORTFOLIO_PATH, portfolio);
}

// ---------- アラートルール ----------

const ALERT_KEY = 'finx:alert-rules';
const ALERT_PATH = dexterPath('trading', 'alert-rules.json');

const EMPTY_ALERT_STORE: AlertStore = { version: 1, rules: [] };

export async function loadAlertStoreKV(): Promise<AlertStore> {
  return kvGet<AlertStore>(ALERT_KEY, ALERT_PATH, EMPTY_ALERT_STORE);
}

export async function saveAlertStoreKV(store: AlertStore): Promise<void> {
  await kvSet(ALERT_KEY, ALERT_PATH, store);
}
