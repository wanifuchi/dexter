/**
 * Vercel Cron Job — /api/cron/news-alerts
 * 保有銘柄+ウォッチリストのニュースを分類し、通知に値するものだけをLINEに送る。
 *
 * - 分類と主題銘柄の判定は news/classify.ts（見出し・取得できた本文に基づく）
 * - 日本語化は news/translate.ts（数値・断定の強さを検証し、通らなければ原題のみ）
 * - 重複防止は news/sent-store.ts（LINE APIが受け付けた記事だけを送信済みにする）
 *
 * ?dryRun=1 で、LINE送信・送信済み記録を行わずに判定結果だけを返す。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadPortfolio } from '../tools/trading/portfolio-store.js';
import { loadWatchlist } from '../tools/trading/watchlist-store.js';
import { sendMessagesLine, isLineAvailable } from '../gateway/channels/line/index.js';
import type { LinePushResult } from '../gateway/channels/line/index.js';
import { extractReadableContent } from '../tools/fetch/web-fetch-utils.js';
import {
  aliasesFromName,
  assessArticle,
  classifyArticle,
  NOTIFY_CATEGORIES,
  notifyTargetsOf,
  underlyingTickerFromName,
} from './news/classify.js';
import type { ArticleAssessment, RawArticle, WatchedTicker } from './news/classify.js';
import { buildDigest, llmTranslator } from './news/translate.js';
import type { Translator } from './news/translate.js';
import { packMessages } from './news/format.js';
import type { AlertItem } from './news/format.js';
import { dedupeKeysOf, getSentStore, normalizeTitle } from './news/sent-store.js';
import type { SentStore } from './news/sent-store.js';

export const maxDuration = 60;

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const NEWS_PER_TICKER = 10;
const MAX_BODY_FETCHES = 12;
const MAX_ALERTS_PER_RUN = 8;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

export interface NewsAlertDeps {
  loadTickers(): Promise<Array<{ ticker: string; name?: string }>>;
  fetchCompanyName(ticker: string): Promise<string | undefined>;
  searchNews(ticker: string): Promise<RawArticle[]>;
  fetchBody(url: string): Promise<string | undefined>;
  translator: Translator | null;
  sentStore: SentStore;
  sendLine: ((texts: string[]) => Promise<LinePushResult>) | null;
  now(): number;
}

// ---------- 外部データ取得 ----------

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function fetchCompanyName(ticker: string): Promise<string | undefined> {
  const symbol = /^\d{4}$/.test(ticker) ? `${ticker}.T` : ticker;
  const json = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
  const meta = json?.chart?.result?.[0]?.meta;
  return meta?.longName ?? meta?.shortName ?? undefined;
}

async function searchNews(ticker: string): Promise<RawArticle[]> {
  const json = await fetchJson(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=${NEWS_PER_TICKER}&quotesCount=0`,
  );
  const news: any[] = json?.news ?? [];
  return news.map((n) => ({
    id: String(n.uuid ?? n.link ?? n.title),
    title: String(n.title ?? ''),
    publisher: String(n.publisher ?? ''),
    link: String(n.link ?? ''),
    publishedAt: new Date((n.providerPublishTime ?? 0) * 1000).toISOString(),
    relatedTickers: Array.isArray(n.relatedTickers) ? n.relatedTickers.map(String) : [],
    searchTickers: [ticker],
  }));
}

async function fetchBody(url: string): Promise<string | undefined> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
  if (!res.ok) return undefined;
  const html = await res.text();
  const extracted = await extractReadableContent({ html, url: res.url || url, extractMode: 'text' });
  return extracted?.text;
}

async function loadTickers(): Promise<Array<{ ticker: string; name?: string }>> {
  const [portfolio, watchlist] = await Promise.all([loadPortfolio(), loadWatchlist()]);
  const byTicker = new Map<string, string | undefined>();
  for (const item of [...portfolio.positions, ...watchlist.items]) {
    const name = item.name && item.name !== item.ticker ? item.name : undefined;
    byTicker.set(item.ticker, byTicker.get(item.ticker) ?? name);
  }
  return [...byTicker].map(([ticker, name]) => ({ ticker, name }));
}

export async function defaultDeps(): Promise<NewsAlertDeps> {
  return {
    loadTickers,
    fetchCompanyName,
    searchNews,
    fetchBody,
    translator: process.env.OPENAI_API_KEY ? llmTranslator : null,
    sentStore: await getSentStore(),
    sendLine: isLineAvailable() ? (texts) => sendMessagesLine({ texts }) : null,
    now: () => Date.now(),
  };
}

// ---------- 処理本体 ----------

async function settle<T>(promise: Promise<T>, errors: string[], label: string): Promise<T | undefined> {
  try {
    return await promise;
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export async function resolveWatchedTickers(
  items: Array<{ ticker: string; name?: string }>,
  fetchName: (ticker: string) => Promise<string | undefined>,
  errors: string[],
): Promise<WatchedTicker[]> {
  return Promise.all(items.map(async ({ ticker, name }) => {
    const resolvedName = name ?? await settle(fetchName(ticker), errors, `社名取得 ${ticker}`);
    const watched: WatchedTicker = { ticker, aliases: aliasesFromName(ticker, resolvedName) };
    const underlying = underlyingTickerFromName(resolvedName);
    if (underlying && underlying !== ticker) {
      const underlyingName = await settle(fetchName(underlying), errors, `社名取得 ${underlying}`);
      watched.underlying = { ticker: underlying, aliases: aliasesFromName(underlying, underlyingName) };
    }
    return watched;
  }));
}

function mergeArticles(lists: RawArticle[][], since: number): RawArticle[] {
  const byId = new Map<string, RawArticle>();
  const seenTitles = new Set<string>();
  for (const article of lists.flat()) {
    if (!article.title || new Date(article.publishedAt).getTime() <= since) continue;
    const existing = byId.get(article.id);
    if (existing) {
      existing.searchTickers = [...new Set([...existing.searchTickers, ...article.searchTickers])];
      continue;
    }
    const titleKey = normalizeTitle(article.title);
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);
    byId.set(article.id, { ...article });
  }
  return [...byId.values()];
}

/** 本文を読む価値がある記事（見出しで通知対象か、監視銘柄が関連に入っているもの） */
function needsBody(article: RawArticle, watched: WatchedTicker[]): number {
  const category = classifyArticle(article.title).category;
  if (NOTIFY_CATEGORIES.has(category)) return 2;
  if (category === 'opinion' || category === 'weekly_roundup') return 0;
  const related = new Set(article.relatedTickers);
  return watched.some((w) => related.has(w.ticker)) ? 1 : 0;
}

export interface NewsAlertReport {
  status: 'ok' | 'line_failed';
  dryRun: boolean;
  tickersChecked: number;
  articlesInWindow: number;
  alreadySent: number;
  bodiesFetched: number;
  dedupeAvailable: boolean;
  assessments: Array<{
    id: string; title: string; publisher: string; category: string; reason: string;
    bodyChecked: boolean; watched: Array<{ ticker: string; role: string; category?: string }>;
  }>;
  alerts: Array<{ id: string; title: string; targets: string[]; jaTitle: string | null; rejected: string[] }>;
  deferred: string[];
  line: { attempted: boolean; success?: boolean; status?: number; requestId?: string; error?: string; messages?: number };
  messages?: string[];
  errors: string[];
}

export async function runNewsAlerts(deps: NewsAlertDeps, opts: { dryRun?: boolean } = {}): Promise<NewsAlertReport> {
  const dryRun = Boolean(opts.dryRun);
  const errors: string[] = [];
  const items = await deps.loadTickers();
  const watched = await resolveWatchedTickers(items, deps.fetchCompanyName, errors);

  const lists = await Promise.all(items.map(({ ticker }) => settle(deps.searchNews(ticker), errors, `ニュース取得 ${ticker}`)));
  const articles = mergeArticles(lists.map((l) => l ?? []), deps.now() - LOOKBACK_MS);

  // 送信済みの記事は本文取得・翻訳もしない
  const fresh: RawArticle[] = [];
  let alreadySent = 0;
  for (const article of articles) {
    const taken = await settle(deps.sentStore.isTaken(dedupeKeysOf(article)), errors, '送信済み確認');
    if (taken) alreadySent++;
    else fresh.push(article);
  }

  const bodyTargets = fresh
    .map((a) => ({ a, priority: needsBody(a, watched) }))
    .filter((x) => x.priority > 0)
    .sort((x, y) => y.priority - x.priority)
    .slice(0, MAX_BODY_FETCHES);
  const bodies = new Map<string, string | undefined>();
  await Promise.all(bodyTargets.map(async ({ a }) => {
    bodies.set(a.id, await settle(deps.fetchBody(a.link), errors, `本文取得 ${a.link}`));
  }));

  const assessments: ArticleAssessment[] = fresh.map((a) => assessArticle(a, bodies.get(a.id), watched));
  const candidates = assessments
    .map((assessment) => ({ assessment, targets: notifyTargetsOf(assessment) }))
    .filter((c) => c.targets.length > 0)
    .sort((x, y) => y.assessment.article.publishedAt.localeCompare(x.assessment.article.publishedAt));
  const selected = candidates.slice(0, MAX_ALERTS_PER_RUN);
  const deferred = candidates.slice(MAX_ALERTS_PER_RUN).map((c) => c.assessment.article.id);

  const alertItems: AlertItem[] = await Promise.all(selected.map(async (c) => ({
    ...c,
    digest: await buildDigest({
      title: c.assessment.article.title,
      body: bodies.get(c.assessment.article.id),
      focus: c.targets.map((t) => t.ticker),
    }, deps.translator),
  })));

  const header = `📰 Finx ニュースアラート (${new Date(deps.now()).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`;
  const packed = packMessages(header, alertItems);
  deferred.push(...packed.deferredIds);

  const report: NewsAlertReport = {
    status: 'ok',
    dryRun,
    tickersChecked: items.length,
    articlesInWindow: articles.length,
    alreadySent,
    bodiesFetched: [...bodies.values()].filter(Boolean).length,
    dedupeAvailable: deps.sentStore.available,
    assessments: assessments.map((a) => ({
      id: a.article.id,
      title: a.article.title,
      publisher: a.article.publisher,
      category: a.classification.category,
      reason: a.classification.reason,
      bodyChecked: a.bodyChecked,
      watched: a.watched.map((w) => ({ ticker: w.ticker, role: w.role, category: w.classification?.category })),
    })),
    alerts: alertItems.map((i) => ({
      id: i.assessment.article.id,
      title: i.assessment.article.title,
      targets: i.targets.map((t) => `${t.ticker}:${t.classification.category}:${t.role}`),
      jaTitle: i.digest.jaTitle,
      rejected: i.digest.rejected,
    })),
    deferred,
    line: { attempted: false },
    errors,
  };

  if (dryRun) {
    report.messages = packed.messages;
    return report;
  }
  if (packed.messages.length === 0) return report;
  if (!deps.sendLine) {
    report.line = { attempted: false, error: 'LINEが未設定のため送信していません（送信済みにもしていません）' };
    return report;
  }

  return sendAndRecord(deps, alertItems, packed, report);
}

async function sendAndRecord(
  deps: NewsAlertDeps,
  alertItems: AlertItem[],
  packed: ReturnType<typeof packMessages>,
  report: NewsAlertReport,
): Promise<NewsAlertReport> {
  const included = alertItems.filter((i) => packed.includedIds.includes(i.assessment.article.id));
  const keys = included.flatMap((i) => dedupeKeysOf(i.assessment.article));

  // 並行実行による二重送信を防ぐため、送信前に予約する
  const claimed = await deps.sentStore.claim(keys);
  if (!claimed) {
    report.line = { attempted: false, error: '他の実行が同じ記事を送信中または送信済みのため送信しません' };
    return report;
  }

  const result = await deps.sendLine!(packed.messages);
  report.line = { attempted: true, messages: packed.messages.length, ...result };

  if (result.success) {
    await settle(deps.sentStore.markSent(keys), report.errors, '送信済み記録');
  } else {
    report.status = 'line_failed';
    await settle(deps.sentStore.release(keys), report.errors, '送信予約の解除');
  }
  return report;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
    const report = await runNewsAlerts(await defaultDeps(), { dryRun });
    // LINE送信に失敗した場合は、Actions側でも失敗として見えるよう 502 を返す
    return res.status(report.status === 'line_failed' ? 502 : 200).json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
}
