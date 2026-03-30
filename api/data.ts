/**
 * Unified Data API — /api/data
 * ?type=portfolio | dividends | watchlist | snapshots
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const maxDuration = 30;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = (req.query.type as string) || '';

  switch (type) {
    case 'portfolio': {
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
    default:
      return res.status(400).json({ error: `Unknown type: ${type}` });
  }
}
