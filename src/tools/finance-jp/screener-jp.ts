/**
 * 日本株スクリーナー - EDINET DB API
 * 100+指標でのスクリーニング、33業種分類対応
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { callLlm } from '../../model/llm.js';
import { edinetApi } from './edinetdb-api.js';
import { formatToolResult } from '../types.js';
import { getCurrentDate } from '../../agent/prompts.js';

const AVAILABLE_METRICS = `
Supported metrics (use exact keys):
- roe: Return on Equity (%)
- roic: Return on Invested Capital (%)
- roa: Return on Assets (%)
- operating-margin: Operating profit margin (%)
- net-margin: Net profit margin (%)
- equity-ratio: Equity to assets ratio (%)
- per: Price-to-Earnings Ratio
- pbr: Price-to-Book Ratio
- eps: Earnings Per Share (JPY)
- bps: Book Value Per Share (JPY)
- dividend-yield: Dividend yield (%)
- payout-ratio: Dividend payout ratio (%)
- revenue: Total revenue (millions of JPY)
- revenue-growth: Revenue YoY growth (%)
- ni-growth: Net income YoY growth (%)
- eps-growth: EPS YoY growth (%)
- revenue-cagr-3y: Revenue 3-year CAGR (%)
- oi-cagr-3y: Operating income 3-year CAGR (%)
- ni-cagr-3y: Net income 3-year CAGR (%)
- eps-cagr-3y: EPS 3-year CAGR (%)
- health-score: Financial health score (0-100)
- current-ratio: Current ratio
- de-ratio: Debt-to-Equity ratio
- free-cf: Free cash flow (millions of JPY)
- ebitda: EBITDA (millions of JPY)
- financial-leverage: Financial leverage ratio

Operators: gte (>=), lte (<=), gt (>), lt (<), eq (=)

Industries (Japanese, exact match):
情報・通信業, 卸売業, 電気機器, 輸送用機器, 医薬品, 銀行業, 小売業, サービス業, 化学, 機械, 建設業, 不動産業, 食料品, 鉄鋼, 証券・商品先物取引業, 保険業, etc.
`.trim();

const ScreenerConditionSchema = z.object({
  conditions: z.array(z.object({
    metric: z.string().describe('Metric key'),
    operator: z.enum(['gte', 'lte', 'gt', 'lt', 'eq']),
    value: z.number(),
  })),
  industry: z.string().optional(),
  limit: z.number().optional(),
  sort_by: z.string().optional(),
});

type ScreenerConditions = z.infer<typeof ScreenerConditionSchema>;

function buildScreenerPrompt(): string {
  return `You are a Japanese stock screening assistant.
Current date: ${getCurrentDate()}

Given a user's natural language query about stock screening criteria, produce structured screening conditions.

## Available Metrics

${AVAILABLE_METRICS}

## Guidelines

1. Map user criteria to exact metric keys
2. Choose correct operator:
   - "以下", "below", "under", "less than" → lte
   - "以上", "above", "over", "greater than" → gte
   - "equal to", "exactly" → eq
3. Use reasonable defaults:
   - "高ROE" without number → gte 15
   - "高配当" without number → gte 3
   - "割安" → PER lte 15 or PBR lte 1
4. Set limit to 25 unless user specifies otherwise
5. For industry filters, use Japanese industry names (exact match)

Return only the structured output fields.`;
}

export const JP_SCREENER_DESCRIPTION = `
日本上場企業のスクリーニング（EDINET DB）。100+指標（ROE、PER、配当利回り、売上成長率など）と33業種で検索。自然言語クエリで条件を指定可能。
例: "ROE15%以上、配当利回り3%以上の銘柄", "情報・通信業で割安な銘柄"
`.trim();

export function createJpScreener(model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'jp_screener',
    description: `Screens for Japanese listed companies matching financial criteria via EDINET DB. Takes a natural language query and returns matching companies. Supports 100+ metrics (ROE, PER, dividend yield, revenue growth, etc.) and 33 industry classifications. Example: "ROE15%以上、配当利回り3%以上", "情報・通信業で割安な銘柄"`,
    schema: z.object({
      query: z.string().describe('スクリーニング条件を自然言語で記述'),
    }),
    func: async (input, _runManager, config?: RunnableConfig) => {
      // LLM構造化出力 → スクリーニング条件
      let conditions: ScreenerConditions;
      try {
        const { response } = await callLlm(input.query, {
          model,
          systemPrompt: buildScreenerPrompt(),
          outputSchema: ScreenerConditionSchema,
        });
        conditions = ScreenerConditionSchema.parse(response);
      } catch (error) {
        return formatToolResult({
          error: 'スクリーニング条件の解析に失敗しました',
          details: error instanceof Error ? error.message : String(error),
        }, []);
      }

      // EDINET DB スクリーナーAPI実行
      try {
        const params: Record<string, string | number | undefined> = {
          conditions: JSON.stringify(conditions.conditions),
          limit: conditions.limit ?? 25,
        };
        if (conditions.industry) params.industry = conditions.industry;
        if (conditions.sort_by) params.sort = conditions.sort_by;

        const { data, url } = await edinetApi.get('/screener', params);
        return formatToolResult(data, [url]);
      } catch (error) {
        return formatToolResult({
          error: 'スクリーニングに失敗しました',
          details: error instanceof Error ? error.message : String(error),
          conditions: conditions.conditions,
        }, []);
      }
    },
  });
}
