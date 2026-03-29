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
export function evaluateAlertRules(
  rules: AlertRule[],
  snapshots: Map<string, TickerSnapshot>,
): Signal[] {
  const signals: Signal[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    const snap = snapshots.get(rule.ticker);
    if (!snap) continue;

    const signal = evaluateRule(rule, snap);
    if (signal) {
      markTriggered(rule.id);
      signals.push(signal);
    }
  }

  return signals;
}

/**
 * ポートフォリオ内の銘柄に対して基本的な異常検出を行う
 */
export function evaluatePortfolioSignals(
  positions: Position[],
  snapshots: Map<string, TickerSnapshot>,
): Signal[] {
  const signals: Signal[] = [];

  for (const pos of positions) {
    const snap = snapshots.get(pos.ticker);
    if (!snap?.price) continue;

    // 取得単価からの下落率チェック（-10%以上の下落）
    const changePct = ((snap.price - pos.avgCost) / pos.avgCost) * 100;
    if (changePct <= -10) {
      signals.push({
        ticker: pos.ticker,
        name: pos.name,
        type: 'change_pct_below',
        currentValue: changePct,
        threshold: -10,
        message: `${pos.name}(${pos.ticker}) が取得単価から ${changePct.toFixed(1)}% 下落中（現在値: ${snap.price}, 取得単価: ${pos.avgCost}）`,
        triggeredAt: Date.now(),
      });
    }

    // 取得単価からの上昇率チェック（+20%以上の上昇）
    if (changePct >= 20) {
      signals.push({
        ticker: pos.ticker,
        name: pos.name,
        type: 'change_pct_above',
        currentValue: changePct,
        threshold: 20,
        message: `${pos.name}(${pos.ticker}) が取得単価から ${changePct.toFixed(1)}% 上昇中（現在値: ${snap.price}, 取得単価: ${pos.avgCost}）`,
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
export function collectWatchedTickers(): string[] {
  const portfolio = loadPortfolio();
  const alertStore = loadAlertStore();

  const tickers = new Set<string>();
  for (const p of portfolio.positions) tickers.add(p.ticker);
  for (const r of alertStore.rules) if (r.enabled) tickers.add(r.ticker);

  return [...tickers];
}
