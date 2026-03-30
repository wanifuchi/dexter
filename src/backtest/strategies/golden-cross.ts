/**
 * ゴールデンクロス / デッドクロス戦略
 * 短期移動平均が長期移動平均を上抜け（ゴールデンクロス）で買い、
 * 下抜け（デッドクロス）で売り。
 * ウォール街で最も古典的なトレンドフォロー手法。
 */
import type { Strategy, Trade, PriceHistory, StrategyState, BacktestConfig } from '../types.js';

function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

export const goldenCross: Strategy = {
  id: 'golden-cross',
  name: 'ゴールデンクロス',
  description: '短期移動平均線（50日）が長期移動平均線（200日）を上抜けたら買い、下抜けたら売り。最も古典的なトレンドフォロー手法。',
  paramDefs: [
    { key: 'shortPeriod', label: '短期MA期間', type: 'number', defaultValue: 50, min: 5, max: 100 },
    { key: 'longPeriod', label: '長期MA期間', type: 'number', defaultValue: 200, min: 50, max: 300 },
  ],

  execute(date, prices, state, config) {
    const shortP = (config.params.shortPeriod as number) ?? 50;
    const longP = (config.params.longPeriod as number) ?? 200;
    const trades: Trade[] = [];
    const perTicker = state.cash / config.tickers.length;

    for (const ticker of config.tickers) {
      const bars = prices.get(ticker);
      if (!bars || bars.length < longP + 2) continue;
      const closes = bars.map(b => b.close);
      const price = closes[closes.length - 1];

      const shortNow = sma(closes, shortP);
      const longNow = sma(closes, longP);
      const shortPrev = sma(closes.slice(0, -1), shortP);
      const longPrev = sma(closes.slice(0, -1), longP);

      if (!shortNow || !longNow || !shortPrev || !longPrev) continue;

      const held = state.positions.get(ticker) ?? 0;

      // ゴールデンクロス: 短期が長期を下から上に突き抜け
      if (shortPrev <= longPrev && shortNow > longNow && held === 0) {
        const shares = Math.floor(perTicker / price);
        if (shares > 0) {
          trades.push({ date, ticker, side: 'buy', shares, price, value: shares * price, reason: `ゴールデンクロス（${shortP}MA > ${longP}MA）` });
        }
      }
      // デッドクロス: 短期が長期を上から下に突き抜け
      else if (shortPrev >= longPrev && shortNow < longNow && held > 0) {
        trades.push({ date, ticker, side: 'sell', shares: held, price, value: held * price, reason: `デッドクロス（${shortP}MA < ${longP}MA）` });
      }
    }
    return trades;
  },
};
