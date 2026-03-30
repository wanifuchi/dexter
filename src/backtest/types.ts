/**
 * バックテストエンジンの型定義
 * 戦略をプラグインとして追加できる拡張可能な設計
 */

/** 日次価格データ */
export interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 銘柄ごとの価格時系列 */
export type PriceHistory = Map<string, PriceBar[]>;

/** バックテスト設定 */
export interface BacktestConfig {
  strategyId: string;
  tickers: string[];
  startDate: string;
  endDate: string;
  initialCapital: number;
  params: Record<string, unknown>;
}

/** ポートフォリオのスナップショット（日次） */
export interface DailySnapshot {
  date: string;
  equity: number;
  cash: number;
  positions: Record<string, { shares: number; price: number; value: number }>;
  trades: Trade[];
}

/** 売買記録 */
export interface Trade {
  date: string;
  ticker: string;
  side: 'buy' | 'sell';
  shares: number;
  price: number;
  value: number;
  reason: string;
}

/** 年別リターン */
export interface YearlyReturn {
  year: number;
  returnPct: number;
  startEquity: number;
  endEquity: number;
}

/** バックテスト結果 */
export interface BacktestResult {
  config: BacktestConfig;
  equityCurve: { date: string; equity: number }[];
  benchmarkCurve: { date: string; equity: number }[];
  trades: Trade[];
  summary: {
    finalEquity: number;
    totalReturnPct: number;
    annualizedReturnPct: number;
    maxDrawdownPct: number;
    sharpeRatio: number;
    totalTrades: number;
    winRate: number;
  };
  yearlyReturns: YearlyReturn[];
}

/** 戦略の内部状態（シミュレーション中に使う） */
export interface StrategyState {
  cash: number;
  positions: Map<string, number>; // ticker → shares
  trades: Trade[];
}

/**
 * 戦略インターフェース
 * 新しい戦略を追加するにはこのインターフェースを実装する
 */
export interface Strategy {
  /** 戦略ID（ユニーク） */
  id: string;
  /** 表示名 */
  name: string;
  /** 説明 */
  description: string;
  /** パラメータ定義（UIフォーム生成用） */
  paramDefs: ParamDef[];
  /**
   * 日次でコールされるメインロジック
   * @param date 現在の日付
   * @param prices 全銘柄の当日までの価格データ
   * @param state 現在のポートフォリオ状態
   * @param config バックテスト設定
   * @returns 実行すべきトレード（空配列なら何もしない）
   */
  execute(
    date: string,
    prices: PriceHistory,
    state: StrategyState,
    config: BacktestConfig,
  ): Trade[];
}

/** パラメータ定義（UIフォーム用） */
export interface ParamDef {
  key: string;
  label: string;
  type: 'number' | 'string' | 'select';
  defaultValue: unknown;
  options?: { label: string; value: unknown }[];
  min?: number;
  max?: number;
  step?: number;
}
