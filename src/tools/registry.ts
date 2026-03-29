import { StructuredToolInterface } from '@langchain/core/tools';
import { createGetFinancials, createGetMarketData, createReadFilings, createScreenStocks } from './finance/index.js';
import { yahooQuote, yahooChart, yahooSummary, YAHOO_QUOTE_DESCRIPTION, YAHOO_CHART_DESCRIPTION, YAHOO_SUMMARY_DESCRIPTION } from './finance/yahoo-finance.js';
import { avGlobalQuote, avCompanyOverview, AV_GLOBAL_QUOTE_DESCRIPTION, AV_COMPANY_OVERVIEW_DESCRIPTION } from './finance/alpha-vantage.js';
import {
  finnhubRecommendation, finnhubNews, finnhubQuote, finnhubEarningsCalendar,
  finnhubProfile, finnhubPriceTarget,
  FINNHUB_RECOMMENDATION_DESCRIPTION, FINNHUB_NEWS_DESCRIPTION, FINNHUB_QUOTE_DESCRIPTION,
  FINNHUB_EARNINGS_DESCRIPTION, FINNHUB_PROFILE_DESCRIPTION, FINNHUB_PRICE_TARGET_DESCRIPTION,
} from './finance/finnhub.js';
import {
  twelveDataTechnicals, twelveDataTimeSeries,
  TD_TECHNICALS_DESCRIPTION, TD_TIME_SERIES_DESCRIPTION,
} from './finance/twelve-data.js';
import {
  fmpProfile, fmpIncomeStatement, fmpScreener, fmpKeyMetrics,
  FMP_PROFILE_DESCRIPTION, FMP_INCOME_DESCRIPTION, FMP_SCREENER_DESCRIPTION, FMP_KEY_METRICS_DESCRIPTION,
} from './finance/fmp.js';
import {
  polygonPrevClose, polygonAggregates, polygonTickerDetails,
  POLYGON_PREV_CLOSE_DESCRIPTION, POLYGON_AGGREGATES_DESCRIPTION, POLYGON_TICKER_DETAILS_DESCRIPTION,
} from './finance/polygon.js';
// === 日本株ツール (finance-jp/) ===
import {
  jpFinancials, jpCompanyInfo, jpAnalysis, jpEarnings, jpFilingText, jpShareholders,
  JP_FINANCIALS_DESCRIPTION, JP_COMPANY_INFO_DESCRIPTION, JP_ANALYSIS_DESCRIPTION,
  JP_EARNINGS_DESCRIPTION, JP_FILING_TEXT_DESCRIPTION, JP_SHAREHOLDERS_DESCRIPTION,
  isEdinetAvailable,
} from './finance-jp/index.js';
import { jpStockPrice, JP_STOCK_PRICE_DESCRIPTION, isJQuantsAvailable } from './finance-jp/index.js';
import { createJpScreener, JP_SCREENER_DESCRIPTION } from './finance-jp/index.js';

import { exaSearch, perplexitySearch, tavilySearch, WEB_SEARCH_DESCRIPTION, xSearchTool, X_SEARCH_DESCRIPTION } from './search/index.js';
import { skillTool, SKILL_TOOL_DESCRIPTION } from './skill.js';
import { webFetchTool, WEB_FETCH_DESCRIPTION } from './fetch/web-fetch.js';
import { browserTool, BROWSER_DESCRIPTION } from './browser/browser.js';
import { readFileTool, READ_FILE_DESCRIPTION } from './filesystem/read-file.js';
import { writeFileTool, WRITE_FILE_DESCRIPTION } from './filesystem/write-file.js';
import { editFileTool, EDIT_FILE_DESCRIPTION } from './filesystem/edit-file.js';
import { GET_FINANCIALS_DESCRIPTION } from './finance/get-financials.js';
import { GET_MARKET_DATA_DESCRIPTION } from './finance/get-market-data.js';
import { READ_FILINGS_DESCRIPTION } from './finance/read-filings.js';
import { SCREEN_STOCKS_DESCRIPTION } from './finance/screen-stocks.js';
import { heartbeatTool, HEARTBEAT_TOOL_DESCRIPTION } from './heartbeat/heartbeat-tool.js';
import { cronTool, CRON_TOOL_DESCRIPTION } from './cron/cron-tool.js';
import { memoryGetTool, MEMORY_GET_DESCRIPTION, memorySearchTool, MEMORY_SEARCH_DESCRIPTION, memoryUpdateTool, MEMORY_UPDATE_DESCRIPTION } from './memory/index.js';
import { discoverSkills } from '../skills/index.js';
// === トレーディングツール (trading/) ===
import {
  portfolioManager, PORTFOLIO_MANAGER_DESCRIPTION,
  alertManager, ALERT_MANAGER_DESCRIPTION,
  sendNotification, SEND_NOTIFICATION_DESCRIPTION,
} from './trading/index.js';

/**
 * A registered tool with its rich description for system prompt injection.
 */
export interface RegisteredTool {
  /** Tool name (must match the tool's name property) */
  name: string;
  /** The actual tool instance */
  tool: StructuredToolInterface;
  /** Rich description for system prompt (includes when to use, when not to use, etc.) */
  description: string;
}

/**
 * Get all registered tools with their descriptions.
 * Conditionally includes tools based on environment configuration.
 *
 * @param model - The model name (needed for tools that require model-specific configuration)
 * @returns Array of registered tools
 */
export function getToolRegistry(model: string): RegisteredTool[] {
  const tools: RegisteredTool[] = [
    {
      name: 'get_financials',
      tool: createGetFinancials(model),
      description: GET_FINANCIALS_DESCRIPTION,
    },
    {
      name: 'get_market_data',
      tool: createGetMarketData(model),
      description: GET_MARKET_DATA_DESCRIPTION,
    },
    {
      name: 'read_filings',
      tool: createReadFilings(model),
      description: READ_FILINGS_DESCRIPTION,
    },
    {
      name: 'stock_screener',
      tool: createScreenStocks(model),
      description: SCREEN_STOCKS_DESCRIPTION,
    },
    {
      name: 'web_fetch',
      tool: webFetchTool,
      description: WEB_FETCH_DESCRIPTION,
    },
    {
      name: 'browser',
      tool: browserTool,
      description: BROWSER_DESCRIPTION,
    },
    {
      name: 'read_file',
      tool: readFileTool,
      description: READ_FILE_DESCRIPTION,
    },
    {
      name: 'write_file',
      tool: writeFileTool,
      description: WRITE_FILE_DESCRIPTION,
    },
    {
      name: 'edit_file',
      tool: editFileTool,
      description: EDIT_FILE_DESCRIPTION,
    },
    {
      name: 'heartbeat',
      tool: heartbeatTool,
      description: HEARTBEAT_TOOL_DESCRIPTION,
    },
    {
      name: 'cron',
      tool: cronTool,
      description: CRON_TOOL_DESCRIPTION,
    },
    {
      name: 'memory_search',
      tool: memorySearchTool,
      description: MEMORY_SEARCH_DESCRIPTION,
    },
    {
      name: 'memory_get',
      tool: memoryGetTool,
      description: MEMORY_GET_DESCRIPTION,
    },
    {
      name: 'memory_update',
      tool: memoryUpdateTool,
      description: MEMORY_UPDATE_DESCRIPTION,
    },
  ];

  // Yahoo Finance tools (no API key required — always available)
  tools.push(
    {
      name: 'yahoo_quote',
      tool: yahooQuote,
      description: YAHOO_QUOTE_DESCRIPTION,
    },
    {
      name: 'yahoo_chart',
      tool: yahooChart,
      description: YAHOO_CHART_DESCRIPTION,
    },
    {
      name: 'yahoo_summary',
      tool: yahooSummary,
      description: YAHOO_SUMMARY_DESCRIPTION,
    },
  );

  // Finnhub tools (if API key is configured)
  if (process.env.FINNHUB_API_KEY) {
    tools.push(
      { name: 'finnhub_recommendation', tool: finnhubRecommendation, description: FINNHUB_RECOMMENDATION_DESCRIPTION },
      { name: 'finnhub_news', tool: finnhubNews, description: FINNHUB_NEWS_DESCRIPTION },
      { name: 'finnhub_quote', tool: finnhubQuote, description: FINNHUB_QUOTE_DESCRIPTION },
      { name: 'finnhub_earnings_calendar', tool: finnhubEarningsCalendar, description: FINNHUB_EARNINGS_DESCRIPTION },
      { name: 'finnhub_profile', tool: finnhubProfile, description: FINNHUB_PROFILE_DESCRIPTION },
      { name: 'finnhub_price_target', tool: finnhubPriceTarget, description: FINNHUB_PRICE_TARGET_DESCRIPTION },
    );
  }

  // Twelve Data tools (if API key is configured)
  if (process.env.TWELVE_DATA_API_KEY) {
    tools.push(
      { name: 'td_technicals', tool: twelveDataTechnicals, description: TD_TECHNICALS_DESCRIPTION },
      { name: 'td_time_series', tool: twelveDataTimeSeries, description: TD_TIME_SERIES_DESCRIPTION },
    );
  }

  // FMP tools (if API key is configured)
  if (process.env.FMP_API_KEY) {
    tools.push(
      { name: 'fmp_profile', tool: fmpProfile, description: FMP_PROFILE_DESCRIPTION },
      { name: 'fmp_income_statement', tool: fmpIncomeStatement, description: FMP_INCOME_DESCRIPTION },
      { name: 'fmp_screener', tool: fmpScreener, description: FMP_SCREENER_DESCRIPTION },
      { name: 'fmp_key_metrics', tool: fmpKeyMetrics, description: FMP_KEY_METRICS_DESCRIPTION },
    );
  }

  // Polygon.io tools (if API key is configured)
  if (process.env.POLYGON_API_KEY) {
    tools.push(
      { name: 'polygon_prev_close', tool: polygonPrevClose, description: POLYGON_PREV_CLOSE_DESCRIPTION },
      { name: 'polygon_aggregates', tool: polygonAggregates, description: POLYGON_AGGREGATES_DESCRIPTION },
      { name: 'polygon_ticker_details', tool: polygonTickerDetails, description: POLYGON_TICKER_DETAILS_DESCRIPTION },
    );
  }

  // Alpha Vantage tools (if API key is configured)
  if (process.env.ALPHA_VANTAGE_API_KEY) {
    tools.push(
      {
        name: 'av_global_quote',
        tool: avGlobalQuote,
        description: AV_GLOBAL_QUOTE_DESCRIPTION,
      },
      {
        name: 'av_company_overview',
        tool: avCompanyOverview,
        description: AV_COMPANY_OVERVIEW_DESCRIPTION,
      },
    );
  }

  // Include web_search if Exa, Perplexity, or Tavily API key is configured (Exa → Perplexity → Tavily)
  if (process.env.EXASEARCH_API_KEY) {
    tools.push({
      name: 'web_search',
      tool: exaSearch,
      description: WEB_SEARCH_DESCRIPTION,
    });
  } else if (process.env.PERPLEXITY_API_KEY) {
    tools.push({
      name: 'web_search',
      tool: perplexitySearch,
      description: WEB_SEARCH_DESCRIPTION,
    });
  } else if (process.env.TAVILY_API_KEY) {
    tools.push({
      name: 'web_search',
      tool: tavilySearch,
      description: WEB_SEARCH_DESCRIPTION,
    });
  }

  // Include x_search if X Bearer Token is configured
  if (process.env.X_BEARER_TOKEN) {
    tools.push({
      name: 'x_search',
      tool: xSearchTool,
      description: X_SEARCH_DESCRIPTION,
    });
  }

  // === 日本株ツール (EDINET DB — if API key is configured) ===
  if (isEdinetAvailable()) {
    tools.push(
      { name: 'jp_financials', tool: jpFinancials, description: JP_FINANCIALS_DESCRIPTION },
      { name: 'jp_company_info', tool: jpCompanyInfo, description: JP_COMPANY_INFO_DESCRIPTION },
      { name: 'jp_analysis', tool: jpAnalysis, description: JP_ANALYSIS_DESCRIPTION },
      { name: 'jp_earnings', tool: jpEarnings, description: JP_EARNINGS_DESCRIPTION },
      { name: 'jp_filing_text', tool: jpFilingText, description: JP_FILING_TEXT_DESCRIPTION },
      { name: 'jp_shareholders', tool: jpShareholders, description: JP_SHAREHOLDERS_DESCRIPTION },
      { name: 'jp_screener', tool: createJpScreener(model), description: JP_SCREENER_DESCRIPTION },
    );
  }

  // J-Quants 日本株価ツール (if API key is configured)
  if (isJQuantsAvailable()) {
    tools.push(
      { name: 'jp_stock_price', tool: jpStockPrice, description: JP_STOCK_PRICE_DESCRIPTION },
    );
  }

  // === トレーディングツール（常時有効） ===
  tools.push(
    { name: 'portfolio_manager', tool: portfolioManager, description: PORTFOLIO_MANAGER_DESCRIPTION },
    { name: 'alert_manager', tool: alertManager, description: ALERT_MANAGER_DESCRIPTION },
    { name: 'send_notification', tool: sendNotification, description: SEND_NOTIFICATION_DESCRIPTION },
  );

  // Include skill tool if any skills are available
  const availableSkills = discoverSkills();
  if (availableSkills.length > 0) {
    tools.push({
      name: 'skill',
      tool: skillTool,
      description: SKILL_TOOL_DESCRIPTION,
    });
  }

  return tools;
}

/**
 * Get just the tool instances for binding to the LLM.
 *
 * @param model - The model name
 * @returns Array of tool instances
 */
export function getTools(model: string): StructuredToolInterface[] {
  return getToolRegistry(model).map((t) => t.tool);
}

/**
 * Build the tool descriptions section for the system prompt.
 * Formats each tool's rich description with a header.
 *
 * @param model - The model name
 * @returns Formatted string with all tool descriptions
 */
export function buildToolDescriptions(model: string): string {
  return getToolRegistry(model)
    .map((t) => `### ${t.name}\n\n${t.description}`)
    .join('\n\n');
}
