/**
 * ポートフォリオの株数を更新するAPIハンドラー
 * POST /api/portfolio
 *   - 既存更新: { ticker, account, shares }
 *   - 新規追加: { ticker, account, shares, avgCost, name?, skipAutoAlerts? }
 *     avgCostが指定されていれば新規追加、なければ既存のshares更新のみ
 *     新規追加時はデフォルトアラート4本（利確+15%/損切-10%/日次±6%）を自動登録
 *     skipAutoAlerts: true で自動登録を無効化可能
 *   - 並び順変更: { action: 'reorder', order: Array<{ticker, account}> }
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio, savePortfolio } from '../tools/trading/portfolio-store.js';
import { loadAlertStore, addAlertRule } from '../tools/trading/alert-store.js';
import type { AlertCondition } from '../tools/trading/types.js';

/**
 * 新規ポジションのデフォルトアラートルール4本を作成（重複はスキップ）
 * 返り値: 実際に追加されたルール数
 */
async function createDefaultAlertsFor(
  ticker: string,
  name: string,
  avgCost: number,
): Promise<number> {
  const round = (n: number, digits: number) => Number(n.toFixed(digits));
  const priceDigits = avgCost < 10 ? 2 : avgCost < 100 ? 2 : 2;
  const proposedRules: Array<{ condition: AlertCondition; threshold: number }> = [
    { condition: 'price_above',      threshold: round(avgCost * 1.15, priceDigits) }, // 利確 +15%
    { condition: 'price_below',      threshold: round(avgCost * 0.90, priceDigits) }, // 損切 -10%
    { condition: 'change_pct_above', threshold: 6 },                                   // 日次急騰 +6%
    { condition: 'change_pct_below', threshold: -6 },                                  // 日次急落 -6%
  ];

  const store = await loadAlertStore();
  const existingKeys = new Set(
    store.rules.map((r) => `${r.ticker}|${r.condition}|${r.threshold}`),
  );

  let added = 0;
  for (const rule of proposedRules) {
    const key = `${ticker}|${rule.condition}|${rule.threshold}`;
    if (existingKeys.has(key)) continue;
    await addAlertRule({ ticker, name, condition: rule.condition, threshold: rule.threshold });
    added++;
  }
  return added;
}

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

    // 新規ポジションには自動でアラートルール4本を登録
    let autoAlertsCreated = 0;
    if (!body.skipAutoAlerts) {
      try {
        autoAlertsCreated = await createDefaultAlertsFor(upperTicker, name || upperTicker, avgCost);
      } catch (e) {
        // アラート登録失敗してもポジション追加は成功扱い
        console.error('自動アラート登録エラー:', e);
      }
    }

    return res.json({
      ok: true,
      ticker: upperTicker,
      shares,
      avgCost,
      account: account || 'rakuten-tokutei',
      action: 'added',
      autoAlertsCreated,
    });
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
