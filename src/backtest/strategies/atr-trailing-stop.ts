/**
 * ATRトレーリングストップ戦略
 * チャック・ルボーが開発したシャンデリア・エグジットの変形。
 * 初日に買い、ATR（Average True Range）のN倍でトレーリングストップを設定。
 * ボラティリティに動的に適応する利確/損切り。
 */
import type { Strategy, Trade, PriceHistory, StrategyState, BacktestConfig } from '../types.js';

function calcATR(bars: { high: number; low: number; close: number }[], period: number): number {
  if (bars.length < period + 1) return 0;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    sum += tr;
  }
  return sum / period;
}

// トレーリングストップの高値記録
const peakPrices = new Map<string, number>();

export const atrTrailingStop: Strategy = {
  id: 'atr-trailing-stop',
  name: 'ATRトレーリングストップ',
  description: '初日に購入後、ATR（平均真値幅）のN倍でトレーリングストップ。ボラティリティに動的適応する損切り/利確。チャック・ルボーのシャンデリア・エグジットの変形。',
  paramDefs: [
    { key: 'atrPeriod', label: 'ATR期間', type: 'number', defaultValue: 14, min: 5, max: 30 },
    { key: 'atrMultiple', label: 'ATR倍率', type: 'number', defaultValue: 3, min: 1, max: 5, step: 0.5 },
  ],

  execute(date, prices, state, config) {
    const atrPeriod = (config.params.atrPeriod as number) ?? 14;
    const atrMult = (config.params.atrMultiple as number) ?? 3;
    const trades: Trade[] = [];
    const perTicker = state.cash / config.tickers.length;

    for (const ticker of config.tickers) {
      const bars = prices.get(ticker);
      if (!bars || bars.length < atrPeriod + 2) continue;
      const price = bars[bars.length - 1].close;
      const held = state.positions.get(ticker) ?? 0;

      if (held === 0 && state.trades.filter(t => t.ticker === ticker).length === 0) {
        // 初回購入
        const shares = Math.floor(perTicker / price);
        if (shares > 0) {
          peakPrices.set(ticker, price);
          trades.push({ date, ticker, side: 'buy', shares, price, value: shares * price, reason: '初回エントリー' });
        }
      } else if (held > 0) {
        // ピーク更新
        const peak = peakPrices.get(ticker) ?? price;
        if (price > peak) peakPrices.set(ticker, price);
        const currentPeak = peakPrices.get(ticker) ?? price;

        // ATR計算
        const atr = calcATR(bars, atrPeriod);
        const stopLevel = currentPeak - atr * atrMult;

        if (price < stopLevel) {
          trades.push({ date, ticker, side: 'sell', shares: held, price, value: held * price, reason: `ATRストップ（ピーク$${currentPeak.toFixed(2)} - ATR$${atr.toFixed(2)}×${atrMult} = $${stopLevel.toFixed(2)}）` });
          peakPrices.delete(ticker);
        }
      }
    }
    return trades;
  },
};
