/**
 * ポートフォリオの株数を更新するAPIハンドラー
 * POST /api/portfolio
 *   - 既存更新: { ticker, account, shares }
 *   - 新規追加: { ticker, account, shares, avgCost, name? }
 *     avgCostが指定されていれば新規追加、なければ既存のshares更新のみ
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio, savePortfolio } from '../tools/trading/portfolio-store.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { ticker, account, shares, avgCost, name } = req.body || {};

  if (!ticker || typeof shares !== 'number' || shares < 0) {
    return res.status(400).json({ error: '銘柄と株数（0以上）は必須です' });
  }

  const portfolio = await loadPortfolio();
  const upperTicker = String(ticker).toUpperCase().trim();
  const pos = portfolio.positions.find(
    (p) => p.ticker === upperTicker && (!account || p.account === account),
  );

  if (!pos) {
    // 新規追加: avgCost必須
    if (typeof avgCost !== 'number' || avgCost <= 0) {
      return res.status(400).json({
        error: `${upperTicker}は保有銘柄にありません。新規追加する場合は取得単価を指定してください`,
      });
    }

    portfolio.positions.push({
      ticker: upperTicker,
      name: name || upperTicker,
      shares,
      avgCost,
      account: account || 'rakuten-tokutei',
      addedAt: Date.now(),
    });
    await savePortfolio(portfolio);
    return res.json({ ok: true, ticker: upperTicker, shares, avgCost, account: account || 'rakuten-tokutei', action: 'added' });
  }

  if (shares === 0) {
    // 株数0は銘柄削除
    portfolio.positions = portfolio.positions.filter(
      (p) => !(p.ticker === upperTicker && p.account === pos.account),
    );
  } else {
    pos.shares = shares;
    // 新しいavgCostが渡されていれば更新
    if (typeof avgCost === 'number' && avgCost > 0) {
      pos.avgCost = avgCost;
    }
  }

  await savePortfolio(portfolio);

  return res.json({ ok: true, ticker: upperTicker, shares, account: pos.account, action: shares === 0 ? 'deleted' : 'updated' });
}
