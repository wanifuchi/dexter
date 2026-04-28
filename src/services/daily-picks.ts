/**
 * 本日の注目銘柄 — Server-side Data Pipeline
 *
 * 4段階: 候補抽出 → evidence収集 → gating → scoring
 * LLMを使わない deterministic パイプライン
 */
import type {
  DailyPicksRequest, DailyPicksResponse, DailyPick,
  CandidateTicker, EvidencedCandidate, Catalyst,
} from './daily-picks-types.js';
import { getCachedPicks, setCachedPicks } from './daily-picks-cache.js';

const YF_BASE = 'https://query1.finance.yahoo.com';
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };

// === Step 1: 候補抽出 ===

const STANDARD_PRICE_MIN = 5;
const PENNY_PRICE_MIN = 0.5;
const VOLUME_MIN = 500_000;

/**
 * Yahoo Finance screenerから当日gainers/mostActiveを取得
 */
async function fetchYahooGainers(count: number = 20): Promise<CandidateTicker[]> {
  const candidates: CandidateTicker[] = [];

  // v8 chart APIで主要ティッカーを事前リストから取得する方式
  // Yahoo screener APIは不安定なので、Finnhub APIのmarket statusを使う
  // ここではFinnhub /stock/symbol + top gainers的な取得を行う

  // 実用的な方式: Yahoo Finance trending tickersを使う
  try {
    const url = `${YF_BASE}/v1/finance/trending/US?count=${count}`;
    const res = await fetch(url, { headers: UA });
    if (res.ok) {
      const data = await res.json() as any;
      const quotes = data?.finance?.result?.[0]?.quotes ?? [];
      for (const q of quotes) {
        if (q.symbol) {
          candidates.push({
            ticker: q.symbol,
            name: q.shortName ?? q.symbol,
            market: 'US' as const,
            price: 0, changePct: 0, volume: 0, // Step 2で埋める
          });
        }
      }
    }
  } catch {}

  // フォールバック: Finnhub market news関連のティッカーを抽出
  if (candidates.length < 5) {
    try {
      const apiKey = process.env.FINNHUB_API_KEY;
      if (apiKey) {
        const url = `https://finnhub.io/api/v1/news?category=general&token=${apiKey}`;
        const res = await fetch(url, { headers: UA });
        if (res.ok) {
          const news = await res.json() as any[];
          const mentioned = new Set<string>();
          for (const n of (news ?? []).slice(0, 30)) {
            const related = (n.related ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
            for (const t of related) {
              if (t.length >= 2 && t.length <= 5 && /^[A-Z]+$/.test(t) && !mentioned.has(t)) {
                mentioned.add(t);
                candidates.push({
                  ticker: t, name: t, market: 'US' as const,
                  price: 0, changePct: 0, volume: 0,
                });
              }
            }
          }
        }
      }
    } catch {}
  }

  // 重複除去
  const seen = new Set<string>();
  return candidates.filter(c => {
    if (seen.has(c.ticker)) return false;
    seen.add(c.ticker);
    return true;
  }).slice(0, 20);
}

// === Step 2: Evidence収集 ===

async function fetchQuote(ticker: string): Promise<{ price: number; changePct: number; volume: number; name: string } | null> {
  try {
    const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const price = meta?.regularMarketPrice;
    const prevClose = meta?.chartPreviousClose ?? meta?.previousClose;
    const volume = meta?.regularMarketVolume ?? 0;
    const changePct = prevClose && price ? ((price - prevClose) / prevClose) * 100 : 0;
    const name = meta?.shortName ?? meta?.longName ?? ticker;

    if (price == null || price <= 0) return null;
    return { price, changePct, volume, name };
  } catch { return null; }
}

/**
 * Google翻訳の無料エンドポイントで英→日翻訳
 * （公式APIキー不要、レート制限あり）
 */
async function translateToJa(text: string): Promise<string | null> {
  if (!text) return null;
  // 日本語が既に含まれていれば翻訳不要
  if (/[぀-ゟ゠-ヿ一-龯]/.test(text)) return null;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=${encodeURIComponent(text.slice(0, 500))}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const data = await res.json() as any[];
    // [[[ "translated", "original", null, null, ...], ...], ...]
    const segments = data?.[0];
    if (!Array.isArray(segments)) return null;
    return segments.map((s: any) => s?.[0] || '').join('').trim() || null;
  } catch { return null; }
}

async function fetchNews(ticker: string): Promise<Catalyst[]> {
  const catalysts: Catalyst[] = [];

  // Finnhub company news (直近24時間)
  try {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (apiKey) {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${yesterday}&to=${today}&token=${apiKey}`;
      const res = await fetch(url, { headers: UA });
      if (res.ok) {
        const news = await res.json() as any[];
        for (const n of (news ?? []).slice(0, 3)) {
          if (n.headline && n.url) {
            catalysts.push({ title: n.headline, url: n.url });
          }
        }
      }
    }
  } catch {}

  // 日本語訳を並列で取得（失敗してもtitleはそのまま使われる）
  if (catalysts.length > 0) {
    const translations = await Promise.all(
      catalysts.map(c => translateToJa(c.title))
    );
    catalysts.forEach((c, i) => {
      if (translations[i]) c.titleJa = translations[i] as string;
    });
  }

  return catalysts;
}

async function collectEvidence(candidate: CandidateTicker): Promise<EvidencedCandidate | null> {
  const [quote, catalysts] = await Promise.all([
    fetchQuote(candidate.ticker),
    fetchNews(candidate.ticker),
  ]);

  if (!quote) return null;

  return {
    ...candidate,
    name: quote.name,
    price: quote.price,
    changePct: quote.changePct,
    volume: quote.volume,
    catalysts,
    evidence: {
      price: quote.price > 0,
      volume: quote.volume > 0,
      news: catalysts.length > 0,
    },
  };
}

// === Step 3: Evidence Gating ===

function passesEvidenceGate(candidate: EvidencedCandidate, mode: string): boolean {
  // 必須: price + volume + news
  if (!candidate.evidence.price || !candidate.evidence.volume || !candidate.evidence.news) {
    return false;
  }

  // 価格フィルタ
  const priceMin = mode === 'penny' ? PENNY_PRICE_MIN : STANDARD_PRICE_MIN;
  if (candidate.price < priceMin) return false;

  // 出来高フィルタ（極端に薄い銘柄を除外）
  if (candidate.volume < VOLUME_MIN) return false;

  // ニュースにtitleとurlがあるか
  if (candidate.catalysts.every(c => !c.title || !c.url)) return false;

  return true;
}

// === Step 4: スコアリング ===

function scorePick(candidate: EvidencedCandidate): number {
  let score = 0;

  // momentumScore (0-30): 当日騰落率
  const absChange = Math.abs(candidate.changePct);
  score += Math.min(absChange * 3, 30);

  // volumeScore (0-25): 出来高水準
  if (candidate.volume > 10_000_000) score += 25;
  else if (candidate.volume > 5_000_000) score += 20;
  else if (candidate.volume > 2_000_000) score += 15;
  else if (candidate.volume > 1_000_000) score += 10;
  else score += 5;

  // catalystScore (0-30): ニュース件数
  const newsCount = candidate.catalysts.length;
  score += Math.min(newsCount * 10, 30);

  // liquidityScore (0-15): 価格帯による流動性推定
  if (candidate.price >= 50) score += 15;
  else if (candidate.price >= 20) score += 12;
  else if (candidate.price >= 10) score += 8;
  else if (candidate.price >= 5) score += 5;
  else score += 2; // ペニー

  return Math.round(score);
}

function buildSummary(candidate: EvidencedCandidate): string {
  const parts: string[] = [];
  if (candidate.changePct > 3) parts.push(`${candidate.changePct.toFixed(1)}%上昇`);
  else if (candidate.changePct < -3) parts.push(`${candidate.changePct.toFixed(1)}%下落`);
  if (candidate.volume > 5_000_000) parts.push('出来高増加');
  if (candidate.catalysts.length > 0) parts.push(`当日材料${candidate.catalysts.length}件`);
  return parts.join('、') || '当日の価格・出来高変動あり';
}

// === メインパイプライン ===

export async function generateDailyPicks(req: DailyPicksRequest): Promise<DailyPicksResponse> {
  const market = 'us' as const; // US専用MVP
  const { mode, refresh } = req;

  // FINNHUB_API_KEY未設定チェック
  if (!process.env.FINNHUB_API_KEY) {
    return {
      generatedAt: new Date().toISOString(),
      market, mode,
      status: 'insufficient_data',
      picks: [],
      warnings: ['FINNHUB_API_KEY is not configured. Cannot fetch market data.'],
    };
  }

  // キャッシュチェック
  if (!refresh) {
    const cached = await getCachedPicks(market, mode);
    if (cached) return cached;
  }

  const warnings: string[] = [];

  // Step 1: 候補抽出（US専用）
  const candidates = await fetchYahooGainers(20);

  if (candidates.length === 0) {
    const response: DailyPicksResponse = {
      generatedAt: new Date().toISOString(),
      market, mode,
      status: 'insufficient_data',
      picks: [],
      warnings: ['Insufficient current evidence to publish daily picks.'],
    };
    await setCachedPicks(market, mode, response);
    return response;
  }

  // Step 2: Evidence収集（並列、最大10件ずつ）
  const evidenced: EvidencedCandidate[] = [];
  const batchSize = 10;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(c => collectEvidence(c)));
    for (const r of results) {
      if (r) evidenced.push(r);
    }
  }

  // Step 3: Evidence Gating
  const gated = evidenced.filter(c => passesEvidenceGate(c, mode));

  // Step 4: Scoring & 上位5件
  const picks: DailyPick[] = gated
    .map(c => ({
      ticker: c.ticker,
      name: c.name,
      market: c.market,
      price: c.price,
      changePct: Math.round(c.changePct * 100) / 100,
      volume: c.volume,
      score: scorePick(c),
      evidence: c.evidence,
      summary: buildSummary(c),
      catalysts: c.catalysts,
      sourceUrls: c.catalysts.map(cat => cat.url).filter(Boolean),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const status = picks.length > 0 ? 'ok' : 'insufficient_data';
  if (picks.length === 0) {
    warnings.push('Insufficient current evidence to publish daily picks.');
  }

  const response: DailyPicksResponse = {
    generatedAt: new Date().toISOString(),
    market, mode, status, picks, warnings,
  };

  await setCachedPicks(market, mode, response);
  return response;
}

// テスト用エクスポート
export { passesEvidenceGate, scorePick, collectEvidence, fetchQuote, fetchNews };
export type { EvidencedCandidate };
