/**
 * アラートルール管理API
 * DELETE /api/alert-rules?id=<ruleId>  — ルール削除
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { removeAlertRule } from '../tools/trading/alert-store.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'DELETE') {
    const id = (req.query.id as string) || (req.body && req.body.id);
    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }
    const removed = await removeAlertRule(String(id));
    if (!removed) {
      return res.status(404).json({ error: 'rule not found' });
    }
    return res.json({ ok: true, id });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
