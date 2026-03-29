/**
 * Phase 1 トレーディングシステムの型定義
 */

/** 口座種別 */
export type AccountType = 'sbi-nisa' | 'sbi-tokutei' | 'rakuten-nisa' | 'rakuten-tokutei';

/** ポートフォリオの個別ポジション */
export interface Position {
  ticker: string;
  name: string;
  shares: number;
  avgCost: number;
  account: AccountType;
  addedAt: number;
}

/** ポートフォリオ全体 */
export interface Portfolio {
  version: 1;
  positions: Position[];
  updatedAt: number;
}

/** アラート条件 */
export type AlertCondition =
  | 'price_above'      // 株価が閾値を超えた
  | 'price_below'      // 株価が閾値を下回った
  | 'dividend_yield_above'  // 配当利回りが閾値を超えた
  | 'per_below'        // PERが閾値を下回った
  | 'pbr_below'        // PBRが閾値を下回った
  | 'change_pct_above' // 日次変動率が閾値を超えた
  | 'change_pct_below'; // 日次変動率が閾値を下回った

/** アラートルール */
export interface AlertRule {
  id: string;
  ticker: string;
  name?: string;
  condition: AlertCondition;
  threshold: number;
  enabled: boolean;
  createdAt: number;
  lastTriggeredAt?: number;
}

/** アラートルールストア */
export interface AlertStore {
  version: 1;
  rules: AlertRule[];
}

/** シグナル検出結果 */
export interface Signal {
  ticker: string;
  name?: string;
  type: AlertCondition;
  currentValue: number;
  threshold: number;
  message: string;
  triggeredAt: number;
}

/** 通知先 */
export type NotificationChannel = 'whatsapp' | 'line' | 'both';
