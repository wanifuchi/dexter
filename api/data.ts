/**
 * Unified Data API — /api/data
 * ?type=portfolio | dividends | watchlist | snapshots | tax-goals
 *
 * ポートフォリオ関連APIはBasic認証で保護。
 * チャットAPIは認証不要。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const maxDuration = 30;

// Basic認証が必要なtype一覧
const PROTECTED_TYPES = new Set(['portfolio', 'dividends', 'watchlist', 'snapshots', 'tax-goals', 'alert-rules']);

/**
 * Basic認証チェック
 * 成功: true, 失敗: falseを返しレスポンスを送信済み
 */
function checkBasicAuth(req: VercelRequest, res: VercelResponse): boolean {
  const expectedUser = process.env.PORTFOLIO_BASIC_USER;
  const expectedPass = process.env.PORTFOLIO_BASIC_PASSWORD;

  // 環境変数未設定の場合はパス（ローカル開発用）
  if (!expectedUser || !expectedPass) return true;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Finx Portfolio"');
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
  const [user, pass] = decoded.split(':');

  if (user !== expectedUser || pass !== expectedPass) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Finx Portfolio"');
    res.status(401).json({ error: 'Invalid credentials' });
    return false;
  }

  return true;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = (req.query.type as string) || '';

  // ポートフォリオ関連APIはBasic認証必須
  if (PROTECTED_TYPES.has(type)) {
    if (!checkBasicAuth(req, res)) return;
  }

  switch (type) {
    case 'portfolio': {
      if (req.method === 'POST') {
        const mod = await import('../src/api-handlers/update-shares.js');
        return mod.default(req, res);
      }
      const mod = await import('../src/api-handlers/portfolio.js');
      return mod.default(req, res);
    }
    case 'dividends': {
      const mod = await import('../src/api-handlers/dividends.js');
      return mod.default(req, res);
    }
    case 'watchlist': {
      const mod = await import('../src/api-handlers/watchlist.js');
      return mod.default(req, res);
    }
    case 'snapshots': {
      const mod = await import('../src/api-handlers/snapshots.js');
      return mod.default(req, res);
    }
    case 'tax-goals': {
      const mod = await import('../src/api-handlers/tax-goals.js');
      return mod.default(req, res);
    }
    case 'alert-rules': {
      const mod = await import('../src/api-handlers/alert-rules.js');
      return mod.default(req, res);
    }
    case 'earnings': {
      const mod = await import('../src/api-handlers/earnings-calendar.js');
      return mod.default(req, res);
    }
    case 'chart': {
      // Yahoo Finance chart プロキシ（ブラウザCORS回避）
      const ticker = req.query.ticker as string;
      const range = (req.query.range as string) || '1mo';
      const interval = (req.query.interval as string) || '1d';
      if (!ticker) return res.status(400).json({ error: 'ticker is required' });
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
        const data = await r.json();
        return res.json(data);
      } catch (e) {
        return res.status(502).json({ error: 'Failed to fetch chart data' });
      }
    }
    case 'smart-money': {
      // 議員取引 + 内部者取引（FMP + Finnhub）
      const ticker = (req.query.ticker as string)?.toUpperCase();
      if (!ticker) return res.status(400).json({ error: 'ticker is required' });
      const fmpKey = process.env.FMP_API_KEY;
      const finnhubKey = process.env.FINNHUB_API_KEY;
      try {
        const promises: Promise<any>[] = [];
        // Senate
        promises.push(fmpKey
          ? fetch(`https://financialmodelingprep.com/stable/senate-trades?symbol=${ticker}&apikey=${fmpKey}`).then(r => r.ok ? r.json() : []).catch(() => [])
          : Promise.resolve([]));
        // House
        promises.push(fmpKey
          ? fetch(`https://financialmodelingprep.com/stable/house-trades?symbol=${ticker}&apikey=${fmpKey}`).then(r => r.ok ? r.json() : []).catch(() => [])
          : Promise.resolve([]));
        // Insider
        promises.push(finnhubKey
          ? fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${ticker}&token=${finnhubKey}`).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] }))
          : Promise.resolve({ data: [] }));

        const [senate, house, insider] = await Promise.all(promises);
        const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

        // 議員: buy/sell カウント（直近90日）
        const congressTrades = [...(Array.isArray(senate) ? senate : []), ...(Array.isArray(house) ? house : [])];
        let congressBuys = 0, congressSells = 0;
        for (const t of congressTrades) {
          if ((t.transactionDate ?? '') < ninetyDaysAgo) continue;
          if (/Purchase/i.test(t.type ?? '')) congressBuys++;
          else if (/Sale/i.test(t.type ?? '')) congressSells++;
        }

        // 内部者: open marketのP/Sを集計（直近90日）
        const insiderData = (insider?.data ?? []) as Array<{ filingDate?: string; transactionCode?: string; change?: number; transactionPrice?: number }>;
        let insiderBuys = 0, insiderSells = 0;
        let buyValue = 0, sellValue = 0;
        for (const t of insiderData) {
          if ((t.filingDate ?? '') < ninetyDaysAgo) continue;
          const code = (t.transactionCode || '').toUpperCase();
          const change = Math.abs(t.change ?? 0);
          const value = change * (t.transactionPrice ?? 0);
          if (code === 'P') { insiderBuys++; buyValue += value; }
          else if (code === 'S') { insiderSells++; sellValue += value; }
        }
        const netInsiderValue = buyValue - sellValue;

        return res.json({
          ticker,
          congress: {
            total90d: congressBuys + congressSells,
            buys: congressBuys,
            sells: congressSells,
            sentiment: congressBuys > congressSells * 1.5 ? 'bullish' : congressSells > congressBuys * 1.5 ? 'bearish' : 'neutral',
          },
          insider: {
            total90d: insiderBuys + insiderSells,
            openMarketBuys: insiderBuys,
            openMarketSells: insiderSells,
            netValueUsd: Math.round(netInsiderValue),
            sentiment: insiderBuys > 0 && netInsiderValue > 0 ? 'bullish'
              : insiderSells > insiderBuys * 2 ? 'bearish'
              : insiderBuys === 0 && insiderSells > 5 ? 'caution'
              : 'neutral',
          },
        });
      } catch (e) {
        return res.status(502).json({ error: 'Failed to fetch smart money data' });
      }
    }
    default:
      return res.status(400).json({ error: `Unknown type: ${type}` });
  }
}
