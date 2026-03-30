/**
 * 決算日カレンダー
 * 保有銘柄の次回決算日をチェックし、1週間以内ならLINE通知
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
}

async function fetchEarningsDate(ticker: string): Promise<EarningsInfo> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=0`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { ticker, earningsDate: null, daysUntil: null };

    // Yahoo Finance search doesn't give earnings dates directly,
    // so we use the chart API with events=earnings
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d&events=earnings`;
    const chartRes = await fetch(chartUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!chartRes.ok) return { ticker, earningsDate: null, daysUntil: null };

    const json = await chartRes.json() as any;
    const earnings = json?.chart?.result?.[0]?.events?.earnings;
    if (!earnings) return { ticker, earningsDate: null, daysUntil: null };

    // 未来の決算日を探す
    const now = Date.now() / 1000;
    const futureEarnings = Object.values(earnings)
      .filter((e: any) => e.date > now)
      .sort((a: any, b: any) => a.date - b.date) as any[];

    if (futureEarnings.length === 0) return { ticker, earningsDate: null, daysUntil: null };

    const nextDate = new Date(futureEarnings[0].date * 1000);
    const daysUntil = Math.ceil((nextDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

    return {
      ticker,
      earningsDate: nextDate.toISOString().split('T')[0],
      daysUntil,
    };
  } catch {
    return { ticker, earningsDate: null, daysUntil: null };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [portfolio, watchlist] = await Promise.all([loadPortfolio(), loadWatchlist()]);
    const tickers = new Set<string>();
    for (const p of portfolio.positions) tickers.add(p.ticker);
    for (const w of watchlist.items) tickers.add(w.ticker);

    if (tickers.size === 0) return res.json({ status: 'ok', message: 'No tickers' });

    // バッチで取得
    const results: EarningsInfo[] = [];
    const tickerList = [...tickers];
    for (let i = 0; i < tickerList.length; i += 5) {
      const batch = tickerList.slice(i, i + 5);
      const batchResults = await Promise.all(batch.map(fetchEarningsDate));
      results.push(...batchResults);
    }

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
