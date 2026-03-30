/**
 * ペーパートレードエンジン
 * 仮想口座での注文管理・約定・ポジション管理
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dexterPath } from '../utils/paths.js';
import type { PaperAccount, PaperOrder, PaperPosition, OrderSide, OrderType } from './types.js';

const PAPER_KEY = 'finx:paper-account';
const PAPER_PATH = dexterPath('trading', 'paper-account.json');
const DEFAULT_CASH = 100000; // $100,000

// --- Redis ---
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

function emptyAccount(): PaperAccount {
  return { version: 1, cash: DEFAULT_CASH, initialCash: DEFAULT_CASH, positions: [], orders: [], updatedAt: Date.now() };
}

export async function loadPaperAccount(): Promise<PaperAccount> {
  const redis = await getRedis();
  if (redis) {
    try {
      let data = await redis.get(PAPER_KEY);
      while (typeof data === 'string') { try { data = JSON.parse(data); } catch { break; } }
      if (data && typeof data === 'object') return data as PaperAccount;
    } catch {}
  }
  if (existsSync(PAPER_PATH)) {
    try { return JSON.parse(readFileSync(PAPER_PATH, 'utf-8')); } catch {}
  }
  return emptyAccount();
}

async function save(account: PaperAccount): Promise<void> {
  account.updatedAt = Date.now();
  const redis = await getRedis();
  if (redis) { try { await redis.set(PAPER_KEY, JSON.stringify(account)); } catch {} }
  try {
    mkdirSync(dirname(PAPER_PATH), { recursive: true });
    writeFileSync(PAPER_PATH, JSON.stringify(account, null, 2), 'utf-8');
  } catch {}
}

/**
 * 成行注文を即時約定
 */
export async function placeMarketOrder(
  ticker: string, side: OrderSide, shares: number, currentPrice: number, reason: string,
): Promise<{ order: PaperOrder; account: PaperAccount }> {
  const account = await loadPaperAccount();
  const order: PaperOrder = {
    id: randomBytes(6).toString('hex'),
    ticker, side, type: 'market', shares,
    status: 'filled', filledPrice: currentPrice, filledAt: Date.now(),
    createdAt: Date.now(), reason,
  };

  if (side === 'buy') {
    const cost = shares * currentPrice;
    if (cost > account.cash) throw new Error(`資金不足: 必要$${cost.toFixed(2)}, 残高$${account.cash.toFixed(2)}`);
    account.cash -= cost;

    const pos = account.positions.find(p => p.ticker === ticker);
    if (pos) {
      const totalCost = pos.avgCost * pos.shares + currentPrice * shares;
      pos.shares += shares;
      pos.avgCost = totalCost / pos.shares;
    } else {
      account.positions.push({ ticker, shares, avgCost: currentPrice });
    }
  } else {
    const pos = account.positions.find(p => p.ticker === ticker);
    if (!pos || pos.shares < shares) throw new Error(`ポジション不足: ${ticker} ${pos?.shares ?? 0}株保有`);
    account.cash += shares * currentPrice;
    pos.shares -= shares;
    if (pos.shares === 0) {
      account.positions = account.positions.filter(p => p.ticker !== ticker);
    }
  }

  account.orders.push(order);
  // 注文履歴は直近200件のみ保持
  if (account.orders.length > 200) account.orders = account.orders.slice(-200);
  await save(account);
  return { order, account };
}

/**
 * 指値注文を登録（pendingのまま）
 */
export async function placeLimitOrder(
  ticker: string, side: OrderSide, shares: number, limitPrice: number, reason: string,
): Promise<{ order: PaperOrder; account: PaperAccount }> {
  const account = await loadPaperAccount();
  const order: PaperOrder = {
    id: randomBytes(6).toString('hex'),
    ticker, side, type: 'limit', shares, limitPrice,
    status: 'pending', createdAt: Date.now(), reason,
  };
  account.orders.push(order);
  await save(account);
  return { order, account };
}

/**
 * 未約定の指値注文をチェックし、条件を満たしたものを約定する
 */
export async function checkPendingOrders(
  prices: Map<string, number>,
): Promise<PaperOrder[]> {
  const account = await loadPaperAccount();
  const filled: PaperOrder[] = [];

  for (const order of account.orders) {
    if (order.status !== 'pending' || !order.limitPrice) continue;
    const price = prices.get(order.ticker);
    if (!price) continue;

    let shouldFill = false;
    if (order.side === 'buy' && price <= order.limitPrice) shouldFill = true;
    if (order.side === 'sell' && price >= order.limitPrice) shouldFill = true;

    if (shouldFill) {
      // 約定処理
      if (order.side === 'buy') {
        const cost = order.shares * price;
        if (cost > account.cash) { order.status = 'cancelled'; continue; }
        account.cash -= cost;
        const pos = account.positions.find(p => p.ticker === order.ticker);
        if (pos) {
          const totalCost = pos.avgCost * pos.shares + price * order.shares;
          pos.shares += order.shares;
          pos.avgCost = totalCost / pos.shares;
        } else {
          account.positions.push({ ticker: order.ticker, shares: order.shares, avgCost: price });
        }
      } else {
        const pos = account.positions.find(p => p.ticker === order.ticker);
        if (!pos || pos.shares < order.shares) { order.status = 'cancelled'; continue; }
        account.cash += order.shares * price;
        pos.shares -= order.shares;
        if (pos.shares === 0) {
          account.positions = account.positions.filter(p => p.ticker !== order.ticker);
        }
      }
      order.status = 'filled';
      order.filledPrice = price;
      order.filledAt = Date.now();
      filled.push(order);
    }
  }

  if (filled.length > 0) await save(account);
  return filled;
}

/**
 * 注文をキャンセル
 */
export async function cancelOrder(orderId: string): Promise<boolean> {
  const account = await loadPaperAccount();
  const order = account.orders.find(o => o.id === orderId && o.status === 'pending');
  if (!order) return false;
  order.status = 'cancelled';
  await save(account);
  return true;
}

/**
 * ペーパーアカウントをリセット
 */
export async function resetPaperAccount(initialCash?: number): Promise<PaperAccount> {
  const account = emptyAccount();
  if (initialCash) { account.cash = initialCash; account.initialCash = initialCash; }
  await save(account);
  return account;
}
