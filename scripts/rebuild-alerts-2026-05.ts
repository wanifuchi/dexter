/**
 * アラートルール全面再構築（2026-05-12 株価上昇に伴う再設計）
 * 実行: npx tsx -r dotenv/config scripts/rebuild-alerts-2026-05.ts dotenv_config_path=/tmp/finx.env
 *
 * 既存ルールを全削除し、現在の保有銘柄に合わせた新ルールセットで置き換える。
 * - CIFR（売却済み）を除外
 * - TEの重複6本を4本に整理
 * - 株価上昇に合わせ利確ライン上方修正・損切ライン引き上げ（利益保護）
 */
import { randomBytes } from 'node:crypto';
import { loadAlertStore, saveAlertStore } from '../src/tools/trading/alert-store.js';
import type { AlertCondition, AlertRule } from '../src/tools/trading/types.js';

interface NewRule {
  ticker: string;
  name: string;
  condition: AlertCondition;
  threshold: number;
  reason: string;
}

const NEW_RULES: NewRule[] = [
  // NVDA — 現在$223、RSI70過熱
  { ticker: 'NVDA', name: 'NVIDIA',             condition: 'price_above', threshold: 245,   reason: '節目突破・利確検討' },
  { ticker: 'NVDA', name: 'NVIDIA',             condition: 'price_below', threshold: 205,   reason: '利益保護（SBI NISA分の含み損転落検知）' },
  // AAPL — 現在$302、RSI84極端過熱、+110%
  { ticker: 'AAPL', name: 'Apple',              condition: 'price_above', threshold: 325,   reason: '上値追い・節目' },
  { ticker: 'AAPL', name: 'Apple',              condition: 'price_below', threshold: 285,   reason: '利益保護（RSI84過熱、損切引上げ）' },
  // IREN — 現在$53、含み損-11%
  { ticker: 'IREN', name: 'IREN (Iris Energy)', condition: 'price_above', threshold: 58,    reason: '含み損解消ライン手前' },
  { ticker: 'IREN', name: 'IREN (Iris Energy)', condition: 'price_below', threshold: 46,    reason: '損切ライン' },
  // WULF — 現在$22、+45%
  { ticker: 'WULF', name: 'TeraWulf',           condition: 'price_above', threshold: 25,    reason: '節目突破' },
  { ticker: 'WULF', name: 'TeraWulf',           condition: 'price_below', threshold: 19,    reason: '利益保護（+45%利益）' },
  // AGIX — 現在$44、RSI72、+12.7%
  { ticker: 'AGIX', name: 'KraneShares AI ETF', condition: 'price_above', threshold: 52,    reason: '節目突破' },
  { ticker: 'AGIX', name: 'KraneShares AI ETF', condition: 'price_below', threshold: 39,    reason: '含み益消失を検知' },
  // SANM — 現在$231、+11.4%
  { ticker: 'SANM', name: 'Sanmina',            condition: 'price_above', threshold: 255,   reason: '節目突破（旧$230は突破済み）' },
  { ticker: 'SANM', name: 'Sanmina',            condition: 'price_below', threshold: 212,   reason: '利益保護（取得$207付近）' },
  // SEI — 現在$71、ほぼ横ばい
  { ticker: 'SEI',  name: 'SEI Investments',    condition: 'price_above', threshold: 80,    reason: '節目突破' },
  { ticker: 'SEI',  name: 'SEI Investments',    condition: 'price_below', threshold: 65,    reason: '損切ライン' },
  // KOPN — 現在$4.72、+21%、高ボラ
  { ticker: 'KOPN', name: 'Kopin',              condition: 'price_above',      threshold: 5.24, reason: '利確ライン（取得+35%）' },
  { ticker: 'KOPN', name: 'Kopin',              condition: 'price_below',      threshold: 4.10, reason: '利益保護（損切を取得超えに引上げ）' },
  { ticker: 'KOPN', name: 'Kopin',              condition: 'change_pct_above', threshold: 10,   reason: '日次急騰アラート +10%' },
  { ticker: 'KOPN', name: 'Kopin',              condition: 'change_pct_below', threshold: -10,  reason: '日次急落アラート -10%' },
  // TE — 現在$8.70、RSI83極端過熱、+35%（重複6本を4本に整理）
  { ticker: 'TE',   name: 'TE',                 condition: 'price_above',      threshold: 10,   reason: '節目突破' },
  { ticker: 'TE',   name: 'TE',                 condition: 'price_below',      threshold: 7.80, reason: '利益保護（+35%利益、RSI83過熱）' },
  { ticker: 'TE',   name: 'TE',                 condition: 'change_pct_above', threshold: 6,    reason: '日次急騰アラート +6%' },
  { ticker: 'TE',   name: 'TE',                 condition: 'change_pct_below', threshold: -6,   reason: '日次急落アラート -6%' },
  // PDFS — 現在$44.78、含み損-8.6%（唯一の下落銘柄、据え置き）
  { ticker: 'PDFS', name: 'PDF Solutions',      condition: 'price_above',      threshold: 58.79, reason: '利確ライン +20%（トレンド狙い）' },
  { ticker: 'PDFS', name: 'PDF Solutions',      condition: 'price_below',      threshold: 44.10, reason: '損切ライン -10%' },
  { ticker: 'PDFS', name: 'PDF Solutions',      condition: 'change_pct_above', threshold: 6,     reason: '日次急騰アラート +6%' },
  { ticker: 'PDFS', name: 'PDF Solutions',      condition: 'change_pct_below', threshold: -6,    reason: '日次急落アラート -6%' },
];

async function main() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  if (!url) {
    console.error('❌ UPSTASH_REDIS_KV_REST_API_URL が設定されていません');
    process.exit(1);
  }
  console.log(`✅ Upstash接続: ${url}`);

  const before = await loadAlertStore();
  console.log(`\n=== 旧ルール（${before.rules.length}本） ===`);
  for (const r of before.rules) {
    console.log(`  ${r.ticker} ${r.condition} ${r.threshold}`);
  }

  const now = Date.now();
  const newRules: AlertRule[] = NEW_RULES.map((r) => ({
    id: randomBytes(6).toString('hex'),
    ticker: r.ticker,
    name: r.name,
    condition: r.condition,
    threshold: r.threshold,
    enabled: true,
    createdAt: now,
  }));

  await saveAlertStore({ version: 1, rules: newRules });

  const after = await loadAlertStore();
  console.log(`\n=== 新ルール（${after.rules.length}本） ===`);
  for (const r of after.rules) {
    console.log(`  ✅ ${r.ticker} ${r.condition} ${r.threshold}`);
  }
  console.log(`\n=== 完了: ${before.rules.length}本 → ${after.rules.length}本 ===`);
}

main().catch((e) => {
  console.error('❌ エラー:', e);
  process.exit(1);
});
