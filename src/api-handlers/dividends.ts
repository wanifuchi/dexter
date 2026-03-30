/**
 * Vercel Serverless Function — /api/dividends
 * ポートフォリオ銘柄の配当情報を返す
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio } from '../tools/trading/portfolio-store.js';

export const maxDuration = 30;

interface DividendInfo {
  ticker: string;
  name: string;
  shares: number;
  account: string;
  // 配当データ
  dividendPerShare: number | null;
  dividendYield: number | null;
  exDividendDate: string | null;
  payFrequency: string | null;
  // 計算値
  annualDividend: number | null;
  annualDividendAfterTax: number | null;
  currentPrice: number | null;
}

async function fetchDividendData(ticker: string): Promise<{
  dividendPerShare: number | null;
  dividendYield: number | null;
  exDividendDate: string | null;
  trailingAnnualDividendRate: number | null;
  currentPrice: number | null;
  name: string | null;
}> {
  try {
    // 2年分のデータを取得（変動配当銘柄の年率換算精度を上げるため）
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1mo&events=div`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { dividendPerShare: null, dividendYield: null, exDividendDate: null, trailingAnnualDividendRate: null, currentPrice: null, name: null };

    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    if (!result) return { dividendPerShare: null, dividendYield: null, exDividendDate: null, trailingAnnualDividendRate: null, currentPrice: null, name: null };

    const meta = result.meta ?? {};
    const currentPrice = meta.regularMarketPrice ?? null;
    const name = meta.shortName ?? meta.symbol ?? null;

    // 配当イベントから年間配当を計算
    const dividendEvents = result.events?.dividends ?? {};
    const dividendValues = Object.values(dividendEvents) as any[];

    // 方法: 直近の配当を時系列でソートし、最新4回分を合算して年率換算
    // （PBRのような不定期変動配当に対応）
    const sorted = [...dividendValues].sort((a: any, b: any) => b.date - a.date);

    let annualDividend = 0;
    if (sorted.length >= 4) {
      // 直近4回の合計
      const last4 = sorted.slice(0, 4);
      const last4Sum = last4.reduce((s: number, d: any) => s + (d.amount ?? 0), 0);
      // 4回分の期間（日数）を計算して年率換算
      const periodDays = (last4[0].date - last4[3].date) / (60 * 60 * 24);
      if (periodDays > 0) {
        annualDividend = last4Sum * (365 / periodDays);
      } else {
        annualDividend = last4Sum;
      }
    } else if (sorted.length > 0) {
      // 4回未満なら全合計を期間で年率換算
      const total = sorted.reduce((s: number, d: any) => s + (d.amount ?? 0), 0);
      if (sorted.length >= 2) {
        const periodDays = (sorted[0].date - sorted[sorted.length - 1].date) / (60 * 60 * 24);
        annualDividend = periodDays > 0 ? total * (365 / periodDays) : total;
      } else {
        // 1回のみ → 年4回と仮定
        annualDividend = total * 4;
      }
    }

    // 最新の配当日
    const sortedDivs = dividendValues.sort((a: any, b: any) => b.date - a.date);
    const lastDiv = sortedDivs[0];
    const exDividendDate = lastDiv ? new Date(lastDiv.date * 1000).toISOString().split('T')[0] : null;
    const lastDividendAmount = lastDiv?.amount ?? null;

    const dividendYield = currentPrice && annualDividend > 0
      ? (annualDividend / currentPrice) * 100
      : null;

    return {
      dividendPerShare: annualDividend > 0 ? annualDividend : lastDividendAmount,
      dividendYield,
      exDividendDate,
      trailingAnnualDividendRate: annualDividend > 0 ? annualDividend : null,
      currentPrice,
      name,
    };
  } catch {
    return { dividendPerShare: null, dividendYield: null, exDividendDate: null, trailingAnnualDividendRate: null, currentPrice: null, name: null };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const portfolio = await loadPortfolio();
    const uniqueTickers = [...new Set(portfolio.positions.map((p) => p.ticker))];

    // 配当データ取得（並列）
    const dividendResults = await Promise.all(uniqueTickers.map(fetchDividendData));
    const dividendMap = new Map(uniqueTickers.map((t, i) => [t, dividendResults[i]]));

    // USD/JPY
    let usdJpy = 150;
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

    const positions: DividendInfo[] = [];
    let totalAnnualDividend = 0;
    let totalAnnualDividendAfterTax = 0;

    for (const pos of portfolio.positions) {
      const dd = dividendMap.get(pos.ticker);
      const annualRate = dd?.trailingAnnualDividendRate ?? 0;
      const annualDiv = annualRate * pos.shares;

      // NISA: 非課税（ただし米国源泉10%あり）、特定: 米国源泉10% + 国内20.315%
      const isNisa = pos.account.includes('nisa');
      const usTaxRate = 0.10; // 米国源泉税
      const jpTaxRate = isNisa ? 0 : 0.20315; // 国内税
      const afterUsTax = annualDiv * (1 - usTaxRate);
      const afterTax = afterUsTax * (1 - jpTaxRate);

      totalAnnualDividend += annualDiv;
      totalAnnualDividendAfterTax += afterTax;

      positions.push({
        ticker: pos.ticker,
        name: pos.name,
        shares: pos.shares,
        account: pos.account,
        dividendPerShare: dd?.dividendPerShare ?? null,
        dividendYield: dd?.dividendYield ?? null,
        exDividendDate: dd?.exDividendDate ?? null,
        payFrequency: null,
        annualDividend: annualDiv > 0 ? annualDiv : null,
        annualDividendAfterTax: afterTax > 0 ? afterTax : null,
        currentPrice: dd?.currentPrice ?? null,
      });
    }

    return res.json({
      positions,
      summary: {
        totalAnnualDividend,
        totalAnnualDividendAfterTax,
        totalAnnualDividendJpy: totalAnnualDividend * usdJpy,
        totalAnnualDividendAfterTaxJpy: totalAnnualDividendAfterTax * usdJpy,
      },
      usdJpy,
      updatedAt: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
