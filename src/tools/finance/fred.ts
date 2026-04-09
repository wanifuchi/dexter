/**
 * FRED 経済指標ツール — Federal Reserve Economic Data
 *
 * 米国経済統計（CPI/GDP/失業率/金利等）を取得。
 * 利下げ判断、リセッション予測、マクロ分析に使用。
 *
 * APIキー: FRED_API_KEY 環境変数から読み込み
 * 取得方法: https://fred.stlouisfed.org/docs/api/api_key.html （無料）
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const FRED_API = 'https://api.stlouisfed.org/fred/series/observations';

// よく使う経済指標のシリーズID + 説明
const COMMON_SERIES: Record<string, { id: string; label: string; unit: string }> = {
  // 金利
  fed_funds: { id: 'FEDFUNDS', label: 'Federal Funds Rate (実効FF金利)', unit: '%' },
  dgs10: { id: 'DGS10', label: '米国10年債利回り', unit: '%' },
  dgs2: { id: 'DGS2', label: '米国2年債利回り', unit: '%' },
  dgs30: { id: 'DGS30', label: '米国30年債利回り', unit: '%' },
  // インフレ
  cpi: { id: 'CPIAUCSL', label: 'CPI (消費者物価指数, all items)', unit: 'index' },
  core_cpi: { id: 'CPILFESL', label: 'Core CPI (食品・エネルギー除く)', unit: 'index' },
  pce: { id: 'PCEPI', label: 'PCE Price Index', unit: 'index' },
  core_pce: { id: 'PCEPILFE', label: 'Core PCE Price Index', unit: 'index' },
  // 雇用
  unemployment: { id: 'UNRATE', label: '失業率', unit: '%' },
  nonfarm: { id: 'PAYEMS', label: '非農業部門雇用者数', unit: 'thousands' },
  // GDP・経済活動
  gdp: { id: 'GDP', label: '名目GDP', unit: 'billions USD' },
  real_gdp: { id: 'GDPC1', label: '実質GDP (連鎖2017USD)', unit: 'billions' },
  // マネーサプライ
  m2: { id: 'M2SL', label: 'M2マネーサプライ', unit: 'billions USD' },
  // ボラティリティ・センチメント
  vix: { id: 'VIXCLS', label: 'VIX (恐怖指数)', unit: 'index' },
  // 為替
  usdjpy: { id: 'DEXJPUS', label: 'USD/JPY 為替レート', unit: 'JPY per USD' },
  // クレジット
  ted: { id: 'TEDRATE', label: 'TEDスプレッド', unit: '%' },
  // イールドカーブ
  t10y2y: { id: 'T10Y2Y', label: '10年-2年スプレッド', unit: '%' },
  t10y3m: { id: 'T10Y3M', label: '10年-3ヶ月スプレッド', unit: '%' },
};

interface FredObservation {
  date: string;
  value: string;
}

interface FredResponse {
  observations?: FredObservation[];
  error_code?: number;
  error_message?: string;
}

/**
 * クエリ文字列からシリーズIDを推定（曖昧マッチ）
 */
function resolveSeriesId(query: string): { id: string; label: string; unit: string } | null {
  const q = query.toLowerCase().trim();

  // 直接シリーズID指定（例: "DGS10", "CPIAUCSL"）
  if (/^[A-Z][A-Z0-9]+$/i.test(query)) {
    const upper = query.toUpperCase();
    const found = Object.values(COMMON_SERIES).find(s => s.id === upper);
    if (found) return found;
    return { id: upper, label: upper, unit: '' };
  }

  // エイリアス検索
  if (COMMON_SERIES[q]) return COMMON_SERIES[q];

  // 部分マッチ
  const aliases: Record<string, string> = {
    'ff': 'fed_funds', 'ff rate': 'fed_funds', 'ffrate': 'fed_funds', 'fed funds': 'fed_funds',
    '10年': 'dgs10', '10y': 'dgs10', '10-year': 'dgs10', '10 year': 'dgs10', '米10年': 'dgs10',
    '2年': 'dgs2', '2y': 'dgs2', '2-year': 'dgs2',
    '30年': 'dgs30', '30y': 'dgs30',
    'インフレ': 'cpi', 'inflation': 'cpi', '物価': 'cpi',
    'コアcpi': 'core_cpi', 'core cpi': 'core_cpi',
    'コアpce': 'core_pce', 'core pce': 'core_pce',
    '失業': 'unemployment', '失業率': 'unemployment', 'unemploy': 'unemployment',
    '雇用': 'nonfarm', '非農業': 'nonfarm', 'payroll': 'nonfarm',
    'マネーサプライ': 'm2',
    '恐怖指数': 'vix', 'volatility': 'vix',
    'ドル円': 'usdjpy', '為替': 'usdjpy',
    'イールドカーブ': 't10y2y', 'yield curve': 't10y2y', 'スプレッド': 't10y2y',
    'gdp成長': 'real_gdp', '実質gdp': 'real_gdp',
  };

  for (const [alias, key] of Object.entries(aliases)) {
    if (q.includes(alias)) return COMMON_SERIES[key];
  }

  return null;
}

async function fetchFredSeries(seriesId: string, limit: number = 12): Promise<FredObservation[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY is not configured');

  const url = `${FRED_API}?series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Finx/1.0' } });
  if (!res.ok) throw new Error(`FRED API error: ${res.status}`);

  const data = await res.json() as FredResponse;
  if (data.error_message) throw new Error(`FRED: ${data.error_message}`);
  return data.observations ?? [];
}

function formatObservations(obs: FredObservation[], unit: string): Array<{ date: string; value: number | null }> {
  return obs.map(o => ({
    date: o.date,
    value: o.value === '.' ? null : parseFloat(o.value),
  }));
}

function calculateChange(values: number[]): { latest: number; mom: number | null; yoy: number | null } | null {
  if (values.length === 0) return null;
  const latest = values[0];
  const monthAgo = values[1];
  const yearAgo = values[12];
  return {
    latest,
    mom: monthAgo != null ? ((latest - monthAgo) / monthAgo) * 100 : null,
    yoy: yearAgo != null ? ((latest - yearAgo) / yearAgo) * 100 : null,
  };
}

export const fredTool = new DynamicStructuredTool({
  name: 'fred_data',
  description: 'Fetch US economic indicators from FRED (Federal Reserve Economic Data). Use for: Fed Funds Rate, Treasury yields (2y/10y/30y), CPI, Core CPI, PCE, unemployment rate, GDP, M2, VIX, USD/JPY, yield curve spreads. Supports Japanese keywords like 利下げ/失業率/インフレ.',
  schema: z.object({
    series: z.string().describe('Series name or FRED ID. Examples: "fed_funds", "DGS10", "cpi", "unemployment", "10年債", "失業率", "CPIAUCSL"'),
    limit: z.number().optional().default(13).describe('Number of recent observations (default 13 = 1 year monthly)'),
  }),
  func: async (input) => {
    if (!process.env.FRED_API_KEY) {
      return formatToolResult({
        error: 'FRED_API_KEY is not configured. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html',
      });
    }

    const resolved = resolveSeriesId(input.series);
    if (!resolved) {
      return formatToolResult({
        error: `Unknown series: "${input.series}". Try: fed_funds, dgs10, cpi, unemployment, gdp, vix, etc.`,
        availableSeries: Object.keys(COMMON_SERIES),
      });
    }

    try {
      const obs = await fetchFredSeries(resolved.id, input.limit ?? 13);
      const formatted = formatObservations(obs, resolved.unit);
      const validValues = formatted.map(f => f.value).filter((v): v is number => v != null);
      const stats = calculateChange(validValues);

      return formatToolResult({
        series: {
          id: resolved.id,
          label: resolved.label,
          unit: resolved.unit,
        },
        latest: stats?.latest != null ? `${stats.latest.toFixed(3)} ${resolved.unit}` : 'N/A',
        change: {
          mom: stats?.mom != null ? `${stats.mom.toFixed(2)}%` : null,
          yoy: stats?.yoy != null ? `${stats.yoy.toFixed(2)}%` : null,
        },
        observations: formatted.slice(0, input.limit ?? 13),
        source: 'FRED (Federal Reserve Bank of St. Louis)',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return formatToolResult({ error: message });
    }
  },
});

export const FRED_DESCRIPTION = `Fetches US economic indicators from FRED (Federal Reserve Economic Data).
Use for macro analysis: Fed Funds Rate, Treasury yields, CPI/PCE inflation, unemployment, GDP, VIX.
Supports both English and Japanese keywords.
Examples: "Fed Funds Rate", "10年債利回り", "CPI inflation", "失業率", "DGS10", "yield curve"
Combine with prediction_market for full macro picture.`;
