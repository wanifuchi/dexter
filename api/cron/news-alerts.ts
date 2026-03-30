/**
 * Vercel Cron Job — /api/cron/news-alerts
 * 保有銘柄+ウォッチリストの重要ニュースをチェックし、LINEに通知。
 * 決算発表、アナリストレーティング変更、重大イベントを検知。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio } from '../../src/tools/trading/portfolio-store.js';
import { loadWatchlist } from '../../src/tools/trading/watchlist-store.js';
import { sendMessageLine, isLineAvailable } from '../../src/gateway/channels/line/index.js';

export const maxDuration = 30;

interface NewsItem {
  ticker: string;
  title: string;
  publisher: string;
  link: string;
  publishedAt: string;
  type: 'earnings' | 'upgrade' | 'downgrade' | 'news';
}

async function fetchNews(ticker: string): Promise<NewsItem[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
    // Yahoo Finance のニュースAPIは別エンドポイント
    const newsUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=5&quotesCount=0`;
    const res = await fetch(newsUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];

    const json = await res.json() as any;
    const news = json?.news ?? [];

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    return news
      .filter((n: any) => {
        const pubTime = (n.providerPublishTime ?? 0) * 1000;
        return pubTime > oneDayAgo;
      })
      .map((n: any) => {
        const title = (n.title ?? '').toLowerCase();
        let type: NewsItem['type'] = 'news';
        if (title.includes('earnings') || title.includes('revenue') || title.includes('profit') || title.includes('決算')) {
          type = 'earnings';
        } else if (title.includes('upgrade') || title.includes('buy') || title.includes('outperform')) {
          type = 'upgrade';
        } else if (title.includes('downgrade') || title.includes('sell') || title.includes('underperform')) {
          type = 'downgrade';
        }

        return {
          ticker,
          title: n.title ?? '',
          publisher: n.publisher ?? '',
          link: n.link ?? '',
          publishedAt: new Date((n.providerPublishTime ?? 0) * 1000).toISOString(),
          type,
        };
      });
  } catch {
    return [];
  }
}

// 重要ニュースのみフィルタ（決算、レーティング変更）
function isImportant(item: NewsItem): boolean {
  return item.type === 'earnings' || item.type === 'upgrade' || item.type === 'downgrade';
}

function formatNewsAlert(items: NewsItem[]): string {
  const typeLabels: Record<string, string> = {
    earnings: '📊 決算',
    upgrade: '⬆️ 格上げ',
    downgrade: '⬇️ 格下げ',
    news: '📰 ニュース',
  };

  const header = `📰 Finx ニュースアラート (${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`;
  const lines = items.map(n =>
    `${typeLabels[n.type]} [${n.ticker}] ${n.title}\n  ${n.publisher} | ${n.publishedAt.slice(0, 10)}`
  );
  return [header, '', ...lines].join('\n');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    // 監視対象のticker収集
    const [portfolio, watchlist] = await Promise.all([loadPortfolio(), loadWatchlist()]);
    const tickers = new Set<string>();
    for (const p of portfolio.positions) tickers.add(p.ticker);
    for (const w of watchlist.items) tickers.add(w.ticker);

    if (tickers.size === 0) {
      return res.json({ status: 'ok', message: 'No tickers to watch', newsCount: 0 });
    }

    // ニュース取得（並列、ただし5件ずつバッチ）
    const tickerList = [...tickers];
    const allNews: NewsItem[] = [];
    for (let i = 0; i < tickerList.length; i += 5) {
      const batch = tickerList.slice(i, i + 5);
      const results = await Promise.all(batch.map(fetchNews));
      for (const items of results) allNews.push(...items);
    }

    // 重要ニュースだけフィルタ
    const important = allNews.filter(isImportant);

    // 重複排除（同じtitleは1回だけ）
    const seen = new Set<string>();
    const unique = important.filter(n => {
      if (seen.has(n.title)) return false;
      seen.add(n.title);
      return true;
    });

    // 通知
    if (unique.length > 0 && isLineAvailable()) {
      const message = formatNewsAlert(unique);
      await sendMessageLine({ body: message });
    }

    return res.json({
      status: 'ok',
      tickersChecked: tickers.size,
      totalNews: allNews.length,
      importantNews: unique.length,
      items: unique.slice(0, 10),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
