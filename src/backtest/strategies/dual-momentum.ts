/**
 * デュアルモメンタム戦略
 * ゲイリー・アントナッチが著書「Dual Momentum Investing」で提唱。
 * 絶対モメンタム（リスクフリーレートを上回るか）と
 * 相対モメンタム（他の資産より強いか）を組み合わせる。
 * 上昇相場では株式、下落相場ではキャッシュに退避。
 */
import type { Strategy, Trade, PriceHistory, StrategyState, BacktestConfig } from '../types.js';

export const dualMomentum: Strategy = {
  id: 'dual-momentum',
  name: 'デュアルモメンタム',
  description: '絶対+相対モメンタムの組み合わせ。上昇相場では最も強い銘柄に集中、下落相場ではキャッシュに退避。ゲイリー・アントナッチの著名な手法。',
  paramDefs: [
    { key: 'lookbackDays', label: 'モメンタム期間（日）', type: 'number', defaultValue: 252, min: 60, max: 504 },
  ],

  execute(date, prices, state, config) {
    const lookback = (config.params.lookbackDays as number) ?? 252;

    // 月初のみ実行
    const day = parseInt(date.slice(8, 10));
    const month = date.slice(0, 7);
    if (day > 5) return [];
    if (state.trades.some(t => t.date.startsWith(month))) return [];

    const trades: Trade[] = [];

    // 各銘柄の絶対モメンタム（N日リターン）
    const returns: { ticker: string; returnPct: number; price: number }[] = [];
    for (const ticker of config.tickers) {
      const bars = prices.get(ticker);
      if (!bars || bars.length < lookback) continue;
      const current = bars[bars.length - 1].close;
      const past = bars[bars.length - lookback].close;
      returns.push({
        ticker,
        returnPct: ((current - past) / past) * 100,
        price: current,
      });
    }

    // 相対モメンタム: 最もリターンが高い銘柄を選定
    returns.sort((a, b) => b.returnPct - a.returnPct);
    const best = returns[0];

    // 全ポジション精算
    for (const [ticker, shares] of state.positions) {
      if (shares <= 0) continue;
      const bars = prices.get(ticker);
      const price = bars?.[bars.length - 1]?.close;
      if (!price) continue;
      trades.push({ date, ticker, side: 'sell', shares, price, value: shares * price, reason: `デュアルモメンタム入替（${month}）` });
    }

    // 絶対モメンタム: リターンがプラスの場合のみ投資
    if (best && best.returnPct > 0) {
      let estimatedCash = state.cash;
      for (const t of trades) if (t.side === 'sell') estimatedCash += t.value;

      const shares = Math.floor(estimatedCash / best.price);
      if (shares > 0) {
        trades.push({ date, ticker: best.ticker, side: 'buy', shares, price: best.price, value: shares * best.price, reason: `最強モメンタム（${best.returnPct.toFixed(1)}%）` });
      }
    }
    // リターンがマイナス → キャッシュ退避（何も買わない）

    return trades;
  },
};
