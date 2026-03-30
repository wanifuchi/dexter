/**
 * 税金シミュレーター + 目標設定 API
 * GET: 現在のポートフォリオから税金試算 + 目標進捗を返す
 * POST: 目標を設定/更新
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio } from '../tools/trading/portfolio-store.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dexterPath } from '../utils/paths.js';

export const maxDuration = 30;

// --- 目標設定ストア ---
interface Goals {
  dividendTarget: number; // 年間配当目標（円）
  assetTarget: number;    // 資産目標（円）
}

const GOALS_KEY = 'finx:goals';
const GOALS_PATH = dexterPath('trading', 'goals.json');
const DEFAULT_GOALS: Goals = { dividendTarget: 4000000, assetTarget: 100000000 };

async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url, token });
  } catch { return null; }
}

async function loadGoals(): Promise<Goals> {
  const redis = await getRedis();
  if (redis) {
    try {
      let data = await redis.get(GOALS_KEY);
      while (typeof data === 'string') { try { data = JSON.parse(data); } catch { break; } }
      if (data && typeof data === 'object') return data as Goals;
    } catch {}
  }
  if (existsSync(GOALS_PATH)) {
    try { return JSON.parse(readFileSync(GOALS_PATH, 'utf-8')); } catch {}
  }
  return DEFAULT_GOALS;
}

async function saveGoals(goals: Goals): Promise<void> {
  const redis = await getRedis();
  if (redis) { try { await redis.set(GOALS_KEY, JSON.stringify(goals)); } catch {} }
  try {
    mkdirSync(dirname(GOALS_PATH), { recursive: true });
    writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2), 'utf-8');
  } catch {}
}

// --- 税金計算 ---
interface TaxEstimate {
  // 譲渡益（含み益の利確想定）
  unrealizedGainUsd: number;
  unrealizedGainJpy: number;
  // 特定口座の譲渡益税（20.315%）
  capitalGainsTaxJpy: number;
  // NISA口座の非課税分
  nisaExemptJpy: number;
  // 配当に対する税（米国源泉10% + 国内20.315%）
  dividendTaxJpy: number;
  // 合計税額
  totalTaxJpy: number;
  // 外国税額控除（確定申告で還付可能な額）
  foreignTaxCreditJpy: number;
  // 手取り
  netAfterTaxJpy: number;
}

async function fetchUsdJpy(): Promise<number> {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?range=1d&interval=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (res.ok) {
      const json = await res.json() as any;
      const rate = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof rate === 'number') return rate;
    }
  } catch {}
  return 150;
}

async function fetchPrice(ticker: string): Promise<number | null> {
  try {
    const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
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

  if (req.method === 'POST') {
    const body = req.body as Partial<Goals>;
    const current = await loadGoals();
    if (body.dividendTarget !== undefined) current.dividendTarget = body.dividendTarget;
    if (body.assetTarget !== undefined) current.assetTarget = body.assetTarget;
    await saveGoals(current);
    return res.json({ goals: current });
  }

  try {
    const [portfolio, goals, usdJpy] = await Promise.all([
      loadPortfolio(),
      loadGoals(),
      fetchUsdJpy(),
    ]);

    // 現在価格取得
    const tickers = [...new Set(portfolio.positions.map(p => p.ticker))];
    const prices = await Promise.all(tickers.map(fetchPrice));
    const priceMap = new Map(tickers.map((t, i) => [t, prices[i]]));

    // 口座別の含み益を計算
    let nisaGainUsd = 0;
    let tokuteiGainUsd = 0;
    let totalValueUsd = 0;
    let totalCostUsd = 0;

    for (const pos of portfolio.positions) {
      const price = priceMap.get(pos.ticker);
      if (!price) continue;
      const gain = (price - pos.avgCost) * pos.shares;
      const value = price * pos.shares;
      totalValueUsd += value;
      totalCostUsd += pos.avgCost * pos.shares;

      if (gain > 0) {
        if (pos.account.includes('nisa')) {
          nisaGainUsd += gain;
        } else {
          tokuteiGainUsd += gain;
        }
      }
    }

    // 税金計算
    const JP_TAX_RATE = 0.20315;
    const US_WITHHOLDING_RATE = 0.10;

    // 譲渡益税（特定口座のみ。NISAは非課税）
    const capitalGainsTaxJpy = tokuteiGainUsd * usdJpy * JP_TAX_RATE;
    const nisaExemptJpy = nisaGainUsd * usdJpy * JP_TAX_RATE; // 節税額

    // 配当税（簡易: 年間配当額の推定は配当APIと同じロジックだが、ここでは概算）
    // 配当の二重課税: 米国源泉10% → 残りに日本20.315%
    // NISA: 米国源泉10%のみ、日本税なし
    // 特定: 米国源泉10% + 日本20.315%（外国税額控除で一部還付可能）

    const totalTaxJpy = capitalGainsTaxJpy;
    const foreignTaxCreditJpy = tokuteiGainUsd > 0 ? 0 : 0; // 譲渡益には外国税額控除なし

    const totalGainJpy = (tokuteiGainUsd + nisaGainUsd) * usdJpy;

    // 目標進捗
    const currentAssetJpy = totalValueUsd * usdJpy;
    const assetProgress = goals.assetTarget > 0 ? (currentAssetJpy / goals.assetTarget) * 100 : 0;

    return res.json({
      tax: {
        unrealizedGainUsd: tokuteiGainUsd + nisaGainUsd,
        unrealizedGainJpy: totalGainJpy,
        capitalGainsTaxJpy,
        nisaExemptJpy,
        totalTaxJpy,
        netAfterTaxJpy: totalGainJpy - totalTaxJpy,
        tokuteiGainUsd,
        nisaGainUsd,
      },
      goals,
      progress: {
        currentAssetJpy,
        assetProgress: Math.min(100, assetProgress),
        assetRemaining: Math.max(0, goals.assetTarget - currentAssetJpy),
      },
      usdJpy,
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
