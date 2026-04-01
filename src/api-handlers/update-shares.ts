/**
 * ポートフォリオの株数を更新するAPIハンドラー
 * POST /api/portfolio { ticker, account, shares }
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio, savePortfolio } from '../tools/trading/portfolio-store.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { ticker, account, shares } = req.body || {};

  if (!ticker || typeof shares !== 'number' || shares < 0) {
    return res.status(400).json({ error: '銘柄と株数（0以上）は必須です' });
  }

  const portfolio = await loadPortfolio();
  const pos = portfolio.positions.find(
    (p) => p.ticker === ticker && (!account || p.account === account),
  );

  if (!pos) {
    return res.status(404).json({ error: `${ticker}が見つかりません` });
  }

  if (shares === 0) {
    // 株数0は銘柄削除
    portfolio.positions = portfolio.positions.filter(
      (p) => !(p.ticker === ticker && p.account === pos.account),
    );
  } else {
    pos.shares = shares;
  }

  await savePortfolio(portfolio);

  return res.json({ ok: true, ticker, shares, account: pos.account });
}
