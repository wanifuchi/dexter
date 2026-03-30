/**
 * バックテストエンジン
 * 戦略にPriceHistoryを渡し、日次でシミュレーションを実行する
 */
import type {
  BacktestConfig,
  BacktestResult,
  DailySnapshot,
  PriceBar,
  PriceHistory,
  Strategy,
  StrategyState,
  Trade,
  YearlyReturn,
} from './types.js';

/**
 * バックテストを実行
 */
export function runBacktest(
  strategy: Strategy,
  prices: PriceHistory,
  config: BacktestConfig,
  benchmarkPrices?: PriceBar[],
): BacktestResult {
  // 全銘柄の日付を統合してソート
  const allDates = new Set<string>();
  for (const bars of prices.values()) {
    for (const bar of bars) {
      if (bar.date >= config.startDate && bar.date <= config.endDate) {
        allDates.add(bar.date);
      }
    }
  }
  const dates = [...allDates].sort();

  if (dates.length === 0) {
    throw new Error('指定期間に価格データがありません');
  }

  // 各銘柄の価格を日付でインデックス化
  const priceIndex = new Map<string, Map<string, PriceBar>>();
  for (const [ticker, bars] of prices) {
    const dateMap = new Map<string, PriceBar>();
    for (const bar of bars) dateMap.set(bar.date, bar);
    priceIndex.set(ticker, dateMap);
  }

  // 初期状態
  const state: StrategyState = {
    cash: config.initialCapital,
    positions: new Map(),
    trades: [],
  };

  const equityCurve: { date: string; equity: number }[] = [];
  const allTrades: Trade[] = [];

  // 日次ループ
  for (const date of dates) {
    // 当日までの価格データを構築
    const currentPrices: PriceHistory = new Map();
    for (const [ticker, dateMap] of priceIndex) {
      const bars: PriceBar[] = [];
      for (const d of dates) {
        if (d > date) break;
        const bar = dateMap.get(d);
        if (bar) bars.push(bar);
      }
      if (bars.length > 0) currentPrices.set(ticker, bars);
    }

    // 戦略を実行
    const trades = strategy.execute(date, currentPrices, state, config);

    // トレードを適用
    for (const trade of trades) {
      const bar = priceIndex.get(trade.ticker)?.get(date);
      if (!bar) continue;

      if (trade.side === 'buy') {
        const cost = trade.shares * trade.price;
        if (cost > state.cash) continue; // 資金不足
        state.cash -= cost;
        const current = state.positions.get(trade.ticker) ?? 0;
        state.positions.set(trade.ticker, current + trade.shares);
      } else {
        const current = state.positions.get(trade.ticker) ?? 0;
        const sellShares = Math.min(trade.shares, current);
        if (sellShares <= 0) continue;
        state.cash += sellShares * trade.price;
        state.positions.set(trade.ticker, current - sellShares);
      }

      allTrades.push(trade);
      state.trades.push(trade);
    }

    // エクイティ計算
    let equity = state.cash;
    for (const [ticker, shares] of state.positions) {
      const bar = priceIndex.get(ticker)?.get(date);
      if (bar && shares > 0) {
        equity += shares * bar.close;
      }
    }
    equityCurve.push({ date, equity });
  }

  // ベンチマークカーブ
  const benchmarkCurve: { date: string; equity: number }[] = [];
  if (benchmarkPrices && benchmarkPrices.length > 0) {
    const bmFiltered = benchmarkPrices.filter(
      (b) => b.date >= config.startDate && b.date <= config.endDate,
    );
    if (bmFiltered.length > 0) {
      const bmBase = bmFiltered[0].close;
      for (const bar of bmFiltered) {
        benchmarkCurve.push({
          date: bar.date,
          equity: (bar.close / bmBase) * config.initialCapital,
        });
      }
    }
  }

  // サマリー計算
  const summary = computeSummary(equityCurve, config.initialCapital, allTrades);
  const yearlyReturns = computeYearlyReturns(equityCurve);

  return {
    config,
    equityCurve,
    benchmarkCurve,
    trades: allTrades,
    summary,
    yearlyReturns,
  };
}

function computeSummary(
  curve: { date: string; equity: number }[],
  initialCapital: number,
  trades: Trade[],
) {
  const finalEquity = curve[curve.length - 1]?.equity ?? initialCapital;
  const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100;

  // 年数
  const startDate = new Date(curve[0]?.date ?? '2020-01-01');
  const endDate = new Date(curve[curve.length - 1]?.date ?? '2020-01-01');
  const years = Math.max(0.01, (endDate.getTime() - startDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));

  // 年率リターン
  const annualizedReturnPct = (Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100;

  // 最大ドローダウン
  let peak = 0;
  let maxDrawdownPct = 0;
  for (const point of curve) {
    if (point.equity > peak) peak = point.equity;
    const dd = ((peak - point.equity) / peak) * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // シャープレシオ（日次リターンから算出、リスクフリーレート=0）
  const dailyReturns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    dailyReturns.push((curve[i].equity - curve[i - 1].equity) / curve[i - 1].equity);
  }
  const avgReturn = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
  const variance = dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (dailyReturns.length || 1);
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  // 勝率
  const buyTrades = trades.filter((t) => t.side === 'buy');
  const sellTrades = trades.filter((t) => t.side === 'sell');
  let wins = 0;
  for (const sell of sellTrades) {
    const buy = buyTrades.find((b) => b.ticker === sell.ticker && b.date < sell.date);
    if (buy && sell.price > buy.price) wins++;
  }
  const winRate = sellTrades.length > 0 ? (wins / sellTrades.length) * 100 : 0;

  return {
    finalEquity,
    totalReturnPct,
    annualizedReturnPct,
    maxDrawdownPct,
    sharpeRatio,
    totalTrades: trades.length,
    winRate,
  };
}

function computeYearlyReturns(curve: { date: string; equity: number }[]): YearlyReturn[] {
  if (curve.length === 0) return [];

  const byYear = new Map<number, { start: number; end: number }>();
  for (const point of curve) {
    const year = parseInt(point.date.slice(0, 4));
    const entry = byYear.get(year);
    if (!entry) {
      byYear.set(year, { start: point.equity, end: point.equity });
    } else {
      entry.end = point.equity;
    }
  }

  return [...byYear.entries()].map(([year, { start, end }]) => ({
    year,
    returnPct: ((end - start) / start) * 100,
    startEquity: start,
    endEquity: end,
  }));
}
