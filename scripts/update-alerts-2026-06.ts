/**
 * アラート閾値の部分更新（2026-06-03 株価上昇に伴う再計算）
 * 実行: npx tsx -r dotenv/config scripts/update-alerts-2026-06.ts dotenv_config_path=/tmp/finx.env
 *
 * 既存ルールのIDを保持しつつ閾値だけ更新する。
 * 対象12本: IREN/WULF/SANM/KOPN/TE/AGIX の price_above/price_below
 */
import { loadAlertStore, saveAlertStore } from '../src/tools/trading/alert-store.js';
import type { AlertCondition } from '../src/tools/trading/types.js';

interface UpdateSpec {
  ticker: string;
  condition: AlertCondition;
  newThreshold: number;
  reason: string;
}

const UPDATES: UpdateSpec[] = [
  // IREN $66.60 RSI61 (取得$59.50)
  { ticker: 'IREN', condition: 'price_above', newThreshold: 75,   reason: '節目突破（旧$58は突破済み）' },
  { ticker: 'IREN', condition: 'price_below', newThreshold: 60,   reason: '利益保護（取得$59.50付近）' },
  // WULF $26.49 RSI65 (取得$14.89, +78%)
  { ticker: 'WULF', condition: 'price_above', newThreshold: 30,   reason: '節目突破（旧$25は突破済み）' },
  { ticker: 'WULF', condition: 'price_below', newThreshold: 23,   reason: '利益保護' },
  // SANM $278.36 RSI75 (取得$207.56, +34%)
  { ticker: 'SANM', condition: 'price_above', newThreshold: 300,  reason: '節目突破（旧$255は突破済み）' },
  { ticker: 'SANM', condition: 'price_below', newThreshold: 245,  reason: '利益保護（取得+18%）' },
  // KOPN $6.10 RSI58 (取得$3.88, +57%)
  { ticker: 'KOPN', condition: 'price_above', newThreshold: 7.00, reason: '節目突破（旧$5.24は突破済み）' },
  { ticker: 'KOPN', condition: 'price_below', newThreshold: 5.20, reason: '利益保護（取得+34%）' },
  // TE $12.04 RSI83極過熱 (取得$6.40, +88%)
  { ticker: 'TE',   condition: 'price_above', newThreshold: 14,   reason: '節目突破（旧$10は突破済み・RSI極過熱）' },
  { ticker: 'TE',   condition: 'price_below', newThreshold: 10.50,reason: '利益保護（取得+64%、厚めに）' },
  // AGIX $49.34 RSI80過熱 (取得$38.79)
  { ticker: 'AGIX', condition: 'price_above', newThreshold: 58,   reason: '節目突破（RSI80過熱、上限接近）' },
  { ticker: 'AGIX', condition: 'price_below', newThreshold: 43,   reason: '利益保護' },
];

async function main() {
  const store = await loadAlertStore();
  console.log(`既存ルール数: ${store.rules.length}\n`);

  let updated = 0;
  let notFound = 0;
  for (const upd of UPDATES) {
    const rule = store.rules.find(
      (r) => r.ticker === upd.ticker && r.condition === upd.condition,
    );
    if (!rule) {
      console.log(`❓ NOTFOUND ${upd.ticker} ${upd.condition}`);
      notFound++;
      continue;
    }
    const old = rule.threshold;
    rule.threshold = upd.newThreshold;
    console.log(`✅ UPDATE ${upd.ticker} ${upd.condition}: ${old} → ${upd.newThreshold} (${upd.reason})`);
    updated++;
  }

  await saveAlertStore(store);

  const after = await loadAlertStore();
  console.log(`\n=== 結果: ${updated}本更新, ${notFound}本未発見, 総ルール数 ${after.rules.length} ===`);
}

main().catch((e) => {
  console.error('❌ エラー:', e);
  process.exit(1);
});
