/**
 * Vercel Cron Job — /api/cron/auto-strategy
 * 設定された戦略をリアルタイム価格で実行し、
 * 売買シグナルがあればLINE承認リクエストを送る
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPaperAccount } from '../../src/trading/paper-engine.js';
import { requestApproval, getPendingApprovals } from '../../src/trading/approval-engine.js';
import type { PriceBar, PriceHistory, BacktestConfig, StrategyState } from '../../src/backtest/types.js';
import { getStrategy } from '../../src/backtest/registry.js';

export const maxDuration = 30;

// 自動実行の設定をRedisから読む
async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const { Redis } = await import('@upstash/redis');
  return new Redis({ url, token });
}

interface AutoStrategyConfig {
  enabled: boolean;
  strategyId: string;
  tickers: string[];
  params: Record<string, unknown>;
}

const AUTO_STRATEGY_KEY = 'finx:auto-strategy';

async function loadAutoConfig(): Promise<AutoStrategyConfig | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    let data = await redis.get(AUTO_STRATEGY_KEY);
    while (typeof data === 'string') { try { data = JSON.parse(data); } catch { break; } }
    if (data && typeof data === 'object') return data as AutoStrategyConfig;
  } catch {}
  return null;
}

async function fetchPriceHistory(ticker: string): Promise<PriceBar[]> {
  try {
    const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];
    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    if (!result) return [];
    const timestamps = result.timestamp ?? [];
    const quote = result.indicators?.quote?.[0] ?? {};
    return timestamps.map((t: number, i: number) => ({
      date: new Date(t * 1000).toISOString().split('T')[0],
      open: quote.open?.[i] ?? quote.close?.[i] ?? 0,
      high: quote.high?.[i] ?? quote.close?.[i] ?? 0,
      low: quote.low?.[i] ?? quote.close?.[i] ?? 0,
      close: quote.close?.[i] ?? 0,
      volume: quote.volume?.[i] ?? 0,
    })).filter((b: PriceBar) => b.close > 0);
  } catch { return []; }
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
    const config = await loadAutoConfig();
    if (!config || !config.enabled) {
      return res.json({ status: 'ok', message: 'Auto strategy not enabled' });
    }

    const strategy = getStrategy(config.strategyId);
    if (!strategy) {
      return res.json({ status: 'error', message: `Strategy ${config.strategyId} not found` });
    }

    // 既に承認待ちがあれば新たな注文は出さない
    const pending = await getPendingApprovals();
    if (pending.length > 0) {
      return res.json({ status: 'ok', message: `${pending.length} pending approvals, skipping` });
    }

    // 価格データ取得
    const prices: PriceHistory = new Map();
    const priceResults = await Promise.all(config.tickers.map(fetchPriceHistory));
    config.tickers.forEach((t, i) => { if (priceResults[i].length > 0) prices.set(t, priceResults[i]); });

    if (prices.size === 0) {
      return res.json({ status: 'error', message: 'No price data available' });
    }

    // ペーパーアカウントの状態を戦略に渡す
    const account = await loadPaperAccount();
    const state: StrategyState = {
      cash: account.cash,
      positions: new Map(account.positions.map(p => [p.ticker, p.shares])),
      trades: [],
    };

    const today = new Date().toISOString().split('T')[0];
    const btConfig: BacktestConfig = {
      strategyId: config.strategyId,
      tickers: config.tickers,
      startDate: today,
      endDate: today,
      initialCapital: account.initialCash,
      params: config.params,
    };

    // 戦略実行
    const trades = strategy.execute(today, prices, state, btConfig);

    // 売買シグナルがあればLINE承認リクエスト
    const approvals = [];
    for (const trade of trades) {
      const approval = await requestApproval({
        ticker: trade.ticker,
        side: trade.side,
        shares: trade.shares,
        price: trade.price,
        reason: trade.reason,
        strategyId: config.strategyId,
      });
      approvals.push(approval);
    }

    return res.json({
      status: 'ok',
      strategy: config.strategyId,
      tradesGenerated: trades.length,
      approvalsSent: approvals.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
