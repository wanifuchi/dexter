/**
 * Vercel Serverless Function — /api/portfolio
 * ポートフォリオの現在状況を返すAPI
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio } from '../tools/trading/portfolio-store.js';
import { loadAlertStore } from '../tools/trading/alert-store.js';

export const maxDuration = 30;

interface PriceData {
  ticker: string;
  price: number | null;
  previousClose: number | null;
  name: string | null;
  rsi14: number | null;
  sma50: number | null;
  dailyCloses: number[]; // 相関計算用
}

function calcRSI(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = (gains / period) / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcSMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

async function fetchPrice(ticker: string): Promise<PriceData> {
  const empty: PriceData = { ticker, price: null, previousClose: null, name: null, rsi14: null, sma50: null, dailyCloses: [] };
  try {
    const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return empty;

    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    if (!result) return empty;

    const meta = result.meta ?? {};
    const closes: number[] = (result.indicators?.quote?.[0]?.close ?? []).filter((c: any) => c !== null);
    const price = meta.regularMarketPrice ?? closes[closes.length - 1];
    // 日次変動の基準値: closes配列の最後から2番目（前営業日終値）を最優先
    // meta.chartPreviousClose は range=3mo の場合「3ヶ月前」の値を返すため使えない
    // meta.previousClose も提供されない場合があるため、closes配列を信頼する
    const previousClose = closes[closes.length - 2] ?? meta.previousClose ?? meta.chartPreviousClose;

    return {
      ticker,
      price: typeof price === 'number' ? price : null,
      previousClose: typeof previousClose === 'number' ? previousClose : null,
      name: meta.shortName ?? meta.symbol ?? null,
      rsi14: calcRSI(closes, 14),
      sma50: calcSMA(closes, 50),
      dailyCloses: closes,
    };
  } catch {
    return empty;
  }
}

function computeCorrelation(
  tickers: string[],
  priceMap: Map<string, PriceData>,
): { tickers: string[]; matrix: number[][] } {
  // 日次リターンを計算
  const returns: Map<string, number[]> = new Map();
  for (const ticker of tickers) {
    const pd = priceMap.get(ticker);
    if (!pd?.dailyCloses || pd.dailyCloses.length < 10) continue;
    const closes = pd.dailyCloses;
    const ret: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1] > 0) ret.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    returns.set(ticker, ret);
  }

  const validTickers = tickers.filter(t => returns.has(t));
  // ユニーク化
  const uniqueTickers = [...new Set(validTickers)];
  const n = uniqueTickers.length;
  const matrix: number[][] = [];

  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    const a = returns.get(uniqueTickers[i])!;
    for (let j = 0; j < n; j++) {
      if (i === j) { row.push(1); continue; }
      const b = returns.get(uniqueTickers[j])!;
      const len = Math.min(a.length, b.length);
      if (len < 5) { row.push(0); continue; }
      const sliceA = a.slice(-len);
      const sliceB = b.slice(-len);
      const meanA = sliceA.reduce((s, v) => s + v, 0) / len;
      const meanB = sliceB.reduce((s, v) => s + v, 0) / len;
      let cov = 0, varA = 0, varB = 0;
      for (let k = 0; k < len; k++) {
        const da = sliceA[k] - meanA;
        const db = sliceB[k] - meanB;
        cov += da * db;
        varA += da * da;
        varB += db * db;
      }
      const denom = Math.sqrt(varA * varB);
      row.push(denom > 0 ? cov / denom : 0);
    }
    matrix.push(row);
  }

  return { tickers: uniqueTickers, matrix };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const [portfolio, alertStore] = await Promise.all([
      loadPortfolio(),
      loadAlertStore(),
    ]);

    // USD/JPY為替レート取得
    let usdJpy = 150; // フォールバック
    try {
      const fxRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?range=1d&interval=1d', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (fxRes.ok) {
        const fxJson = await fxRes.json() as any;
        const rate = fxJson?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (typeof rate === 'number') usdJpy = rate;
      }
    } catch {}

    // ユニークなtickerを収集して株価取得
    const tickers = [...new Set(portfolio.positions.map((p) => p.ticker))];
    const prices = await Promise.all(tickers.map(fetchPrice));
    const priceMap = new Map(prices.map((p) => [p.ticker, p]));

    // ポジションにリアルタイム価格を付与
    let totalCost = 0;
    let totalValue = 0;

    const enrichedPositions = portfolio.positions.map((pos) => {
      const pd = priceMap.get(pos.ticker);
      const currentPrice = pd?.price ?? null;
      const marketValue = currentPrice !== null ? currentPrice * pos.shares : null;
      const costBasis = pos.avgCost * pos.shares;
      const pnl = marketValue !== null ? marketValue - costBasis : null;
      const pnlPct = currentPrice !== null ? ((currentPrice - pos.avgCost) / pos.avgCost) * 100 : null;
      const dayChange = pd?.price && pd?.previousClose
        ? ((pd.price - pd.previousClose) / pd.previousClose) * 100
        : null;

      if (marketValue !== null) {
        totalCost += costBasis;
        totalValue += marketValue;
      }

      return {
        ticker: pos.ticker,
        name: pos.name,
        shares: pos.shares,
        avgCost: pos.avgCost,
        account: pos.account,
        currentPrice,
        marketValue,
        costBasis,
        pnl,
        pnlPct,
        dayChange,
        rsi14: pd?.rsi14 ?? null,
        sma50: pd?.sma50 ?? null,
      };
    });

    const totalPnl = totalValue - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

    // 口座別サマリー
    const accountSummary: Record<string, { cost: number; value: number; count: number }> = {};
    for (const pos of enrichedPositions) {
      if (!accountSummary[pos.account]) {
        accountSummary[pos.account] = { cost: 0, value: 0, count: 0 };
      }
      accountSummary[pos.account].count++;
      accountSummary[pos.account].cost += pos.costBasis;
      if (pos.marketValue !== null) {
        accountSummary[pos.account].value += pos.marketValue;
      }
    }

    // パフォーマンスアトリビューション: 各銘柄のPnLが全体にどれだけ貢献したか
    const attribution = enrichedPositions
      .filter(p => p.pnl !== null)
      .map(p => ({
        ticker: p.ticker,
        account: p.account,
        pnl: p.pnl!,
        contribution: totalPnl !== 0 ? (p.pnl! / totalPnl) * 100 : 0,
        weight: totalValue > 0 ? ((p.marketValue ?? 0) / totalValue) * 100 : 0,
      }))
      .sort((a, b) => b.pnl - a.pnl);

    // リバランス提案: セクター偏りが50%超の場合に警告
    const sectorMap: Record<string, string> = {
      NVDA: 'AI/半導体', SOXL: 'AI/半導体', NVTS: 'AI/半導体',
      AAPL: 'メガテック', PBR: 'エネルギー', EC: 'エネルギー',
      GRAB: '新興国', IREN: 'BTC/マイニング', CIFR: 'BTC/マイニング', WULF: 'BTC/マイニング',
    };
    const sectorValues: Record<string, number> = {};
    for (const p of enrichedPositions) {
      const sector = sectorMap[p.ticker] || 'その他';
      sectorValues[sector] = (sectorValues[sector] || 0) + (p.marketValue ?? 0);
    }
    const rebalanceSuggestions: string[] = [];
    for (const [sector, value] of Object.entries(sectorValues)) {
      const pct = totalValue > 0 ? (value / totalValue) * 100 : 0;
      if (pct > 50) rebalanceSuggestions.push(`${sector}が${pct.toFixed(0)}%と過度に集中しています。分散を検討してください。`);
    }
    // 個別銘柄が20%超
    for (const p of enrichedPositions) {
      const weight = totalValue > 0 ? ((p.marketValue ?? 0) / totalValue) * 100 : 0;
      if (weight > 20) rebalanceSuggestions.push(`${p.ticker}がポートフォリオの${weight.toFixed(0)}%を占めています。集中リスクに注意。`);
    }

    return res.json({
      positions: enrichedPositions,
      alerts: alertStore.rules ?? [],
      summary: {
        totalCost,
        totalValue,
        totalPnl,
        totalPnlPct,
        positionCount: enrichedPositions.length,
      },
      accountSummary,
      attribution,
      rebalanceSuggestions,
      correlation: computeCorrelation(tickers, priceMap),
      usdJpy,
      updatedAt: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
