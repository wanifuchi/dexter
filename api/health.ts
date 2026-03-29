import type { VercelRequest, VercelResponse } from '@vercel/node';

const DEFAULT_MODEL = process.env.DEXTER_MODEL ?? 'gpt-5.4';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.json({ status: 'ok', model: DEFAULT_MODEL });
}
