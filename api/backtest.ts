/**
 * Vercel Serverless Function — /api/backtest
 * バックテストを実行して結果を返す
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runBacktest } from '../src/backtest/engine.js';
import { getStrategy, getStrategies } from '../src/backtest/registry.js';
import type { BacktestConfig, PriceBar, PriceHistory } from '../src/backtest/types.js';

export const maxDuration = 60;

/**
 * Yahoo Financeから過去の日足データを取得
 */
async function fetchHistory(ticker: string, range: string): Promise<PriceBar[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return [];

    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    if (!result) return [];

    const timestamps = result.timestamp ?? [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const opens = quote.open ?? [];
    const highs = quote.high ?? [];
    const lows = quote.low ?? [];
    const closes = quote.close ?? [];
    const volumes = quote.volume ?? [];

    const bars: PriceBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] === null || closes[i] === undefined) continue;
      bars.push({
        date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
        open: opens[i] ?? closes[i],
        high: highs[i] ?? closes[i],
        low: lows[i] ?? closes[i],
        close: closes[i],
        volume: volumes[i] ?? 0,
      });
    }
    return bars;
  } catch {
    return [];
  }
}

function periodToRange(period: string): string {
  switch (period) {
    case '1y': return '1y';
    case '3y': return '3y';
    case '5y': return '5y';
    case '10y': return '10y';
    default: return '3y';
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: 利用可能な戦略一覧を返す
  if (req.method === 'GET') {
    const strategies = getStrategies().map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      paramDefs: s.paramDefs,
    }));
    return res.json({ strategies });
  }

  // POST: バックテスト実行
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as {
    strategyId?: string;
    tickers?: string[];
    period?: string;
    initialCapital?: number;
    params?: Record<string, unknown>;
  } | undefined;

  if (!body?.strategyId || !body?.tickers?.length) {
    return res.status(400).json({ error: 'strategyId と tickers は必須です' });
  }

  const strategy = getStrategy(body.strategyId);
  if (!strategy) {
    return res.status(400).json({ error: `戦略 '${body.strategyId}' が見つかりません` });
  }

  try {
    const range = periodToRange(body.period ?? '3y');
    const tickers = body.tickers.map((t) => t.trim().toUpperCase());

    // 全銘柄 + S&P500のデータを並列取得
    const allTickers = [...tickers, '^GSPC'];
    const allData = await Promise.all(allTickers.map((t) => fetchHistory(t, range)));

    const prices: PriceHistory = new Map();
    for (let i = 0; i < tickers.length; i++) {
      if (allData[i].length > 0) prices.set(tickers[i], allData[i]);
    }
    const benchmarkBars = allData[allData.length - 1];

    if (prices.size === 0) {
      return res.status(400).json({ error: '価格データを取得できませんでした' });
    }

    // 期間を全銘柄のデータ範囲から決定
    let minDate = '9999-99-99';
    let maxDate = '0000-00-00';
    for (const bars of prices.values()) {
      if (bars[0]?.date < minDate) minDate = bars[0].date;
      if (bars[bars.length - 1]?.date > maxDate) maxDate = bars[bars.length - 1].date;
    }

    const config: BacktestConfig = {
      strategyId: body.strategyId,
      tickers,
      startDate: minDate,
      endDate: maxDate,
      initialCapital: body.initialCapital ?? 10000,
      params: body.params ?? {},
    };

    const result = runBacktest(strategy, prices, config, benchmarkBars);

    // equityCurveを間引き（大量データ対策）
    const maxPoints = 500;
    if (result.equityCurve.length > maxPoints) {
      const step = Math.ceil(result.equityCurve.length / maxPoints);
      result.equityCurve = result.equityCurve.filter((_, i) => i % step === 0 || i === result.equityCurve.length - 1);
    }
    if (result.benchmarkCurve.length > maxPoints) {
      const step = Math.ceil(result.benchmarkCurve.length / maxPoints);
      result.benchmarkCurve = result.benchmarkCurve.filter((_, i) => i % step === 0 || i === result.benchmarkCurve.length - 1);
    }

    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
