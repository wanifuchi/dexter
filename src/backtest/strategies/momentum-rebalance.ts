/**
 * モメンタムリバランス戦略
 * N日間のリターンが高い上位K銘柄に月次で入替。
 * 「強い銘柄を買い、弱い銘柄を売る」トレンドフォロー型。
 */
import type { Strategy, Trade, PriceHistory, StrategyState, BacktestConfig } from '../types.js';

export const momentumRebalance: Strategy = {
  id: 'momentum-rebalance',
  name: 'モメンタムリバランス',
  description: '過去N日の上昇率上位K銘柄に毎月リバランス。トレンドフォロー型戦略。',
  paramDefs: [
    {
      key: 'lookbackDays',
      label: 'モメンタム計測期間（日）',
      type: 'number',
      defaultValue: 60,
      min: 20,
      max: 252,
    },
    {
      key: 'topK',
      label: '保有銘柄数',
      type: 'number',
      defaultValue: 3,
      min: 1,
      max: 20,
    },
    {
      key: 'rebalanceDay',
      label: 'リバランス日',
      type: 'number',
      defaultValue: 1,
      min: 1,
      max: 28,
    },
  ],

  execute(date, prices, state, config) {
    const lookback = (config.params.lookbackDays as number) ?? 60;
    const topK = (config.params.topK as number) ?? 3;
    const rebalanceDay = (config.params.rebalanceDay as number) ?? 1;

    const day = parseInt(date.slice(8, 10));
    const month = date.slice(0, 7);

    // リバランス日判定
    if (day !== rebalanceDay) {
      const alreadyRebalanced = state.trades.some((t) => t.date.startsWith(month));
      if (alreadyRebalanced || day < rebalanceDay) return [];
    }
    if (state.trades.some((t) => t.date.startsWith(month))) return [];

    // 各銘柄のモメンタム（N日間リターン）を計算
    const momentum: { ticker: string; returnPct: number; price: number }[] = [];
    for (const ticker of config.tickers) {
      const bars = prices.get(ticker);
      if (!bars || bars.length < lookback) continue;
      const current = bars[bars.length - 1].close;
      const past = bars[bars.length - lookback]?.close;
      if (!past || past <= 0) continue;

      momentum.push({
        ticker,
        returnPct: ((current - past) / past) * 100,
        price: current,
      });
    }

    // モメンタム上位K銘柄を選定
    momentum.sort((a, b) => b.returnPct - a.returnPct);
    const selected = new Set(momentum.slice(0, topK).map((m) => m.ticker));

    const trades: Trade[] = [];

    // 選定外の銘柄を売却
    for (const [ticker, shares] of state.positions) {
      if (shares > 0 && !selected.has(ticker)) {
        const bars = prices.get(ticker);
        const price = bars?.[bars.length - 1]?.close;
        if (!price) continue;
        trades.push({
          date,
          ticker,
          side: 'sell',
          shares,
          price,
          value: shares * price,
          reason: `モメンタム圏外（${month}）`,
        });
      }
    }

    // 売却後の現金を見積もり
    let estimatedCash = state.cash;
    for (const t of trades) estimatedCash += t.value;

    // 選定銘柄を均等配分で購入
    const selectedList = momentum.filter((m) => selected.has(m.ticker));
    const perTicker = estimatedCash / selectedList.length;

    for (const { ticker, price } of selectedList) {
      const currentShares = state.positions.get(ticker) ?? 0;
      const targetShares = Math.floor(perTicker / price);
      const diff = targetShares - currentShares;

      if (diff > 0) {
        trades.push({
          date,
          ticker,
          side: 'buy',
          shares: diff,
          price,
          value: diff * price,
          reason: `モメンタム上位（${month}）`,
        });
      } else if (diff < 0) {
        trades.push({
          date,
          ticker,
          side: 'sell',
          shares: -diff,
          price,
          value: -diff * price,
          reason: `リバランス調整（${month}）`,
        });
      }
    }

    return trades;
  },
};
