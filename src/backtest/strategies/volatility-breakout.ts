/**
 * ボラティリティ・ブレイクアウト（ラリー・ウィリアムズ方式）
 * ラリー・ウィリアムズが1987年ロビンスカップで11,376%リターンを達成した手法。
 * 前日のレンジ（高値-安値）にK倍を掛けた幅を当日の始値に加え、
 * その水準を超えたら買い。当日引けで決済。
 *
 * ※バックテストでは簡易的に日足ベースで実装（引け決済を翌日に置き換え）
 */
import type { Strategy, Trade, PriceHistory, StrategyState, BacktestConfig } from '../types.js';

export const volatilityBreakout: Strategy = {
  id: 'volatility-breakout',
  name: 'ボラティリティ・ブレイクアウト',
  description: '前日の値幅×K倍を始値に加算し、その水準を超えたら買い。ラリー・ウィリアムズが年間11,376%リターンを達成した伝説的手法。',
  paramDefs: [
    { key: 'kFactor', label: 'K係数', type: 'number', defaultValue: 0.5, min: 0.1, max: 1.0, step: 0.1 },
  ],

  execute(date, prices, state, config) {
    const k = (config.params.kFactor as number) ?? 0.5;
    const trades: Trade[] = [];
    const perTicker = state.cash / config.tickers.length;

    for (const ticker of config.tickers) {
      const bars = prices.get(ticker);
      if (!bars || bars.length < 3) continue;

      const today = bars[bars.length - 1];
      const yesterday = bars[bars.length - 2];
      const held = state.positions.get(ticker) ?? 0;

      // 前日ポジションがあれば引けで決済（翌日始値で近似）
      if (held > 0) {
        trades.push({
          date, ticker, side: 'sell', shares: held,
          price: today.open, value: held * today.open,
          reason: '翌日始値で決済',
        });
      }

      // ブレイクアウト判定
      const prevRange = yesterday.high - yesterday.low;
      const breakoutLevel = today.open + prevRange * k;

      if (today.high > breakoutLevel) {
        const entryPrice = breakoutLevel; // ブレイクアウト水準で約定と仮定
        const shares = Math.floor(perTicker / entryPrice);
        if (shares > 0) {
          trades.push({
            date, ticker, side: 'buy', shares,
            price: entryPrice, value: shares * entryPrice,
            reason: `ボラBK（始値$${today.open.toFixed(2)}+レンジ$${prevRange.toFixed(2)}×${k}=$${breakoutLevel.toFixed(2)}突破）`,
          });
        }
      }
    }
    return trades;
  },
};
