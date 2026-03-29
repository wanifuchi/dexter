/**
 * EDINET DB ツール群 - 日本株の財務データ・企業情報・AI分析・決算・有報
 * 既存の米国株ツール（src/tools/finance/）には一切影響しない
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { edinetApi, resolveEdinetCode } from './edinetdb-api.js';
import { formatToolResult } from '../types.js';

// 共通の入力スキーマ
const TickerSchema = z.object({
  ticker: z
    .string()
    .describe("証券コード（例: '7203'）、EDINETコード（例: 'E02144'）、または企業名（例: 'トヨタ', 'Sony'）"),
});

const TickerWithPeriodsSchema = z.object({
  ticker: z
    .string()
    .describe("証券コード、EDINETコード、または企業名"),
  period: z
    .enum(['annual', 'quarterly'])
    .optional()
    .describe("'annual'（年次、デフォルト）または 'quarterly'（四半期）"),
  years: z
    .number()
    .optional()
    .describe("取得する年数（デフォルト3、最大6）"),
});

/**
 * 日本株 財務諸表（損益計算書・貸借対照表・キャッシュフロー）
 */
export const jpFinancials = new DynamicStructuredTool({
  name: 'jp_financials',
  description: 'Fetches comprehensive financial time series for a Japanese listed company from EDINET DB. Returns up to 6 years of: revenue, operating income, net income, total assets, equity ratio, ROE, EPS, BPS, PER, dividends, cash flows, and more. Covers income statement, balance sheet, and cash flow combined.',
  schema: TickerWithPeriodsSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const params: Record<string, string | number> = {
      years: input.years ?? 3,
      period: input.period ?? 'annual',
    };
    const { data, url } = await edinetApi.get(`/companies/${edinetCode}/financials`, params);
    return formatToolResult(data.data || data, [url]);
  },
});

/**
 * 日本株 企業情報（基本情報＋最新財務指標＋健全性スコア）
 */
export const jpCompanyInfo = new DynamicStructuredTool({
  name: 'jp_company_info',
  description: 'Fetches company profile for a Japanese listed company from EDINET DB. Includes: company name, industry, securities code, accounting standard, latest financials (revenue, operating income, ROE, equity ratio, EPS, PER, BPS), key ratios (ROIC, D/E ratio, dividend yield), and financial health score (0-100).',
  schema: TickerSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const { data, url } = await edinetApi.get(`/companies/${edinetCode}`, {});
    return formatToolResult(data.data || data, [url]);
  },
});

/**
 * 日本株 AI分析（健全性スコア・AI要約・スコア履歴）
 */
export const jpAnalysis = new DynamicStructuredTool({
  name: 'jp_analysis',
  description: 'Fetches AI-powered analysis of a Japanese company from EDINET DB. Includes: financial health score (0-100), AI-generated company summary, and score history over 6 years. Based on annual securities reports (有価証券報告書).',
  schema: TickerSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const { data, url } = await edinetApi.get(`/companies/${edinetCode}/analysis`, {});
    return formatToolResult(data.data || data, [url]);
  },
});

/**
 * 日本株 決算短信（TDNet）
 */
export const jpEarnings = new DynamicStructuredTool({
  name: 'jp_earnings',
  description: 'Fetches recent TDNet earnings disclosures (決算短信) for a Japanese company from EDINET DB. Returns quarterly/annual results including: disclosure date, revenue, operating income, net income, EPS, YoY changes. Useful for tracking earnings surprises and recent performance.',
  schema: z.object({
    ticker: z.string().describe("証券コード、EDINETコード、または企業名"),
    limit: z.number().optional().describe("取得件数（デフォルト8、最大30）"),
  }),
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const { data, url } = await edinetApi.get(`/companies/${edinetCode}/earnings`, {
      limit: input.limit ?? 8,
    });
    const earningsData = data.data as Record<string, unknown> | undefined;
    return formatToolResult(earningsData?.earnings || data.data || data, [url]);
  },
});

/**
 * 日本株 有価証券報告書テキスト読み取り
 */
export const jpFilingText = new DynamicStructuredTool({
  name: 'jp_filing_text',
  description: 'Reads text blocks from Japanese securities reports (有価証券報告書) via EDINET DB. Returns sections like business risks, management discussion, corporate governance, etc. Useful for qualitative analysis beyond numbers.',
  schema: z.object({
    ticker: z.string().describe("証券コード、EDINETコード、または企業名"),
    section: z
      .string()
      .optional()
      .describe("取得するセクション（例: 'risk', 'business', 'governance'）。省略時は全セクション"),
  }),
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const params: Record<string, string | undefined> = {};
    if (input.section) params.section = input.section;
    const { data, url } = await edinetApi.get(`/companies/${edinetCode}/text-blocks`, params);
    return formatToolResult(data.data || data, [url]);
  },
});

/**
 * 日本株 大量保有報告書
 */
export const jpShareholders = new DynamicStructuredTool({
  name: 'jp_shareholders',
  description: 'Fetches major shareholder reports (大量保有報告書/5%超保有者) for a Japanese company from EDINET DB. Shows who holds significant stakes and changes in ownership.',
  schema: TickerSchema,
  func: async (input) => {
    const edinetCode = await resolveEdinetCode(input.ticker);
    const { data, url } = await edinetApi.get(`/companies/${edinetCode}/shareholders`, {});
    return formatToolResult(data.data || data, [url]);
  },
});

// ツール説明文（レジストリ用）
export const JP_FINANCIALS_DESCRIPTION = `日本上場企業の財務諸表（損益計算書・BS・CF）をEDINET DBから取得。最大6年分。証券コード・企業名・EDINETコードで検索可能。約3,800社対応。`;
export const JP_COMPANY_INFO_DESCRIPTION = `日本上場企業の企業情報・最新財務指標・健全性スコア(0-100)をEDINET DBから取得。業種、ROE、PER、配当利回り等を含む。`;
export const JP_ANALYSIS_DESCRIPTION = `日本上場企業のAI分析（健全性スコア・AI要約・スコア履歴）をEDINET DBから取得。有価証券報告書ベースの分析。`;
export const JP_EARNINGS_DESCRIPTION = `日本上場企業の決算短信（TDNet）をEDINET DBから取得。四半期・通期の売上・利益・EPS・前年比を含む。`;
export const JP_FILING_TEXT_DESCRIPTION = `日本上場企業の有価証券報告書のテキストを取得。事業リスク、経営分析、ガバナンス等の定性情報。`;
export const JP_SHAREHOLDERS_DESCRIPTION = `日本上場企業の大量保有報告書（5%超保有者）を取得。大株主の動向を確認。`;
