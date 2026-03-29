/**
 * EDINET DB API クライアント - 日本株の財務データ
 * ベースURL: https://edinetdb.jp/v1
 * 認証: X-API-Key ヘッダー
 * 環境変数: EDINETDB_API_KEY
 */
import { logger } from '../../utils/logger.js';

const BASE_URL = 'https://edinetdb.jp/v1';

function getApiKey(): string {
  return process.env.EDINETDB_API_KEY || '';
}

export interface EdinetApiResponse {
  data: Record<string, unknown>;
  url: string;
}

async function executeRequest(
  url: string,
  label: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('[EDINET DB] EDINETDB_API_KEY not set. Get your key at https://edinetdb.jp');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'X-API-Key': apiKey,
        ...init.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[EDINET DB] network error: ${label} — ${message}`);
    throw new Error(`[EDINET DB] request failed for ${label}: ${message}`);
  }

  if (!response.ok) {
    const detail = `${response.status} ${response.statusText}`;
    logger.error(`[EDINET DB] error: ${label} — ${detail}`);
    throw new Error(`[EDINET DB] request failed: ${detail}`);
  }

  const data = await response.json().catch(() => {
    throw new Error(`[EDINET DB] invalid JSON response: ${label}`);
  });

  return data as Record<string, unknown>;
}

export const edinetApi = {
  async get(
    endpoint: string,
    params: Record<string, string | number | string[] | undefined>,
  ): Promise<EdinetApiResponse> {
    const url = new URL(`${BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          value.forEach((v) => url.searchParams.append(key, v));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const label = `GET ${endpoint}`;
    const data = await executeRequest(url.toString(), label, {});
    return { data, url: url.toString() };
  },
};

/**
 * 証券コード・企業名 → EDINETコードへの解決
 * インメモリキャッシュ付き
 */
const codeCache = new Map<string, string>();

export async function resolveEdinetCode(ticker: string): Promise<string> {
  const key = ticker.trim();

  // 既にEDINETコード形式（E + 5桁）
  if (/^E\d{5}$/.test(key)) return key;

  // キャッシュ確認
  if (codeCache.has(key)) return codeCache.get(key)!;

  // EDINET DB検索API
  const { data: responseData } = await edinetApi.get('/search', { q: key, limit: 1 });
  const companies = responseData.data as Array<{ edinet_code: string; name: string; sec_code: string }> | undefined;

  if (!companies || companies.length === 0) {
    throw new Error(`企業が見つかりません: ${ticker}`);
  }

  const edinetCode = companies[0].edinet_code;
  const secCode = companies[0].sec_code;

  // キャッシュに保存
  codeCache.set(key, edinetCode);
  if (secCode && secCode !== key) {
    codeCache.set(secCode, edinetCode);
  }

  logger.info(`[EDINET Resolver] ${ticker} → ${edinetCode} (${companies[0].name})`);
  return edinetCode;
}

/**
 * EDINET DB APIが利用可能か（キーが設定されているか）
 */
export function isEdinetAvailable(): boolean {
  return Boolean(process.env.EDINETDB_API_KEY);
}
