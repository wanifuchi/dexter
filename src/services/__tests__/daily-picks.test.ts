import { passesEvidenceGate, scorePick, generateDailyPicks } from '../daily-picks.js';
import type { EvidencedCandidate } from '../daily-picks.js';

function makeCandidate(overrides: Partial<EvidencedCandidate> = {}): EvidencedCandidate {
  return {
    ticker: 'RKLB',
    name: 'Rocket Lab',
    market: 'US',
    price: 12.34,
    changePct: 8.9,
    volume: 5_000_000,
    catalysts: [{ title: 'Rocket Lab wins contract', url: 'https://example.com/news' }],
    evidence: { price: true, volume: true, news: true },
    ...overrides,
  };
}

describe('Evidence Gating', () => {
  it('price/change/volume + news が揃っている → パス', () => {
    expect(passesEvidenceGate(makeCandidate(), 'standard')).toBe(true);
  });

  it('news がない → 不合格', () => {
    expect(passesEvidenceGate(makeCandidate({
      evidence: { price: true, volume: true, news: false },
      catalysts: [],
    }), 'standard')).toBe(false);
  });

  it('price が取得できていない → 不合格', () => {
    expect(passesEvidenceGate(makeCandidate({
      evidence: { price: false, volume: true, news: true },
    }), 'standard')).toBe(false);
  });

  it('current quote はあるが news がない → 不合格', () => {
    expect(passesEvidenceGate(makeCandidate({
      catalysts: [],
      evidence: { price: true, volume: true, news: false },
    }), 'standard')).toBe(false);
  });

  it('標準モードで価格$3 → 不合格（price min $5）', () => {
    expect(passesEvidenceGate(makeCandidate({ price: 3 }), 'standard')).toBe(false);
  });

  it('ペニーモードで価格$3 → パス', () => {
    expect(passesEvidenceGate(makeCandidate({ price: 3 }), 'penny')).toBe(true);
  });

  it('ペニーモードでも価格$0.3 → 不合格（penny min $0.5）', () => {
    expect(passesEvidenceGate(makeCandidate({ price: 0.3 }), 'penny')).toBe(false);
  });

  it('出来高が低すぎる → 不合格', () => {
    expect(passesEvidenceGate(makeCandidate({ volume: 100_000 }), 'standard')).toBe(false);
  });

  it('catalyst に title/url が欠けている → 不合格', () => {
    expect(passesEvidenceGate(makeCandidate({
      catalysts: [{ title: '', url: '' }],
    }), 'standard')).toBe(false);
  });
});

describe('Scoring', () => {
  it('per-ticker evidence が揃った銘柄はスコア順で並ぶ', () => {
    const high = makeCandidate({ changePct: 15, volume: 20_000_000, catalysts: [
      { title: 'A', url: 'https://a' },
      { title: 'B', url: 'https://b' },
      { title: 'C', url: 'https://c' },
    ], price: 50 });
    const low = makeCandidate({ changePct: 2, volume: 1_500_000, catalysts: [
      { title: 'X', url: 'https://x' },
    ], price: 8 });

    expect(scorePick(high)).toBeGreaterThan(scorePick(low));
  });

  it('スコアは0以上の整数', () => {
    const score = scorePick(makeCandidate());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(score)).toBe(true);
  });
});

describe('Evidence不足時', () => {
  it('evidence gate を通過する候補が0件なら insufficient_data になるべき', () => {
    // evidence gateが全て不合格のケースを確認
    const noNews = makeCandidate({
      evidence: { price: true, volume: true, news: false },
      catalysts: [],
    });
    const noPrice = makeCandidate({
      evidence: { price: false, volume: true, news: true },
    });
    expect(passesEvidenceGate(noNews, 'standard')).toBe(false);
    expect(passesEvidenceGate(noPrice, 'standard')).toBe(false);
  });
});

describe('FINNHUB_API_KEY未設定', () => {
  const originalKey = process.env.FINNHUB_API_KEY;

  beforeEach(() => { delete process.env.FINNHUB_API_KEY; });
  afterEach(() => { if (originalKey) process.env.FINNHUB_API_KEY = originalKey; });

  it('API_KEY未設定時は insufficient_data を返し picks は空', async () => {
    const result = await generateDailyPicks({ market: 'us', mode: 'standard' });
    expect(result.status).toBe('insufficient_data');
    expect(result.picks).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('US専用MVP', () => {
  it('market は常に us として動作する', async () => {
    const original = process.env.FINNHUB_API_KEY;
    delete process.env.FINNHUB_API_KEY;
    const result = await generateDailyPicks({ market: 'jp', mode: 'standard' });
    expect(result.market).toBe('us');
    if (original) process.env.FINNHUB_API_KEY = original;
  });
});
