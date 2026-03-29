/**
 * ポートフォリオ定義の永続化ストア
 * Upstash Redis優先、ローカルファイルフォールバック
 */
import { loadPortfolioKV, savePortfolioKV } from './kv-store.js';
import type { Portfolio, Position } from './types.js';

export async function loadPortfolio(): Promise<Portfolio> {
  return loadPortfolioKV();
}

export async function savePortfolio(portfolio: Portfolio): Promise<void> {
  await savePortfolioKV(portfolio);
}

export async function addPosition(pos: Position): Promise<Portfolio> {
  const portfolio = await loadPortfolio();
  const idx = portfolio.positions.findIndex(
    (p) => p.ticker === pos.ticker && p.account === pos.account,
  );
  if (idx >= 0) {
    portfolio.positions[idx] = pos;
  } else {
    portfolio.positions.push(pos);
  }
  await savePortfolio(portfolio);
  return portfolio;
}

export async function removePosition(ticker: string, account?: string): Promise<Portfolio> {
  const portfolio = await loadPortfolio();
  portfolio.positions = portfolio.positions.filter(
    (p) => !(p.ticker === ticker && (!account || p.account === account)),
  );
  await savePortfolio(portfolio);
  return portfolio;
}
