/**
 * Vercel Serverless Function — /api/daily-picks
 * 本日の注目銘柄 API
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const maxDuration = 30;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const mod = await import('../src/api-handlers/daily-picks.js');
  return mod.default(req, res);
}
