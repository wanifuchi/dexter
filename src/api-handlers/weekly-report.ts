/**
 * AI週次レポート
 * ポートフォリオの週間サマリーをLINEに自動送信
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio } from '../tools/trading/portfolio-store.js';
import { sendMessageLine, isLineAvailable } from '../gateway/channels/line/outbound.js';

export const maxDuration = 30;

async function fetchPrice(ticker: string): Promise<number | null> {
  try {
    const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    return closes[closes.length - 1] ?? result.meta?.regularMarketPrice ?? null;
  } catch { return null; }
}

async function fetchUsdJpy(): Promise<number> {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?range=1d&interval=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (res.ok) {
      const json = await res.json() as any;
      return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? 150;
    }
  } catch {}
  return 150;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [portfolio, usdJpy] = await Promise.all([loadPortfolio(), fetchUsdJpy()]);

    if (portfolio.positions.length === 0) {
      return res.json({ status: 'ok', message: 'No positions' });
    }

    const tickers = [...new Set(portfolio.positions.map(p => p.ticker))];
    const prices = await Promise.all(tickers.map(fetchPrice));
    const priceMap = new Map(tickers.map((t, i) => [t, prices[i]]));

    // ポジション別の損益
    let totalValue = 0;
    let totalCost = 0;
    const positionLines: string[] = [];
    const winners: { ticker: string; pnlPct: number }[] = [];
    const losers: { ticker: string; pnlPct: number }[] = [];

    // ticker単位で集約
    const aggregated = new Map<string, { shares: number; cost: number; value: number; name: string }>();
    for (const pos of portfolio.positions) {
      const price = priceMap.get(pos.ticker);
      if (!price) continue;
      const mv = price * pos.shares;
      const cb = pos.avgCost * pos.shares;
      totalValue += mv;
      totalCost += cb;

      const existing = aggregated.get(pos.ticker);
      if (existing) {
        existing.shares += pos.shares;
        existing.cost += cb;
        existing.value += mv;
      } else {
        aggregated.set(pos.ticker, { shares: pos.shares, cost: cb, value: mv, name: pos.name });
      }
    }

    for (const [ticker, data] of aggregated) {
      const pnl = data.value - data.cost;
      const pnlPct = (pnl / data.cost) * 100;
      const icon = pnl >= 0 ? '📈' : '📉';
      positionLines.push(`${icon} ${ticker}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`);
      if (pnlPct >= 0) winners.push({ ticker, pnlPct });
      else losers.push({ ticker, pnlPct });
    }

    winners.sort((a, b) => b.pnlPct - a.pnlPct);
    losers.sort((a, b) => a.pnlPct - b.pnlPct);

    const totalPnl = totalValue - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const totalJpy = Math.round(totalValue * usdJpy);
    const pnlJpy = Math.round(totalPnl * usdJpy);

    const dateRange = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' });

    const report = [
      `📊 Finx 週間レポート (${dateRange})`,
      '',
      `💰 資産総額: ¥${totalJpy.toLocaleString()} ($${totalValue.toFixed(0)})`,
      `${totalPnl >= 0 ? '📈' : '📉'} 含み損益: ¥${pnlJpy.toLocaleString()} (${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(1)}%)`,
      `💱 USD/JPY: ¥${usdJpy.toFixed(2)}`,
      '',
      '── 銘柄別 ──',
      ...positionLines,
      '',
      `🏆 Best: ${winners[0]?.ticker ?? '-'} (+${winners[0]?.pnlPct.toFixed(1) ?? 0}%)`,
      `⚠️ Worst: ${losers[0]?.ticker ?? '-'} (${losers[0]?.pnlPct.toFixed(1) ?? 0}%)`,
    ].join('\n');

    if (isLineAvailable()) {
      await sendMessageLine({ body: report });
    }

    return res.json({ status: 'ok', report });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
