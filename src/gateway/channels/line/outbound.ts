/**
 * LINE Messaging API — push message sender.
 *
 * Requires two env vars:
 *   LINE_CHANNEL_ACCESS_TOKEN — チャネルアクセストークン（長期）
 *   LINE_USER_ID              — 送信先のユーザーID
 *
 * LINE Developersコンソールで取得:
 *   1. Messaging APIチャネルを作成
 *   2. チャネルアクセストークン（長期）を発行
 *   3. チャネル基本設定 → あなたのユーザーID をコピー
 */

const LINE_API_BASE = 'https://api.line.me/v2/bot';

function getLineConfig(): { accessToken: string; userId: string } | null {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const userId = process.env.LINE_USER_ID;
  if (!accessToken || !userId) return null;
  return { accessToken, userId };
}

export function isLineAvailable(): boolean {
  return getLineConfig() !== null;
}

/**
 * LINEにプッシュメッセージを送信
 */
export async function sendMessageLine(params: {
  body: string;
  userId?: string;
}): Promise<{ success: boolean; error?: string }> {
  const config = getLineConfig();
  if (!config) {
    return { success: false, error: 'LINE_CHANNEL_ACCESS_TOKEN or LINE_USER_ID not set' };
  }

  const userId = params.userId ?? config.userId;

  // LINE Messaging APIは5000文字制限
  const maxLen = 5000;
  const text = params.body.length > maxLen
    ? params.body.slice(0, maxLen - 3) + '...'
    : params.body;

  try {
    const res = await fetch(`${LINE_API_BASE}/message/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      return { success: false, error: `LINE API ${res.status}: ${errBody}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
