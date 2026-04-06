/**
 * Vercel Serverless Function — /api/conversations
 * スレッド一覧取得・単一スレッド取得
 *
 * GET /api/conversations             → スレッド一覧
 * GET /api/conversations?id=threadId → 単一スレッドの全ターン
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listThreads, getTurns } from '../src/conversation/index.js';

export const maxDuration = 10;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const threadId = req.query.id as string | undefined;

  try {
    if (threadId) {
      const turns = await getTurns(threadId);
      return res.json({ threadId, turns });
    }
    const threads = await listThreads(50);
    return res.json({ threads });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
