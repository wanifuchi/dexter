/**
 * 経済指標アラート
 * 主要な経済イベント（FOMC、CPI、雇用統計等）をチェックしてLINE通知
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendMessageLine, isLineAvailable } from '../gateway/channels/line/outbound.js';

export const maxDuration = 15;

// 主要経済指標カレンダー（毎月の大まかなスケジュール）
function getUpcomingEvents(): { name: string; description: string; typical: string }[] {
  const today = new Date();
  const day = today.getDate();
  const dayOfWeek = today.getDay();

  const events: { name: string; description: string; typical: string }[] = [];

  // 雇用統計: 毎月第1金曜日
  if (dayOfWeek === 5 && day <= 7) {
    events.push({ name: '🇺🇸 米国雇用統計', description: '非農業部門雇用者数・失業率の発表日', typical: '21:30 JST' });
  }

  // CPI: 毎月10-13日頃
  if (day >= 10 && day <= 13) {
    events.push({ name: '🇺🇸 消費者物価指数（CPI）', description: 'インフレ指標。FRBの利上げ/利下げ判断に直結', typical: '21:30 JST' });
  }

  // FOMC: 年8回（1,3,5,6,7,9,11,12月）の第3-4週
  const fomcMonths = [1, 3, 5, 6, 7, 9, 11, 12];
  const month = today.getMonth() + 1;
  if (fomcMonths.includes(month) && day >= 18 && day <= 28) {
    events.push({ name: '🇺🇸 FOMC政策金利決定', description: 'FRBの金利決定と声明発表。市場最大のイベント', typical: '翌3:00 JST' });
  }

  // PPI: CPI翌日付近
  if (day >= 11 && day <= 14) {
    events.push({ name: '🇺🇸 生産者物価指数（PPI）', description: '企業の仕入れ価格。CPIの先行指標', typical: '21:30 JST' });
  }

  // 小売売上高: 毎月15日前後
  if (day >= 14 && day <= 17) {
    events.push({ name: '🇺🇸 小売売上高', description: '個人消費の動向。GDP推定に重要', typical: '21:30 JST' });
  }

  // 日銀金融政策決定会合: 年8回
  const bojMonths = [1, 3, 4, 6, 7, 9, 10, 12];
  if (bojMonths.includes(month) && day >= 17 && day <= 25) {
    events.push({ name: '🇯🇵 日銀金融政策決定会合', description: '日本の金利政策。円相場に直結', typical: '12:00 JST' });
  }

  return events;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const events = getUpcomingEvents();

    if (events.length > 0 && isLineAvailable()) {
      const dateStr = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' });
      const lines = events.map(e => `${e.name}\n  ${e.description}\n  発表予定: ${e.typical}`);
      await sendMessageLine({
        body: `📅 本日の経済指標 (${dateStr})\n\n${lines.join('\n\n')}\n\n※ 発表前後は相場が大きく動く可能性があります`,
      });
    }

    return res.json({ status: 'ok', eventsToday: events.length, events });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
