/**
 * 議員・内部者取引ツール
 *
 * - congress_trading: 米国議員（上院・下院）の株式取引（FMP API）
 * - insider_trading: 企業内部者（経営陣・取締役・主要株主）の取引（Finnhub API）
 *
 * これらは「スマートマネー」の動きを示すシグナル:
 * - 議員: 法律情報や業界動向にアクセスできる立場
 * - 内部者: 企業の内情を最も知る立場
 *
 * 注意: 公開時点では遅延データ（議員は45日以内開示義務、内部者はForm 4で2営業日以内）
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const FMP_API = 'https://financialmodelingprep.com/stable';
const FINNHUB_API = 'https://finnhub.io/api/v1';

// === 議員取引 (Congressional Trading) ===

interface SenateTrade {
  symbol: string;
  transactionDate: string;
  owner: string;
  firstName: string;
  lastName: string;
  type: string; // 'Purchase' | 'Sale' | 'Sale (Partial)' etc
  amount: string; // '$1,001 - $15,000' 形式の範囲
  comment?: string;
}

interface HouseTrade {
  symbol: string;
  disclosureDate: string;
  transactionDate: string;
  owner: string;
  representative: string;
  type: string;
  amount: string;
  district?: string;
}

async function fetchSenateTrades(symbol: string, limit: number): Promise<SenateTrade[]> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return [];
  try {
    const url = `${FMP_API}/senate-trades?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Finx/1.0' } });
    if (!res.ok) return [];
    const data = await res.json() as SenateTrade[];
    return Array.isArray(data) ? data.slice(0, limit) : [];
  } catch { return []; }
}

async function fetchHouseTrades(symbol: string, limit: number): Promise<HouseTrade[]> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return [];
  try {
    const url = `${FMP_API}/house-trades?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Finx/1.0' } });
    if (!res.ok) return [];
    const data = await res.json() as HouseTrade[];
    return Array.isArray(data) ? data.slice(0, limit) : [];
  } catch { return []; }
}

function summarizeCongressTrades(senate: SenateTrade[], house: HouseTrade[]) {
  const all = [
    ...senate.map(t => ({
      type: 'Senate' as const,
      date: t.transactionDate,
      person: `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim() || 'Unknown',
      action: t.type,
      amount: t.amount,
    })),
    ...house.map(t => ({
      type: 'House' as const,
      date: t.transactionDate,
      person: t.representative || t.owner || 'Unknown',
      action: t.type,
      amount: t.amount,
    })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // 集計（直近90日）
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const recent = all.filter(t => t.date >= ninetyDaysAgo);
  let buys = 0, sells = 0;
  for (const t of recent) {
    if (/Purchase/i.test(t.action)) buys++;
    else if (/Sale/i.test(t.action)) sells++;
  }

  const sentiment = buys > sells * 1.5 ? '🟢 買い優勢'
    : sells > buys * 1.5 ? '🔴 売り優勢'
    : '⚪ 中立';

  return {
    summary: {
      totalTrades: all.length,
      last90Days: recent.length,
      buys,
      sells,
      sentiment,
    },
    recentTrades: all.slice(0, 15),
    note: '議員取引は45日以内に開示義務あり（STOCK Act）。遅延データなのでリアルタイム判断には不向き、ただしトレンド分析の補助として有用',
  };
}

export const congressTradingTool = new DynamicStructuredTool({
  name: 'congress_trading',
  description: 'Fetch US Congress (Senate + House) stock trading disclosures for a ticker. Returns recent transactions with date, lawmaker name, buy/sell, amount range. Useful for spotting "smart money" sentiment from politicians who may have access to non-public info or industry intelligence.',
  schema: z.object({
    symbol: z.string().describe('Stock ticker (e.g. NVDA, AAPL, TSLA)'),
    limit: z.number().optional().default(20).describe('Max trades per chamber (default: 20)'),
  }),
  func: async (input) => {
    if (!process.env.FMP_API_KEY) {
      return formatToolResult({ error: 'FMP_API_KEY not configured' });
    }
    const sym = input.symbol.toUpperCase();
    const [senate, house] = await Promise.all([
      fetchSenateTrades(sym, input.limit ?? 20),
      fetchHouseTrades(sym, input.limit ?? 20),
    ]);

    if (senate.length === 0 && house.length === 0) {
      return formatToolResult({
        symbol: sym,
        message: 'No congressional trades found for this ticker',
      });
    }

    return formatToolResult({
      symbol: sym,
      ...summarizeCongressTrades(senate, house),
      source: 'FMP (Financial Modeling Prep) — STOCK Act disclosures',
    });
  },
});

export const CONGRESS_TRADING_DESCRIPTION = `Fetches US Congressional trading disclosures (Senate + House) for a ticker.
Returns: recent trades with lawmaker name, transaction type, date, amount range; aggregate buy/sell sentiment.
Use for: spotting "smart money" sentiment, especially in policy-sensitive sectors (defense, healthcare, tech regulation).
Source: FMP API based on STOCK Act 45-day disclosures.`;

// === 内部者取引 (Insider Trading) ===

interface InsiderTransaction {
  symbol: string;
  filingDate: string;
  transactionDate: string;
  name: string;
  share: number;          // 取引前の保有数
  change: number;         // +買い増し / -売却
  transactionPrice: number;
  transactionCode: string; // 'P' = Purchase, 'S' = Sale, 'A' = Award etc
}

async function fetchInsiderTransactions(symbol: string, limit: number): Promise<InsiderTransaction[]> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return [];
  try {
    const url = `${FINNHUB_API}/stock/insider-transactions?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Finx/1.0' } });
    if (!res.ok) return [];
    const data = await res.json() as { data?: InsiderTransaction[] };
    return (data.data ?? []).slice(0, limit);
  } catch { return []; }
}

function summarizeInsiderTrades(transactions: InsiderTransaction[]) {
  if (transactions.length === 0) return null;

  // 直近90日のサマリ
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const recent = transactions.filter(t => (t.filingDate ?? '') >= ninetyDaysAgo);

  // Code判定: P/A=買い、S/D=売り
  let openMarketBuys = 0, openMarketSells = 0;
  let buyShares = 0, sellShares = 0;
  let buyValue = 0, sellValue = 0;

  for (const t of recent) {
    const code = (t.transactionCode || '').toUpperCase();
    const change = Math.abs(t.change || 0);
    const value = change * (t.transactionPrice || 0);
    if (code === 'P') {
      openMarketBuys++;
      buyShares += change;
      buyValue += value;
    } else if (code === 'S') {
      openMarketSells++;
      sellShares += change;
      sellValue += value;
    }
  }

  const netValue = buyValue - sellValue;
  const sentiment = openMarketBuys > 0 && netValue > 0 ? '🟢 買い優勢（強気）'
    : openMarketSells > openMarketBuys * 2 ? '🔴 売り優勢（弱気）'
    : openMarketBuys === 0 && openMarketSells > 5 ? '🟡 売り中心（要注意）'
    : '⚪ 中立';

  return {
    summary: {
      totalTransactions: transactions.length,
      last90Days: recent.length,
      openMarketBuys,
      openMarketSells,
      buyShares,
      sellShares,
      netValueUsd: netValue,
      sentiment,
    },
    recentTrades: transactions.slice(0, 10).map(t => ({
      filingDate: t.filingDate,
      name: t.name,
      code: t.transactionCode,
      change: t.change,
      price: t.transactionPrice,
      value: t.transactionPrice && t.change ? Math.abs(t.change * t.transactionPrice) : null,
    })),
    note: 'Form 4は2営業日以内開示。Code: P=Purchase(open market buy), S=Sale, A=Award(grant), M=Option exercise, F=Tax payment. **PとS以外は通常のシグナルにはならない**',
  };
}

export const insiderTradingTool = new DynamicStructuredTool({
  name: 'insider_trading',
  description: 'Fetch corporate insider transactions (executives, directors, 10%+ shareholders) for a ticker. Returns Form 4 filings with name, transaction code (P=buy, S=sell), shares, price. Aggregates open-market buy/sell sentiment for the last 90 days.',
  schema: z.object({
    symbol: z.string().describe('Stock ticker (e.g. NVDA, AAPL)'),
    limit: z.number().optional().default(50).describe('Max transactions to return (default: 50)'),
  }),
  func: async (input) => {
    if (!process.env.FINNHUB_API_KEY) {
      return formatToolResult({ error: 'FINNHUB_API_KEY not configured' });
    }
    const sym = input.symbol.toUpperCase();
    const transactions = await fetchInsiderTransactions(sym, input.limit ?? 50);

    if (transactions.length === 0) {
      return formatToolResult({
        symbol: sym,
        message: 'No insider transactions found',
      });
    }

    const summary = summarizeInsiderTrades(transactions);
    return formatToolResult({
      symbol: sym,
      ...(summary ?? {}),
      source: 'Finnhub — SEC Form 4 filings',
    });
  },
});

export const INSIDER_TRADING_DESCRIPTION = `Fetches corporate insider transactions (Form 4 SEC filings).
Returns: recent transactions, 90-day open-market buy/sell aggregation, net dollar value.
Use for: identifying insider sentiment. Open-market buys (code P) are the strongest bullish signal.
Sales (S) are weaker signals due to diversification/tax reasons. Awards (A) and option exercises (M) are NOT signals.
Source: Finnhub Form 4 data.`;
