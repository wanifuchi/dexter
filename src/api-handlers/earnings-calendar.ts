/**
 * 決算日カレンダー（Finnhub economic calendar API版）
 * 保有銘柄の次回決算日をチェックし、1週間以内ならLINE通知
 *
 * 旧Yahoo Finance v8 chart `events=earnings` は実質空データを返すことが多いため、
 * Finnhub /calendar/earnings に切り替え（1500件/60日の確実なデータ）
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio } from '../tools/trading/portfolio-store.js';
import { loadWatchlist } from '../tools/trading/watchlist-store.js';
import { sendMessageLine, isLineAvailable } from '../gateway/channels/line/outbound.js';

export const maxDuration = 30;

interface EarningsInfo {
  ticker: string;
  earningsDate: string | null;
  daysUntil: number | null;
  hour?: string;          // 'bmo' (寄り前) | 'amc' (引け後) | ''
  epsEstimate?: number | null;
  revenueEstimate?: number | null;
}

interface FinnhubEarning {
  symbol: string;
  date: string;
  hour: string;
  epsEstimate: number | null;
  revenueEstimate: number | null;
  quarter: number;
  year: number;
}

/**
 * 単一ティッカーの次の決算日をFinnhubから取得
 *
 * 注意: 一括取得（symbol指定なし）は1500件上限で範囲が後ろから切られる問題があるため、
 * symbol指定で個別取得する方式に変更
 */
async function fetchEarningsForTicker(ticker: string): Promise<EarningsInfo> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return { ticker, earningsDate: null, daysUntil: null };

  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

  try {
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(ticker)}&token=${apiKey}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Finx/1.0' } });
    if (!res.ok) return { ticker, earningsDate: null, daysUntil: null };

    const data = await res.json() as { earningsCalendar?: FinnhubEarning[] };
    const events = (data.earningsCalendar ?? []).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    if (events.length === 0) return { ticker, earningsDate: null, daysUntil: null };

    const nextEvent = events[0];
    const nextDate = new Date(nextEvent.date + 'T12:00:00Z');
    const daysUntil = Math.ceil((nextDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

    return {
      ticker,
      earningsDate: nextEvent.date,
      daysUntil,
      hour: nextEvent.hour || '',
      epsEstimate: nextEvent.epsEstimate,
      revenueEstimate: nextEvent.revenueEstimate,
    };
  } catch {
    return { ticker, earningsDate: null, daysUntil: null };
  }
}

/**
 * 複数銘柄の決算予定を並列取得（Finnhub 1500件上限を回避）
 */
async function fetchPortfolioEarnings(tickers: string[]): Promise<EarningsInfo[]> {
  if (tickers.length === 0) return [];
  // 5並列で実行（rate limit対策）
  const results: EarningsInfo[] = [];
  for (let i = 0; i < tickers.length; i += 5) {
    const batch = tickers.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(fetchEarningsForTicker));
    results.push(...batchResults);
  }
  return results;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // /api/data?type=earnings 経由の場合はBasic認証済みなのでcron secretスキップ
  const isFromDataApi = req.query?.type === 'earnings';
  if (!isFromDataApi) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = req.headers['authorization'];
      if (authHeader !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    // クエリでtickers指定があればそれを使う（フロントから直接呼ばれた場合）
    const queryTickers = (req.query?.tickers as string)?.split(',').filter(Boolean);
    let tickerList: string[];

    if (queryTickers && queryTickers.length > 0) {
      tickerList = queryTickers;
    } else {
      const [portfolio, watchlist] = await Promise.all([loadPortfolio(), loadWatchlist()]);
      const tickers = new Set<string>();
      for (const p of portfolio.positions) tickers.add(p.ticker);
      for (const w of watchlist.items) tickers.add(w.ticker);
      if (tickers.size === 0) return res.json({ status: 'ok', message: 'No tickers' });
      tickerList = [...tickers];
    }

    // Finnhub /calendar/earnings で一括取得（API call 1回で全銘柄カバー）
    const results = await fetchPortfolioEarnings(tickerList);

    // 7日以内の決算
    const upcoming = results.filter(r => r.daysUntil !== null && r.daysUntil >= 0 && r.daysUntil <= 7);

    if (upcoming.length > 0 && isLineAvailable()) {
      const lines = upcoming.map(e => {
        const urgency = e.daysUntil === 0 ? '🔴 今日' : e.daysUntil === 1 ? '🟡 明日' : `📅 ${e.daysUntil}日後`;
        return `${urgency} ${e.ticker} — ${e.earningsDate}`;
      });
      await sendMessageLine({
        body: `📊 決算アラート\n\n${lines.join('\n')}\n\n決算前後は株価が大きく動く可能性があります。ポジション管理に注意してください。`,
      });
    }

    return res.json({
      status: 'ok',
      all: results.filter(r => r.earningsDate),
      upcoming,
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
