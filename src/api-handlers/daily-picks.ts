/**
 * API Handler — /api/daily-picks
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateDailyPicks } from '../services/daily-picks.js';
import type { DailyPicksMarket, DailyPicksMode } from '../services/daily-picks-types.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const market = 'us' as DailyPicksMarket; // US専用MVP
  const mode = (req.query.mode as string || 'standard') as DailyPicksMode;
  const refresh = req.query.refresh === '1';

  try {
    const result = await generateDailyPicks({ market, mode, refresh });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({
      generatedAt: new Date().toISOString(),
      market, mode,
      status: 'error',
      picks: [],
      warnings: [message],
    });
  }
}
