/**
 * Vercel Serverless Function — /api/line-webhook
 * LINE Messaging API Webhook
 * ユーザーの返信を受け取り、承認ワークフローを処理する
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { processPendingApproval, getPendingApprovals } from '../src/trading/approval-engine.js';
import { sendMessageLine } from '../src/gateway/channels/line/outbound.js';

export const maxDuration = 10;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // LINEのWebhook検証（URLの確認リクエスト）
  if (req.method === 'GET') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  try {
    const body = req.body as { events?: any[] };
    const events = body?.events ?? [];

    for (const event of events) {
      if (event.type !== 'message' || event.message?.type !== 'text') continue;

      const text = (event.message.text ?? '').trim().toUpperCase();
      const userId = event.source?.userId;

      // 承認/拒否の判定
      if (text === 'Y' || text === 'YES' || text === 'OK' || text === 'はい') {
        const result = await processPendingApproval(true);
        if (result) {
          await sendMessageLine({
            body: `✅ 承認しました\n${result.ticker} ${result.side === 'buy' ? '買い' : '売り'} ${result.shares}株 @ $${result.price.toFixed(2)}\n注文ID: ${result.orderId}`,
          });
        } else {
          await sendMessageLine({ body: '承認待ちの注文はありません。' });
        }
      } else if (text === 'N' || text === 'NO' || text === 'いいえ' || text === 'NG') {
        const result = await processPendingApproval(false);
        if (result) {
          await sendMessageLine({
            body: `❌ 拒否しました\n${result.ticker} ${result.side === 'buy' ? '買い' : '売り'} ${result.shares}株の注文をキャンセルしました。`,
          });
        } else {
          await sendMessageLine({ body: '承認待ちの注文はありません。' });
        }
      } else if (text === 'LIST' || text === '一覧' || text === 'リスト') {
        const pending = await getPendingApprovals();
        if (pending.length === 0) {
          await sendMessageLine({ body: '承認待ちの注文はありません。' });
        } else {
          const lines = pending.map((p, i) =>
            `${i + 1}. ${p.ticker} ${p.side === 'buy' ? '買い' : '売り'} ${p.shares}株 @ $${p.price.toFixed(2)} (${p.reason})`
          );
          await sendMessageLine({ body: `📋 承認待ち注文:\n${lines.join('\n')}\n\nY=承認 / N=拒否` });
        }
      }
      // それ以外のメッセージは無視（チャットボットではないので）
    }

    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('LINE webhook error:', error);
    return res.status(200).json({ status: 'error' }); // LINEにはいつも200を返す
  }
}
