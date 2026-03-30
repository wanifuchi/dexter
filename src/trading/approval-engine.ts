/**
 * 承認ワークフローエンジン
 * 戦略が売買を提案 → LINEで承認要求 → ユーザーの返信で実行/拒否
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dexterPath } from '../utils/paths.js';
import { sendMessageLine, isLineAvailable } from '../gateway/channels/line/outbound.js';
import { placeMarketOrder } from './paper-engine.js';

export interface ApprovalRequest {
  id: string;
  ticker: string;
  side: 'buy' | 'sell';
  shares: number;
  price: number;
  reason: string;
  strategyId?: string;
  createdAt: number;
  expiresAt: number; // 24時間後に自動期限切れ
}

interface ApprovalStore {
  pending: ApprovalRequest[];
}

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

const APPROVAL_KEY = 'finx:approvals';
const APPROVAL_PATH = dexterPath('trading', 'approvals.json');

async function loadStore(): Promise<ApprovalStore> {
  const redis = await getRedis();
  if (redis) {
    try {
      let data = await redis.get(APPROVAL_KEY);
      while (typeof data === 'string') { try { data = JSON.parse(data); } catch { break; } }
      if (data && typeof data === 'object') return data as ApprovalStore;
    } catch {}
  }
  if (existsSync(APPROVAL_PATH)) {
    try { return JSON.parse(readFileSync(APPROVAL_PATH, 'utf-8')); } catch {}
  }
  return { pending: [] };
}

async function saveStore(store: ApprovalStore): Promise<void> {
  // 期限切れを除去
  store.pending = store.pending.filter(p => p.expiresAt > Date.now());
  const redis = await getRedis();
  if (redis) { try { await redis.set(APPROVAL_KEY, JSON.stringify(store)); } catch {} }
  try {
    mkdirSync(dirname(APPROVAL_PATH), { recursive: true });
    writeFileSync(APPROVAL_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch {}
}

/**
 * 承認リクエストを作成し、LINEに通知
 */
export async function requestApproval(params: {
  ticker: string;
  side: 'buy' | 'sell';
  shares: number;
  price: number;
  reason: string;
  strategyId?: string;
}): Promise<ApprovalRequest> {
  const store = await loadStore();

  const request: ApprovalRequest = {
    id: randomBytes(6).toString('hex'),
    ...params,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };

  store.pending.push(request);
  await saveStore(store);

  // LINE通知
  if (isLineAvailable()) {
    const sideLabel = params.side === 'buy' ? '📈 買い' : '📉 売り';
    await sendMessageLine({
      body: `🔔 売買承認リクエスト\n\n${sideLabel}: ${params.ticker} ${params.shares}株\n価格: $${params.price.toFixed(2)}\n金額: $${(params.shares * params.price).toFixed(2)}\n理由: ${params.reason}\n\n▶ Y = 承認\n▶ N = 拒否\n▶ リスト = 一覧表示`,
    });
  }

  return request;
}

/**
 * 最も古い承認待ちリクエストを承認/拒否
 */
export async function processPendingApproval(
  approved: boolean,
): Promise<{ ticker: string; side: string; shares: number; price: number; orderId?: string } | null> {
  const store = await loadStore();

  // 期限切れを除去
  store.pending = store.pending.filter(p => p.expiresAt > Date.now());

  if (store.pending.length === 0) {
    await saveStore(store);
    return null;
  }

  // 最も古いリクエストを処理
  const request = store.pending.shift()!;
  await saveStore(store);

  if (approved) {
    // ペーパートレードで約定
    try {
      const { order } = await placeMarketOrder(
        request.ticker,
        request.side,
        request.shares,
        request.price,
        `承認済み: ${request.reason}`,
      );
      return { ticker: request.ticker, side: request.side, shares: request.shares, price: request.price, orderId: order.id };
    } catch (err) {
      // 約定失敗（資金不足等）
      if (isLineAvailable()) {
        await sendMessageLine({
          body: `⚠️ 注文失敗: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return null;
    }
  }

  return { ticker: request.ticker, side: request.side, shares: request.shares, price: request.price };
}

/**
 * 承認待ちリクエスト一覧
 */
export async function getPendingApprovals(): Promise<ApprovalRequest[]> {
  const store = await loadStore();
  return store.pending.filter(p => p.expiresAt > Date.now());
}
