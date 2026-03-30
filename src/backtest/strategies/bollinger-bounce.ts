/**
 * ボリンジャーバンド・バウンス戦略
 * ジョン・ボリンジャーが開発した統計的バンドを利用。
 * 下限バンドタッチで買い、上限バンドタッチで売り。
 * レンジ相場で特に有効。
 */
import type { Strategy, Trade, PriceHistory, StrategyState, BacktestConfig } from '../types.js';

function calcBollinger(closes: number[], period: number, stdDevMult: number) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: mean + stdDevMult * stdDev, middle: mean, lower: mean - stdDevMult * stdDev };
}

export const bollingerBounce: Strategy = {
  id: 'bollinger-bounce',
  name: 'ボリンジャーバンド反発',
  description: '株価がボリンジャーバンド下限に触れたら買い、上限に触れたら売り。統計的に価格は平均に回帰する性質を利用。レンジ相場向き。',
  paramDefs: [
    { key: 'period', label: 'MA期間', type: 'number', defaultValue: 20, min: 10, max: 50 },
    { key: 'stdDev', label: '標準偏差倍率', type: 'number', defaultValue: 2, min: 1, max: 3, step: 0.5 },
  ],

  execute(date, prices, state, config) {
    const period = (config.params.period as number) ?? 20;
    const stdDevMult = (config.params.stdDev as number) ?? 2;
    const trades: Trade[] = [];
    const perTicker = state.cash / config.tickers.length;

    for (const ticker of config.tickers) {
      const bars = prices.get(ticker);
      if (!bars || bars.length < period + 1) continue;
      const closes = bars.map(b => b.close);
      const price = closes[closes.length - 1];
      const bb = calcBollinger(closes, period, stdDevMult);
      if (!bb) continue;

      const held = state.positions.get(ticker) ?? 0;

      // 下限バンドにタッチ → 買い
      if (price <= bb.lower && held === 0) {
        const shares = Math.floor(perTicker / price);
        if (shares > 0) {
          trades.push({ date, ticker, side: 'buy', shares, price, value: shares * price, reason: `BB下限タッチ（$${bb.lower.toFixed(2)}）` });
        }
      }
      // 上限バンドにタッチ → 売り
      else if (price >= bb.upper && held > 0) {
        trades.push({ date, ticker, side: 'sell', shares: held, price, value: held * price, reason: `BB上限タッチ（$${bb.upper.toFixed(2)}）` });
      }
    }
    return trades;
  },
};
