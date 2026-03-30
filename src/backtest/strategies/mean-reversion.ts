/**
 * ミーンリバージョン（平均回帰）戦略
 * RSIが売られすぎ圏で買い、買われすぎ圏で売る。
 * ジム・サイモンズのルネサンス・テクノロジーズが活用した統計的アービトラージの基本形。
 */
import type { Strategy, Trade, PriceHistory, StrategyState, BacktestConfig } from '../types.js';

function calcRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export const meanReversion: Strategy = {
  id: 'mean-reversion',
  name: 'ミーンリバージョン（RSI逆張り）',
  description: 'RSIが売られすぎ（30以下）で買い、買われすぎ（70以上）で売る逆張り戦略。ルネサンス・テクノロジーズ等が活用する統計的手法の基本形。',
  paramDefs: [
    { key: 'rsiPeriod', label: 'RSI期間', type: 'number', defaultValue: 14, min: 5, max: 30 },
    { key: 'oversold', label: '買いRSI閾値', type: 'number', defaultValue: 30, min: 10, max: 40 },
    { key: 'overbought', label: '売りRSI閾値', type: 'number', defaultValue: 70, min: 60, max: 90 },
  ],

  execute(date, prices, state, config) {
    const rsiPeriod = (config.params.rsiPeriod as number) ?? 14;
    const oversold = (config.params.oversold as number) ?? 30;
    const overbought = (config.params.overbought as number) ?? 70;
    const trades: Trade[] = [];
    const perTicker = state.cash / config.tickers.length;

    for (const ticker of config.tickers) {
      const bars = prices.get(ticker);
      if (!bars || bars.length < rsiPeriod + 2) continue;
      const closes = bars.map(b => b.close);
      const rsi = calcRSI(closes, rsiPeriod);
      const price = closes[closes.length - 1];
      const held = state.positions.get(ticker) ?? 0;

      if (rsi < oversold && held === 0) {
        const shares = Math.floor(perTicker / price);
        if (shares > 0) {
          trades.push({ date, ticker, side: 'buy', shares, price, value: shares * price, reason: `RSI ${rsi.toFixed(0)} < ${oversold}（売られすぎ）` });
        }
      } else if (rsi > overbought && held > 0) {
        trades.push({ date, ticker, side: 'sell', shares: held, price, value: held * price, reason: `RSI ${rsi.toFixed(0)} > ${overbought}（買われすぎ）` });
      }
    }
    return trades;
  },
};
