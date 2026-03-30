/**
 * シグナル検出エンジン
 * ポートフォリオ内の銘柄 + アラートルールを照合し、条件を満たすシグナルを返す
 */
import { loadPortfolio } from './portfolio-store.js';
import { loadAlertStore, markTriggered } from './alert-store.js';
import type { AlertRule, Signal, Position } from './types.js';

/** 銘柄の現在データ（外部から渡す） */
export interface TickerSnapshot {
  ticker: string;
  name?: string;
  price?: number;
  previousClose?: number;
  dividendYield?: number;
  per?: number;
  pbr?: number;
}

/**
 * アラートルールを評価し、条件を満たすシグナルを返す
 */
// 同じルールの再通知を防ぐクールダウン（24時間）
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export async function evaluateAlertRules(
  rules: AlertRule[],
  snapshots: Map<string, TickerSnapshot>,
): Promise<Signal[]> {
  const signals: Signal[] = [];
  const now = Date.now();

  for (const rule of rules) {
    if (!rule.enabled) continue;

    // クールダウン中はスキップ
    if (rule.lastTriggeredAt && (now - rule.lastTriggeredAt) < ALERT_COOLDOWN_MS) continue;

    const snap = snapshots.get(rule.ticker);
    if (!snap) continue;

    const signal = evaluateRule(rule, snap);
    if (signal) {
      await markTriggered(rule.id);
      signals.push(signal);
    }
  }

  return signals;
}

// クールダウンをRedisに保存（コールドスタート対策）
async function getSignalRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url, token });
  } catch { return null; }
}

async function isOnCooldown(key: string): Promise<boolean> {
  const redis = await getSignalRedis();
  if (!redis) return false;
  try {
    const val = await redis.get(`finx:cooldown:${key}`);
    return val !== null;
  } catch { return false; }
}

async function setCooldown(key: string, hours: number): Promise<void> {
  const redis = await getSignalRedis();
  if (!redis) return;
  try {
    await redis.set(`finx:cooldown:${key}`, '1', { ex: hours * 3600 });
  } catch {}
}

/**
 * ポートフォリオ内の銘柄に対して基本的な異常検出を行う。
 * 注意: アラートルールが設定済みなら、そちらが優先。
 * この関数は「日次変動率」のみチェック（取得単価からの乖離は常時発火するため除外）。
 * 同じ銘柄は24時間に1回のみ通知。
 */
export async function evaluatePortfolioSignals(
  positions: Position[],
  snapshots: Map<string, TickerSnapshot>,
): Promise<Signal[]> {
  const signals: Signal[] = [];

  const highVolTickers = new Set(['SOXL', 'TQQQ', 'SPXL', 'IREN', 'CIFR', 'WULF', 'MARA', 'RIOT', 'CLSK']);

  for (const pos of positions) {
    const snap = snapshots.get(pos.ticker);
    if (!snap?.price || !snap?.previousClose) continue;

    // 銘柄ごとのボラティリティに応じた閾値
    const threshold = highVolTickers.has(pos.ticker) ? 15 : 10;
    const dayChangePct = ((snap.price - snap.previousClose) / snap.previousClose) * 100;

    if (dayChangePct <= -threshold) {
      // Redisクールダウンチェック（24時間に1回だけ通知）
      const cooldownKey = `portfolio:${pos.ticker}:drop`;
      if (await isOnCooldown(cooldownKey)) continue;

      await setCooldown(cooldownKey, 24);
      signals.push({
        ticker: pos.ticker,
        name: pos.name,
        type: 'change_pct_below',
        currentValue: dayChangePct,
        threshold: -threshold,
        message: `${pos.name}(${pos.ticker}) が本日 ${dayChangePct.toFixed(1)}% 急落（現在値: $${snap.price}, 前日終値: $${snap.previousClose}）`,
        triggeredAt: Date.now(),
      });
    }

    if (dayChangePct >= threshold) {
      const cooldownKey = `portfolio:${pos.ticker}:surge`;
      if (await isOnCooldown(cooldownKey)) continue;

      await setCooldown(cooldownKey, 24);
      signals.push({
        ticker: pos.ticker,
        name: pos.name,
        type: 'change_pct_above',
        currentValue: dayChangePct,
        threshold,
        message: `${pos.name}(${pos.ticker}) が本日 ${dayChangePct.toFixed(1)}% 急騰（現在値: $${snap.price}, 前日終値: $${snap.previousClose}）`,
        triggeredAt: Date.now(),
      });
    }
  }

  return signals;
}

function evaluateRule(rule: AlertRule, snap: TickerSnapshot): Signal | null {
  let currentValue: number | undefined;
  let triggered = false;

  switch (rule.condition) {
    case 'price_above':
      currentValue = snap.price;
      triggered = currentValue !== undefined && currentValue > rule.threshold;
      break;
    case 'price_below':
      currentValue = snap.price;
      triggered = currentValue !== undefined && currentValue < rule.threshold;
      break;
    case 'dividend_yield_above':
      currentValue = snap.dividendYield;
      triggered = currentValue !== undefined && currentValue > rule.threshold;
      break;
    case 'per_below':
      currentValue = snap.per;
      triggered = currentValue !== undefined && currentValue < rule.threshold;
      break;
    case 'pbr_below':
      currentValue = snap.pbr;
      triggered = currentValue !== undefined && currentValue < rule.threshold;
      break;
    case 'change_pct_above': {
      if (snap.price && snap.previousClose) {
        currentValue = ((snap.price - snap.previousClose) / snap.previousClose) * 100;
        triggered = currentValue > rule.threshold;
      }
      break;
    }
    case 'change_pct_below': {
      if (snap.price && snap.previousClose) {
        currentValue = ((snap.price - snap.previousClose) / snap.previousClose) * 100;
        triggered = currentValue < rule.threshold;
      }
      break;
    }
  }

  if (!triggered || currentValue === undefined) return null;

  const conditionLabels: Record<string, string> = {
    price_above: '株価が上限を突破',
    price_below: '株価が下限を割込',
    dividend_yield_above: '配当利回りが閾値超え',
    per_below: 'PERが閾値割れ',
    pbr_below: 'PBRが閾値割れ',
    change_pct_above: '日次上昇率が閾値超え',
    change_pct_below: '日次下落率が閾値超え',
  };

  return {
    ticker: rule.ticker,
    name: rule.name ?? snap.name,
    type: rule.condition,
    currentValue,
    threshold: rule.threshold,
    message: `[${conditionLabels[rule.condition]}] ${snap.name ?? rule.ticker}: 現在値 ${currentValue.toFixed(2)} (閾値: ${rule.threshold})`,
    triggeredAt: Date.now(),
  };
}

/**
 * ポートフォリオ全銘柄 + アラートルール全銘柄のticker一覧を返す
 */
export async function collectWatchedTickers(): Promise<string[]> {
  const portfolio = await loadPortfolio();
  const alertStore = await loadAlertStore();

  const tickers = new Set<string>();
  for (const p of portfolio.positions) tickers.add(p.ticker);
  for (const r of alertStore.rules) if (r.enabled) tickers.add(r.ticker);

  return [...tickers];
}
