/**
 * Unified Cron Handler — /api/cron
 * ?job=scan-alerts | snapshot | news-alerts | auto-strategy
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const maxDuration = 60;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const job = (req.query.job as string) || '';

  // Auth
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  switch (job) {
    case 'scan-alerts': {
      const mod = await import('./scan-alerts.js');
      return mod.default(req, res);
    }
    case 'snapshot': {
      const mod = await import('./snapshot.js');
      return mod.default(req, res);
    }
    case 'news-alerts': {
      const mod = await import('./news-alerts.js');
      return mod.default(req, res);
    }
    case 'auto-strategy': {
      const mod = await import('./auto-strategy.js');
      return mod.default(req, res);
    }
    default:
      return res.status(400).json({ error: `Unknown job: ${job}. Use ?job=scan-alerts|snapshot|news-alerts|auto-strategy` });
  }
}
