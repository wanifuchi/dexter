/**
 * 本日の注目銘柄 — 型定義
 */

export type DailyPicksMarket = 'us' | 'jp' | 'both';
export type DailyPicksMode = 'standard' | 'penny';

export type DailyPicksRequest = {
  market: DailyPicksMarket;
  mode: DailyPicksMode;
  refresh?: boolean;
};

export type Catalyst = {
  title: string;
  url: string;
};

export type PickEvidence = {
  price: boolean;
  volume: boolean;
  news: boolean;
};

export type DailyPick = {
  ticker: string;
  name: string;
  market: 'US' | 'JP';
  price: number;
  changePct: number;
  volume: number;
  score: number;
  evidence: PickEvidence;
  summary: string;
  catalysts: Catalyst[];
  sourceUrls: string[];
};

export type DailyPicksStatus = 'ok' | 'insufficient_data' | 'error';

export type DailyPicksResponse = {
  generatedAt: string;
  market: DailyPicksMarket;
  mode: DailyPicksMode;
  status: DailyPicksStatus;
  picks: DailyPick[];
  warnings: string[];
};

// 内部用: 候補銘柄（evidence収集前）
export type CandidateTicker = {
  ticker: string;
  name: string;
  market: 'US' | 'JP';
  price: number;
  changePct: number;
  volume: number;
};

// 内部用: evidence収集後の候補
export type EvidencedCandidate = CandidateTicker & {
  catalysts: Catalyst[];
  evidence: PickEvidence;
};
