/**
 * Vercel Cron Job — /api/cron/scan-alerts
 *
 * 定期的にアラートルールとポートフォリオをチェックし、
 * 条件を満たした銘柄をLINEに通知する。
 *
 * Vercel Cronから呼ばれる（vercel.jsonで設定）。
 * CRON_SECRET で認証し、外部からの不正呼び出しを防止。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio } from '../tools/trading/portfolio-store.js';
import { loadAlertStore } from '../tools/trading/alert-store.js';
import {
  evaluateAlertRules,
  evaluatePortfolioSignals,
  collectWatchedTickers,
} from '../tools/trading/signal-detector.js';
import type { TickerSnapshot } from '../tools/trading/signal-detector.js';
import type { Signal } from '../tools/trading/types.js';
import { sendMessageLine, isLineAvailable } from '../gateway/channels/line/index.js';

export const maxDuration = 60;

/**
 * Yahoo Financeから株価スナップショットを取得（軽量版）
 */
async function fetchSnapshot(ticker: string): Promise<TickerSnapshot | null> {
  try {
    // 日本株は.T付き、米国株はそのまま
    const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2d&interval=1d`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;

    const json = await res.json() as Record<string, unknown>;
    const result = (json as any)?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta ?? {};
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const price = meta.regularMarketPrice ?? closes[closes.length - 1];
    const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? closes[closes.length - 2];

    return {
      ticker,
      name: meta.shortName ?? meta.symbol ?? ticker,
      price: typeof price === 'number' ? price : undefined,
      previousClose: typeof previousClose === 'number' ? previousClose : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * シグナルを通知メッセージに整形
 */
function formatSignals(signals: Signal[]): string {
  if (signals.length === 0) return '';

  const lines = signals.map((s) => `⚠ ${s.message}`);
  const header = `📊 Finx アラート (${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`;

  return [header, '', ...lines].join('\n');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel Cron認証（CRON_SECRETが設定されていれば検証）
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    // 1. 監視対象のticker一覧を収集
    const tickers = await collectWatchedTickers();
    if (tickers.length === 0) {
      return res.json({ status: 'ok', message: 'No tickers to watch', signals: 0 });
    }

    // 2. 各tickerの現在データを取得（並列）
    const snapshotResults = await Promise.all(tickers.map(fetchSnapshot));
    const snapshots = new Map<string, TickerSnapshot>();
    for (const snap of snapshotResults) {
      if (snap) snapshots.set(snap.ticker, snap);
    }

    // 3. アラートルール評価
    const alertStore = await loadAlertStore();
    const alertSignals = await evaluateAlertRules(alertStore.rules, snapshots);

    // 4. ポートフォリオ異常検出
    const portfolio = await loadPortfolio();
    const portfolioSignals = await evaluatePortfolioSignals(portfolio.positions, snapshots);

    // 5. シグナル統合
    const allSignals = [...alertSignals, ...portfolioSignals];

    // 6. シグナルがあれば通知
    if (allSignals.length > 0) {
      const message = formatSignals(allSignals);

      // LINE通知
      if (isLineAvailable()) {
        await sendMessageLine({ body: message });
      }
    }

    return res.json({
      status: 'ok',
      tickersChecked: tickers.length,
      snapshotsObtained: snapshots.size,
      signals: allSignals.length,
      signalDetails: allSignals.map((s) => ({
        ticker: s.ticker,
        type: s.type,
        currentValue: s.currentValue,
        threshold: s.threshold,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ status: 'error', message });
  }
}
