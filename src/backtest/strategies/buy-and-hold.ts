/**
 * バイ&ホールド戦略
 * 初日に全銘柄を均等配分で購入し、期間終了まで保持
 */
import type { Strategy, Trade, PriceHistory, StrategyState, BacktestConfig } from '../types.js';

export const buyAndHold: Strategy = {
  id: 'buy-and-hold',
  name: 'バイ&ホールド',
  description: '初日に全銘柄を均等配分で購入し、そのまま保持する最もシンプルな戦略。売買コスト最小。他の戦略のベンチマークとして有用。',
  paramDefs: [],

  execute(date, prices, state, config) {
    // 初日のみ購入
    if (state.trades.length > 0) return [];

    const trades: Trade[] = [];
    const perTicker = state.cash / config.tickers.length;

    for (const ticker of config.tickers) {
      const bars = prices.get(ticker);
      if (!bars || bars.length === 0) continue;
      const price = bars[bars.length - 1].close;
      const shares = Math.floor(perTicker / price);
      if (shares <= 0) continue;

      trades.push({
        date,
        ticker,
        side: 'buy',
        shares,
        price,
        value: shares * price,
        reason: '均等配分購入',
      });
    }

    return trades;
  },
};
