import { describe, it, expect } from 'bun:test';
import { resolveDailyCloses } from '../portfolio.js';

// 2026-09-18〜09-22 の米国株日足（ET 9:30 始値時刻, gmtoffset -4h）
const ET = { gmtoffset: -14400 };
const TIMESTAMPS = [1789997400 - 86400 * 4, 1789997400 - 86400, 1789997400, 1790083800];

describe('resolveDailyCloses', () => {
  it('引け後に当日足の close が null でも前日終値は前営業日の値になる', () => {
    const meta = { ...ET, regularMarketTime: 1790107201 };
    const { closes, previousClose } = resolveDailyCloses(TIMESTAMPS, [337, 336.13, 338.98, null], meta, 339.75);
    expect(previousClose).toBe(338.98);
    expect(closes.at(-1)).toBe(339.75);
  });

  it('当日足の close がある場合は後ろから2番目が前日終値になる', () => {
    const meta = { ...ET, regularMarketTime: 1790107201 };
    const { closes, previousClose } = resolveDailyCloses(TIMESTAMPS, [337, 336.13, 338.98, 339.75], meta, 339.75);
    expect(previousClose).toBe(338.98);
    expect(closes).toHaveLength(4);
  });

  it('休場日で当日足が無い場合は直近セッションの前日終値を使う', () => {
    const jst = { gmtoffset: 32400, regularMarketTime: 1789713000 }; // 2026-09-18 15:30 JST
    const ts = [1789430400, 1789516800, 1789603200, 1789689600]; // 9/15〜9/18 09:00 JST
    const { previousClose } = resolveDailyCloses(ts, [3021, 3016, 3034, 3025], jst, 3025);
    expect(previousClose).toBe(3034);
  });

  it('regularMarketTime が無い場合は null を除いた後ろから2番目を使う', () => {
    const { previousClose } = resolveDailyCloses(TIMESTAMPS, [1, 2, 3, 4], {}, 4);
    expect(previousClose).toBe(3);
  });
});
