/**
 * ブレイクアウト戦略（タートルズ方式）
 * リチャード・デニスが1980年代に「タートルズ」に教えた手法。
 * N日間の高値を更新したら買い、N日間の安値を割ったら売り。
 * トレンドの初動を捉えるシステマティック手法。
 */
import type { Strategy, Trade, PriceHistory, StrategyState, BacktestConfig } from '../types.js';

export const breakout: Strategy = {
  id: 'breakout',
  name: 'ブレイクアウト（タートルズ）',
  description: 'N日間の高値更新で買い、M日間の安値割れで売り。1980年代にリチャード・デニスのタートルズが大成功した伝説的手法。',
  paramDefs: [
    { key: 'entryDays', label: 'エントリー期間（日）', type: 'number', defaultValue: 20, min: 5, max: 60 },
    { key: 'exitDays', label: 'エグジット期間（日）', type: 'number', defaultValue: 10, min: 5, max: 40 },
  ],

  execute(date, prices, state, config) {
    const entryDays = (config.params.entryDays as number) ?? 20;
    const exitDays = (config.params.exitDays as number) ?? 10;
    const trades: Trade[] = [];
    const perTicker = state.cash / config.tickers.length;

    for (const ticker of config.tickers) {
      const bars = prices.get(ticker);
      if (!bars || bars.length < entryDays + 1) continue;

      const price = bars[bars.length - 1].close;
      const held = state.positions.get(ticker) ?? 0;

      // エントリー: N日間の高値を更新
      const entryHighs = bars.slice(-entryDays - 1, -1).map(b => b.high);
      const entryHigh = Math.max(...entryHighs);

      if (price > entryHigh && held === 0) {
        const shares = Math.floor(perTicker / price);
        if (shares > 0) {
          trades.push({ date, ticker, side: 'buy', shares, price, value: shares * price, reason: `${entryDays}日高値ブレイクアウト（$${entryHigh.toFixed(2)}突破）` });
        }
      }

      // エグジット: M日間の安値を割れ
      if (held > 0 && bars.length >= exitDays + 1) {
        const exitLows = bars.slice(-exitDays - 1, -1).map(b => b.low);
        const exitLow = Math.min(...exitLows);

        if (price < exitLow) {
          trades.push({ date, ticker, side: 'sell', shares: held, price, value: held * price, reason: `${exitDays}日安値割れ（$${exitLow.toFixed(2)}下抜け）` });
        }
      }
    }
    return trades;
  },
};
