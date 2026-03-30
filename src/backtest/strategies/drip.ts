/**
 * 配当再投資（DRIP）戦略
 * 初日に全銘柄を均等配分で購入し、受け取った配当を自動的に同じ銘柄に再投資。
 * バイ&ホールドとの比較で複利効果を可視化する。
 */
import type { Strategy, Trade, PriceHistory, StrategyState, BacktestConfig } from '../types.js';

export const drip: Strategy = {
  id: 'drip',
  name: '配当再投資（DRIP）',
  description: '配当金を自動的に同じ銘柄に再投資。複利効果で長期リターンが大きく向上する。バイ&ホールドとの比較に最適。',
  paramDefs: [
    { key: 'dividendYield', label: '想定年間配当利回り(%)', type: 'number', defaultValue: 3, min: 0.5, max: 15, step: 0.5 },
  ],

  execute(date, prices, state, config) {
    const annualYield = (config.params.dividendYield as number) ?? 3;
    const trades: Trade[] = [];

    // 初日: 全銘柄を均等配分で購入
    if (state.trades.length === 0) {
      const perTicker = state.cash / config.tickers.length;
      for (const ticker of config.tickers) {
        const bars = prices.get(ticker);
        if (!bars || bars.length === 0) continue;
        const price = bars[bars.length - 1].close;
        const shares = Math.floor(perTicker / price);
        if (shares > 0) {
          trades.push({ date, ticker, side: 'buy', shares, price, value: shares * price, reason: '均等配分購入' });
        }
      }
      return trades;
    }

    // 四半期末（3月末、6月末、9月末、12月末）に配当再投資をシミュレート
    const month = parseInt(date.slice(5, 7));
    const day = parseInt(date.slice(8, 10));
    const isQuarterEnd = [3, 6, 9, 12].includes(month) && day >= 28;

    // 同じ四半期末で既に再投資済みならスキップ
    const quarterKey = date.slice(0, 7);
    if (isQuarterEnd && !state.trades.some(t => t.date.startsWith(quarterKey) && t.reason.includes('配当再投資'))) {
      const quarterlyYield = annualYield / 100 / 4;

      for (const ticker of config.tickers) {
        const held = state.positions.get(ticker) ?? 0;
        if (held <= 0) continue;
        const bars = prices.get(ticker);
        if (!bars || bars.length === 0) continue;
        const price = bars[bars.length - 1].close;

        // 配当額 = 保有株数 × 株価 × 四半期利回り
        const dividendAmount = held * price * quarterlyYield;
        const reinvestShares = Math.floor(dividendAmount / price);
        if (reinvestShares > 0) {
          // 配当分のキャッシュを加算してから再投資
          state.cash += dividendAmount;
          trades.push({
            date, ticker, side: 'buy', shares: reinvestShares,
            price, value: reinvestShares * price,
            reason: `配当再投資（Q${Math.ceil(month / 3)} 配当$${dividendAmount.toFixed(2)}）`,
          });
        }
      }
    }

    return trades;
  },
};
