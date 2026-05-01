/**
 * ポートフォリオの株数を更新するAPIハンドラー
 * POST /api/portfolio
 *   - 既存更新: { ticker, account, shares }
 *   - 新規追加: { ticker, account, shares, avgCost, name? }
 *     avgCostが指定されていれば新規追加、なければ既存のshares更新のみ
 *   - 並び順変更: { action: 'reorder', order: Array<{ticker, account}> }
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio, savePortfolio } from '../tools/trading/portfolio-store.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const body = req.body || {};

  if (body.action === 'reorder') {
    const order = body.order;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order配列は必須です' });
    }
    const portfolio = await loadPortfolio();
    const keyOf = (ticker: string, account: string) => `${ticker}::${account}`;
    const indexMap = new Map<string, number>();
    order.forEach((o, i) => {
      if (o && typeof o.ticker === 'string' && typeof o.account === 'string') {
        indexMap.set(keyOf(o.ticker, o.account), i);
      }
    });
    portfolio.positions.sort((a, b) => {
      const ai = indexMap.get(keyOf(a.ticker, a.account));
      const bi = indexMap.get(keyOf(b.ticker, b.account));
      // 指定がない要素は末尾に
      const av = ai ?? Number.MAX_SAFE_INTEGER;
      const bv = bi ?? Number.MAX_SAFE_INTEGER;
      return av - bv;
    });
    await savePortfolio(portfolio);
    return res.json({ ok: true, action: 'reordered', count: portfolio.positions.length });
  }

  const { ticker, account, shares, avgCost, name } = body;

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
