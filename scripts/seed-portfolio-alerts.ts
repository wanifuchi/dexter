/**
 * 保有銘柄に対するアラートルールを一括登録するワンオフスクリプト
 * 実行: npx tsx -r dotenv/config scripts/seed-portfolio-alerts.ts dotenv_config_path=/tmp/.env.production
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
  // NVDA — 取得$131.55, 現在$213.17, +62%
  { ticker: 'NVDA', name: 'NVIDIA',         condition: 'price_above', threshold: 235, reason: '節目突破で部分利確検討' },
  { ticker: 'NVDA', name: 'NVIDIA',         condition: 'price_below', threshold: 195, reason: 'MA50付近、撤退判断' },
  // AAPL — 取得$143.49, 現在$270.71, +89%
  { ticker: 'AAPL', name: 'Apple',          condition: 'price_above', threshold: 290, reason: '節目突破' },
  { ticker: 'AAPL', name: 'Apple',          condition: 'price_below', threshold: 250, reason: '含み益保護(-7.7%)' },
  // EC — 取得$9.30, 現在$13.97, +50%
  { ticker: 'EC',   name: 'Ecopetrol',      condition: 'price_above', threshold: 15,  reason: '節目突破' },
  { ticker: 'EC',   name: 'Ecopetrol',      condition: 'price_below', threshold: 12,  reason: '押し目買い候補' },
  // IREN — 取得$59.50, 現在$44.44, -25%
  { ticker: 'IREN', name: 'Iris Energy',    condition: 'price_above', threshold: 55,  reason: '含み損ほぼ解消、反発確認' },
  { ticker: 'IREN', name: 'Iris Energy',    condition: 'price_below', threshold: 40,  reason: '損切ライン(-33%)' },
  // CIFR — 取得$15.07, 現在$17.26, +14.5%
  { ticker: 'CIFR', name: 'Cipher Mining',  condition: 'price_above', threshold: 20,  reason: '節目突破' },
  { ticker: 'CIFR', name: 'Cipher Mining',  condition: 'price_below', threshold: 14,  reason: '損切(-19%)' },
  // WULF — 取得$14.89, 現在$20.80, +40%
  { ticker: 'WULF', name: 'TeraWulf',       condition: 'price_above', threshold: 24,  reason: '節目突破' },
  { ticker: 'WULF', name: 'TeraWulf',       condition: 'price_below', threshold: 17,  reason: '含み益保護(-18%)' },
  // AGIX — 取得$38.79, 現在$38.59, -0.5%, RSI70過熱
  { ticker: 'AGIX', name: 'AGIX',           condition: 'price_above', threshold: 50,  reason: '節目突破' },
  { ticker: 'AGIX', name: 'AGIX',           condition: 'price_below', threshold: 32,  reason: '損切(-17%)、RSI70警戒' },
  // SANM — 取得$207.56, 現在$215.46, RSI93極度過熱
  { ticker: 'SANM', name: 'Sanmina',        condition: 'price_above', threshold: 230, reason: '急騰追従' },
  { ticker: 'SANM', name: 'Sanmina',        condition: 'price_below', threshold: 185, reason: 'RSI93反落警戒(-14%)' },
  // SEI — 取得$72.40, 現在$74.44, +2.8%
  { ticker: 'SEI',  name: 'SEI Investments', condition: 'price_above', threshold: 85,  reason: '節目突破' },
  { ticker: 'SEI',  name: 'SEI Investments', condition: 'price_below', threshold: 63,  reason: '損切(-15%)' },
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
    console.log(`✅ ADD   ${rule.ticker} ${rule.condition} $${rule.threshold} — ${rule.reason} [id=${created.id}]`);
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
