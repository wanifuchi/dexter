/**
 * 経済指標アラート（実データ版）
 *
 * Finnhub economic calendar APIから実際のイベント日を取得して、
 * 当日の日本・米国の重要経済指標をLINE通知する。
 *
 * 旧版は日付範囲の機械的マッチで誤通知が多発したため、実データに刷新。
 * 重複防止のため、Redis に日付別の送信フラグを残す。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendMessageLine, isLineAvailable } from '../gateway/channels/line/outbound.js';

export const maxDuration = 15;

interface CalendarEvent {
  country: string;
  event: string;
  impact: 'low' | 'medium' | 'high';
  time: string; // "YYYY-MM-DD HH:MM:SS" UTC
  actual?: number | null;
  estimate?: number | null;
  prev?: number | null;
  unit?: string;
}

// Redis（重複通知防止）
let redisClient: any = null;
let redisInitialized = false;
async function getRedis() {
  if (redisInitialized) return redisClient;
  redisInitialized = true;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    redisClient = new Redis({ url, token });
    return redisClient;
  } catch { return null; }
}

/**
 * Finnhub economic calendar API で当日のイベントを取得
 */
async function fetchTodayEvents(): Promise<CalendarEvent[]> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return [];

  // JST基準で当日の範囲（UTC換算）
  const now = new Date();
  const jstOffset = 9 * 60; // JST is UTC+9
  const jstNow = new Date(now.getTime() + (jstOffset - now.getTimezoneOffset()) * 60000);
  const jstToday = jstNow.toISOString().slice(0, 10); // "2026-04-23"

  // UTCでは前日15:00〜当日14:59が「JSTの当日」
  const fromDate = new Date(`${jstToday}T00:00:00+09:00`).toISOString().slice(0, 10);
  const toDate = new Date(new Date(`${jstToday}T23:59:59+09:00`).getTime() + 86400000).toISOString().slice(0, 10);

  try {
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${fromDate}&to=${toDate}&token=${apiKey}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Finx/1.0' } });
    if (!res.ok) return [];
    const data = await res.json() as { economicCalendar?: CalendarEvent[] };
    const events = data.economicCalendar || [];

    // JST当日の範囲でフィルタ（イベント時刻をJSTに変換して判定）
    return events.filter(e => {
      if (!e.time) return false;
      const utcDate = new Date(e.time.replace(' ', 'T') + 'Z');
      const jstDate = new Date(utcDate.getTime() + 9 * 3600 * 1000);
      return jstDate.toISOString().slice(0, 10) === jstToday;
    });
  } catch {
    return [];
  }
}

/**
 * 通知対象の重要イベントだけに絞る
 * - 米国・日本
 * - high/medium のみ（low は除外 = PMI一部, Tokyo CPI等）
 * - ただし high は必ず含める、medium は厳選
 */
function filterImportantEvents(events: CalendarEvent[]): CalendarEvent[] {
  // 重要キーワード（mediumでも通知対象にするもの）
  const MUST_NOTIFY_KEYWORDS = [
    'BoJ', 'Bank of Japan', 'Interest Rate', 'Fed ', 'FOMC', 'Press Conference',
    'CPI', 'Inflation', 'PCE', 'GDP', 'Non Farm', 'Nonfarm', 'Unemployment Rate',
    'PMI', 'Retail Sales', 'Durable Goods',
  ];

  return events.filter(e => {
    if (e.country !== 'US' && e.country !== 'JP') return false;
    // highは無条件で通知
    if (e.impact === 'high') return true;
    // mediumはキーワードマッチするもののみ
    if (e.impact === 'medium') {
      return MUST_NOTIFY_KEYWORDS.some(k => e.event.includes(k));
    }
    return false;
  });
}

/**
 * イベントをLINEメッセージ用に整形
 */
function formatEvents(events: CalendarEvent[]): string {
  if (events.length === 0) return '';

  const grouped: Record<string, CalendarEvent[]> = { JP: [], US: [] };
  for (const e of events) {
    if (grouped[e.country]) grouped[e.country].push(e);
  }

  const lines: string[] = [];

  if (grouped.JP.length > 0) {
    lines.push('🇯🇵 日本');
    for (const e of grouped.JP) {
      const jstTime = formatJstTime(e.time);
      const impact = e.impact === 'high' ? '🔴' : '🟡';
      const estimate = e.estimate != null ? ` 予想: ${e.estimate}${e.unit || ''}` : '';
      const prev = e.prev != null ? ` 前回: ${e.prev}${e.unit || ''}` : '';
      lines.push(`  ${impact} ${jstTime} ${e.event}${estimate}${prev}`);
    }
  }

  if (grouped.US.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('🇺🇸 米国');
    for (const e of grouped.US) {
      const jstTime = formatJstTime(e.time);
      const impact = e.impact === 'high' ? '🔴' : '🟡';
      const estimate = e.estimate != null ? ` 予想: ${e.estimate}${e.unit || ''}` : '';
      const prev = e.prev != null ? ` 前回: ${e.prev}${e.unit || ''}` : '';
      lines.push(`  ${impact} ${jstTime} ${e.event}${estimate}${prev}`);
    }
  }

  return lines.join('\n');
}

function formatJstTime(utcTimeStr: string): string {
  try {
    const utcDate = new Date(utcTimeStr.replace(' ', 'T') + 'Z');
    const jst = new Date(utcDate.getTime() + 9 * 3600 * 1000);
    return `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
  } catch {
    return '??:??';
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const events = await fetchTodayEvents();
    const important = filterImportantEvents(events);

    if (important.length === 0) {
      return res.json({ status: 'ok', eventsToday: 0, message: 'No important events today' });
    }

    // 重複通知防止
    const redis = await getRedis();
    const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const dedupeKey = `finx:economic-alert:${jstToday}`;
    if (redis) {
      const alreadySent = await redis.get(dedupeKey);
      if (alreadySent) {
        return res.json({ status: 'ok', message: 'Already sent today', eventsToday: important.length });
      }
    }

    if (!isLineAvailable()) {
      return res.json({ status: 'ok', eventsToday: important.length, events: important, warning: 'LINE not available' });
    }

    const dateStr = new Date().toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short',
    });
    const body = `📅 本日の経済指標 (${dateStr})\n\n${formatEvents(important)}\n\n※ 🔴=High / 🟡=Medium。時刻はJST。発表前後は相場が大きく動く可能性があります`;

    await sendMessageLine({ body });

    // 送信済みフラグ（TTL: 25時間）
    if (redis) {
      try { await redis.set(dedupeKey, '1', { ex: 25 * 3600 }); } catch {}
    }

    return res.json({ status: 'ok', eventsToday: important.length, events: important });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
