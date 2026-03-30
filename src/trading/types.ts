/**
 * ペーパートレード型定義
 */

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'expired';

export interface PaperOrder {
  id: string;
  ticker: string;
  side: OrderSide;
  type: OrderType;
  shares: number;
  limitPrice?: number;
  status: OrderStatus;
  filledPrice?: number;
  filledAt?: number;
  createdAt: number;
  reason: string;
}

export interface PaperPosition {
  ticker: string;
  shares: number;
  avgCost: number;
}

export interface PaperAccount {
  version: 1;
  cash: number;
  initialCash: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
  updatedAt: number;
}

export interface PaperTradeSummary {
  equity: number;
  cash: number;
  positionsValue: number;
  totalPnl: number;
  totalPnlPct: number;
  totalTrades: number;
  openOrders: number;
}
