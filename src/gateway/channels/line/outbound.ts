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

  // LINE Messaging APIは5000文字制限
  const maxLen = 5000;
  const text = params.body.length > maxLen
    ? params.body.slice(0, maxLen - 3) + '...'
    : params.body;

  const { success, error } = await pushTextMessages(config, params.userId ?? config.userId, [text]);
  return error ? { success, error } : { success };
}

export interface LinePushResult {
  success: boolean;
  /** HTTPステータス（通信自体に失敗した場合は undefined） */
  status?: number;
  /** LINEが返す x-line-request-id（API受付の証跡） */
  requestId?: string;
  error?: string;
}

/**
 * 複数のテキストを1回のpushで送信する（最大5件・各5000文字）。
 * 上限を超える入力は切り詰めずにエラーにする（送ったつもりで欠落させないため）。
 * success はLINE APIが受け付けたことを意味し、端末での受信を保証するものではない。
 */
export async function sendMessagesLine(params: {
  texts: string[];
  userId?: string;
}): Promise<LinePushResult> {
  const config = getLineConfig();
  if (!config) {
    return { success: false, error: 'LINE_CHANNEL_ACCESS_TOKEN or LINE_USER_ID not set' };
  }
  if (params.texts.length === 0 || params.texts.length > 5) {
    return { success: false, error: `メッセージ数が範囲外です: ${params.texts.length}` };
  }
  const tooLong = params.texts.findIndex((t) => t.length > 5000);
  if (tooLong >= 0) {
    return { success: false, error: `メッセージ${tooLong + 1}が5000文字を超えています` };
  }
  return pushTextMessages(config, params.userId ?? config.userId, params.texts);
}

async function pushTextMessages(
  config: { accessToken: string },
  userId: string,
  texts: string[],
): Promise<LinePushResult> {
  try {
    const res = await fetch(`${LINE_API_BASE}/message/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: texts.map((text) => ({ type: 'text', text })),
      }),
    });
    const requestId = res.headers.get('x-line-request-id') ?? undefined;

    if (!res.ok) {
      const errBody = await res.text();
      return { success: false, status: res.status, requestId, error: `LINE API ${res.status}: ${errBody}` };
    }

    return { success: true, status: res.status, requestId };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
