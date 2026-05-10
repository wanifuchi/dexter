/**
 * PDFS / KOPN（2026-05-01 追加ポジション）に対するアラートルール登録
 * 実行: npx tsx -r dotenv/config scripts/seed-pdfs-kopn-alerts.ts dotenv_config_path=/tmp/finx.env
 *
 * 重複チェック: 同じ ticker + condition + threshold が既に存在する場合はスキップ
 */
import { loadAlertStore, addAlertRule } from '../src/tools/trading/alert-store.js';
import type { AlertCondition } from '../src/tools/trading/types.js';

interface ProposedRule {
  ticker: string;
  name: string;
  condition: AlertCondition;
  threshold: number;
  reason: string;
}

const RULES: ProposedRule[] = [
  // PDFS — 取得$48.99 × 300株（SBI特定、AI半導体アナリティクス、トレンド狙い）
  { ticker: 'PDFS', name: 'PDF Solutions', condition: 'price_above',      threshold: 58.79, reason: '利確ライン +20%（トレンド狙い）' },
  { ticker: 'PDFS', name: 'PDF Solutions', condition: 'price_below',      threshold: 44.10, reason: '損切ライン -10%' },
  { ticker: 'PDFS', name: 'PDF Solutions', condition: 'change_pct_above', threshold: 6,     reason: '日次急騰アラート +6%' },
  { ticker: 'PDFS', name: 'PDF Solutions', condition: 'change_pct_below', threshold: -6,    reason: '日次急落アラート -6%' },

  // KOPN — 取得$3.88 × 420株（SBI特定、AI/防衛マイクロディスプレイ、高ボラ、トレンド狙い）
  { ticker: 'KOPN', name: 'Kopin',         condition: 'price_above',      threshold: 5.24,  reason: '利確ライン +35%（高ボラ × トレンド狙いで広め）' },
  { ticker: 'KOPN', name: 'Kopin',         condition: 'price_below',      threshold: 3.30,  reason: '損切ライン -15%（高ボラで広め）' },
  { ticker: 'KOPN', name: 'Kopin',         condition: 'change_pct_above', threshold: 10,    reason: '日次急騰アラート +10%' },
  { ticker: 'KOPN', name: 'Kopin',         condition: 'change_pct_below', threshold: -10,   reason: '日次急落アラート -10%' },
];

async function main() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  if (!url) {
    console.error('❌ UPSTASH_REDIS_KV_REST_API_URL が設定されていません');
    process.exit(1);
  }
  console.log(`✅ Upstash接続: ${url}`);

  const before = await loadAlertStore();
  console.log(`既存ルール数: ${before.rules.length}`);

  const existingKeys = new Set(
    before.rules.map((r) => `${r.ticker}|${r.condition}|${r.threshold}`),
  );

  let added = 0;
  let skipped = 0;
  for (const rule of RULES) {
    const key = `${rule.ticker}|${rule.condition}|${rule.threshold}`;
    if (existingKeys.has(key)) {
      console.log(`⏭  SKIP  ${rule.ticker} ${rule.condition} ${rule.threshold}（既存）`);
      skipped++;
      continue;
    }
    const created = await addAlertRule({
      ticker: rule.ticker,
      name: rule.name,
      condition: rule.condition,
      threshold: rule.threshold,
    });
    console.log(`✅ ADD   ${rule.ticker} ${rule.condition} ${rule.threshold} — ${rule.reason} [id=${created.id}]`);
    added++;
  }

  const after = await loadAlertStore();
  console.log(`\n=== 結果 ===`);
  console.log(`追加: ${added} / スキップ: ${skipped} / 総ルール数: ${after.rules.length}`);
}

main().catch((e) => {
  console.error('❌ エラー:', e);
  process.exit(1);
});
