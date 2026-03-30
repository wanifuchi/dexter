/**
 * 戦略レジストリ
 * 新しい戦略はここに追加するだけで使える
 */
import type { Strategy } from './types.js';
import { buyAndHold } from './strategies/buy-and-hold.js';
import { dca } from './strategies/dca.js';
import { momentumRebalance } from './strategies/momentum-rebalance.js';

const strategies: Strategy[] = [
  buyAndHold,
  dca,
  momentumRebalance,
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
