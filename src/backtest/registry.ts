/**
 * 戦略レジストリ
 * 新しい戦略はここにimport+追加するだけで使える
 */
import type { Strategy } from './types.js';
import { buyAndHold } from './strategies/buy-and-hold.js';
import { dca } from './strategies/dca.js';
import { momentumRebalance } from './strategies/momentum-rebalance.js';
import { meanReversion } from './strategies/mean-reversion.js';
import { goldenCross } from './strategies/golden-cross.js';
import { breakout } from './strategies/breakout.js';
import { bollingerBounce } from './strategies/bollinger-bounce.js';
import { dualMomentum } from './strategies/dual-momentum.js';
import { volatilityBreakout } from './strategies/volatility-breakout.js';
import { atrTrailingStop } from './strategies/atr-trailing-stop.js';

const strategies: Strategy[] = [
  buyAndHold,
  dca,
  momentumRebalance,
  meanReversion,
  goldenCross,
  breakout,
  bollingerBounce,
  dualMomentum,
  volatilityBreakout,
  atrTrailingStop,
];

export function getStrategies(): Strategy[] {
  return strategies;
}

export function getStrategy(id: string): Strategy | undefined {
  return strategies.find((s) => s.id === id);
}

export function registerStrategy(strategy: Strategy): void {
  strategies.push(strategy);
}
