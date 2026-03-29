/**
 * ポートフォリオ定義の永続化ストア
 * .dexter/trading/portfolio.json に保存
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dexterPath } from '../../utils/paths.js';
import type { Portfolio, Position } from './types.js';

const PORTFOLIO_PATH = dexterPath('trading', 'portfolio.json');

function emptyPortfolio(): Portfolio {
  return { version: 1, positions: [], updatedAt: Date.now() };
}

export function loadPortfolio(): Portfolio {
  if (!existsSync(PORTFOLIO_PATH)) return emptyPortfolio();
  try {
    return JSON.parse(readFileSync(PORTFOLIO_PATH, 'utf-8'));
  } catch {
    return emptyPortfolio();
  }
}

export function savePortfolio(portfolio: Portfolio): void {
  portfolio.updatedAt = Date.now();
  const dir = dirname(PORTFOLIO_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(PORTFOLIO_PATH, JSON.stringify(portfolio, null, 2), 'utf-8');
}

export function addPosition(pos: Position): Portfolio {
  const portfolio = loadPortfolio();
  // 同一ticker+accountの既存ポジションは上書き
  const idx = portfolio.positions.findIndex(
    (p) => p.ticker === pos.ticker && p.account === pos.account,
  );
  if (idx >= 0) {
    portfolio.positions[idx] = pos;
  } else {
    portfolio.positions.push(pos);
  }
  savePortfolio(portfolio);
  return portfolio;
}

export function removePosition(ticker: string, account?: string): Portfolio {
  const portfolio = loadPortfolio();
  portfolio.positions = portfolio.positions.filter(
    (p) => !(p.ticker === ticker && (!account || p.account === account)),
  );
  savePortfolio(portfolio);
  return portfolio;
}
