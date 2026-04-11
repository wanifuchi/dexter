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
const PROTECTED_TYPES = new Set(['portfolio', 'dividends', 'watchlist', 'snapshots', 'tax-goals']);

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    case 'earnings': {
      const mod = await import('../src/api-handlers/earnings-calendar.js');
      return mod.default(req, res);
    }
    default:
      return res.status(400).json({ error: `Unknown type: ${type}` });
  }
}
