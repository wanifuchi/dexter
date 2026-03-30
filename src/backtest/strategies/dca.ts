/**
 * ドルコスト平均法（DCA）戦略
 * 毎月指定日に均等配分で定額買付
 */
import type { Strategy, Trade, PriceHistory, StrategyState, BacktestConfig } from '../types.js';

export const dca: Strategy = {
  id: 'dca',
  name: 'ドルコスト平均法',
  description: '毎月定額を均等配分で買付する積立投資。高値で少なく、安値で多く買うため平均取得単価が下がりやすい。長期投資の王道。',
  paramDefs: [
    {
      key: 'buyDay',
      label: '毎月の買付日',
      type: 'number',
      defaultValue: 1,
      min: 1,
      max: 28,
    },
    {
      key: 'monthlyAmount',
      label: '月額投資額（$）',
      type: 'number',
      defaultValue: 1000,
      min: 100,
      step: 100,
    },
  ],

  execute(date, prices, state, config) {
    const buyDay = (config.params.buyDay as number) ?? 1;
    const monthlyAmount = (config.params.monthlyAmount as number) ?? 1000;

    // 買付日かチェック（当日 or その月で最も近い営業日）
    const day = parseInt(date.slice(8, 10));
    if (day !== buyDay) {
      // 月初に買付日を過ぎていたら初回だけ許可
      const month = date.slice(0, 7);
      const alreadyBought = state.trades.some((t) => t.date.startsWith(month));
      if (alreadyBought || day < buyDay) return [];
    }

    // 今月既に買付済みならスキップ
    const month = date.slice(0, 7);
    if (state.trades.some((t) => t.date.startsWith(month))) return [];

    // 資金チェック
    const amount = Math.min(monthlyAmount, state.cash);
    if (amount < 10) return [];

    const trades: Trade[] = [];
    const perTicker = amount / config.tickers.length;

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
        reason: `DCA月次買付（${month}）`,
      });
    }

    return trades;
  },
};
