/**
 * ニュース記事の分類と主題銘柄の判定（純粋関数）
 *
 * 方針:
 * - 分類は見出しの「行為」(格上げした/評価を維持した/決算を発表した等)で決める。
 *   buy / sell / earnings といった単語の有無だけでは決めない。
 * - 判定できないものは断定せず 'unclassified'（分類未確認）にする。
 * - 主題銘柄は見出しで確認する。検索に使ったtickerや relatedTickers は主題の根拠にしない。
 *   本文にしか出てこない監視銘柄は「関連（本文で言及）」として区別する。
 */

export type NewsCategory =
  | 'rating_change'
  | 'rating_maintained'
  | 'price_target'
  | 'earnings_release'
  | 'earnings_preview'
  | 'opinion'
  | 'weekly_roundup'
  | 'company_release'
  | 'unclassified';

export type RatingDirection = 'up' | 'down';

export interface Classification {
  category: NewsCategory;
  direction?: RatingDirection;
  /** 判定の根拠（どの表現に一致したか） */
  reason: string;
}

/** 監視銘柄とその呼び名 */
export interface WatchedTicker {
  ticker: string;
  /** 見出し・本文で探す社名や通称（大文字小文字は区別しない） */
  aliases: string[];
  /** レバレッジETF等の原資産（例: MUU → MU） */
  underlying?: { ticker: string; aliases: string[] };
}

export interface RawArticle {
  id: string;
  title: string;
  publisher: string;
  link: string;
  publishedAt: string;
  /** Yahoo検索の relatedTickers（参考情報。主題の根拠にはしない） */
  relatedTickers: string[];
  /** どの監視tickerの検索で取得したか（参考情報。主題の根拠にはしない） */
  searchTickers: string[];
}

export type MentionRole = 'subject' | 'mentioned';

export interface WatchedMention {
  ticker: string;
  role: MentionRole;
  /** 原資産経由の一致（例: MUU保有でMicronの記事） */
  viaUnderlying?: string;
  /** この銘柄について本文の該当文から判定した分類（本文言及のみの場合） */
  classification?: Classification;
  /** 判定に使った本文の文 */
  evidence?: string;
}

export interface ArticleAssessment {
  article: RawArticle;
  classification: Classification;
  bodyChecked: boolean;
  /** 企業自身の発表文（プレスリリース配信）で、発表元が見出しの主題である */
  isPrimarySource: boolean;
  /** 見出し・本文から読み取れた主題企業（監視外を含む表示用） */
  subjectNames: string[];
  watched: WatchedMention[];
}

export const CATEGORY_LABELS: Record<NewsCategory, string> = {
  rating_change: '格上げ・格下げ',
  rating_maintained: '評価据え置き',
  price_target: '目標株価変更',
  earnings_release: '決算発表',
  earnings_preview: '決算予告',
  opinion: '解説・意見',
  weekly_roundup: '週間まとめ',
  company_release: '企業発表',
  unclassified: '分類未確認',
};

/** LINEに通知する分類（解説・まとめ・未確認は通知しない） */
export const NOTIFY_CATEGORIES: ReadonlySet<NewsCategory> = new Set<NewsCategory>([
  'rating_change',
  'rating_maintained',
  'price_target',
  'earnings_release',
  'earnings_preview',
  'company_release',
]);

/** 企業の発表文を配信するプレスリリース配信社（記事ではなく一次資料） */
const PRESS_RELEASE_PUBLISHERS_RE =
  /^(?:business wire|globenewswire|globe newswire|pr newswire|prnewswire|accesswire|access newswire|newsfile|cision|tdnet)\b/i;

export function isPressReleasePublisher(publisher: string): boolean {
  return PRESS_RELEASE_PUBLISHERS_RE.test(publisher.trim());
}

const RATING_WORDS =
  '(?:strong buy|buy|outperform|overweight|accumulate|add|positive|neutral|hold|equal[- ]weight|' +
  'market perform|sector perform|in[- ]line|peer perform|sell|underperform|underweight|reduce|negative)';

const RATING_UP_RE = new RegExp(
  `\\b(?:upgrades?|upgraded|upgrading)\\b|\\b(?:raises?|raised|lifts?|lifted|moves?|moved|bumps?|bumped)\\b[^.?!]{0,60}\\bto (?:strong buy|buy|outperform|overweight)\\b`,
  'i',
);
const RATING_DOWN_RE = new RegExp(
  `\\b(?:downgrades?|downgraded|downgrading)\\b|\\b(?:cuts?|lowers?|lowered|moves?|moved)\\b[^.?!]{0,60}\\bto (?:sell|underperform|underweight|neutral|hold|equal[- ]weight|market perform)\\b`,
  'i',
);
const RATING_MAINTAINED_RE = new RegExp(
  `\\b(?:keeps?|kept|maintains?|maintained|reiterates?|reiterated|retains?|retained|affirms?|affirmed|reaffirms?|reaffirmed|stays? at|sticks? with)\\b[^.?!]{0,60}\\b${RATING_WORDS}\\b`,
  'i',
);
const PRICE_TARGET_CHANGE_RE =
  /\b(?:raises?|raised|lifts?|lifted|boosts?|boosted|hikes?|hiked|ups|cuts?|lowers?|lowered|trims?|trimmed|slashes|slashed|reduces?|reduced|adjusts?|adjusted|revises?|revised|changes?|changed|updates?|updated)\b[^.?!]{0,50}\b(?:price target|target price|pt|price objective)\b|\b(?:price target|target price|pt)\b[^.?!]{0,20}\b(?:raised|lifted|boosted|cut|lowered|trimmed|slashed)\b|\bprice target (?:to|from) \$/i;
const PRICE_TARGET_UNCHANGED_RE =
  /\btargets?\b[^.?!]{0,80}\b(?:not changed|unchanged|were not changed|was not changed|no change)\b/i;

// "Weekly Loss" のような単なる語ではなく、まとめ記事の体裁（"Weekly:" 等）で判定する
const WEEKLY_TITLE_RE =
  /\bweekly\s*:|\bweekly (?:roundup|round-up|recap|wrap|review|digest|update|briefing|report)\b|\bthis week in\b|\bweek in review\b|\bweek ahead\b|\bweek'?s top\b/i;
const ROUNDUP_TITLE_RE = /\b(?:roundup|round-up|recap|wrap)\b/i;
const WEEK_BODY_RE = /\bthis week\b|\bin the week\b|\bover the past week\b|\bweekly\b/i;

const MARKET_WRAP_RE =
  /\b(?:futures|premarket movers|stocks to watch|stocks in focus|stocks moving|movers|most active|market (?:wrap|recap)|social buzz|what'?s moving|wall street wrap)\b/i;

const PREVIEW_RE =
  /\b(?:schedules?|scheduled|to (?:report|release|announce|host)|will (?:report|release|announce|host)|sets? (?:the )?date|announces? (?:the )?(?:publication |release |reporting )?date|publication date|conference call|earnings (?:preview|date|call)|ahead of (?:its |their |the )?(?:q[1-4] |quarterly )?(?:earnings|results)|what to expect|earnings preview)\b/i;
const RESULTS_WORD_RE = /\b(?:results|earnings|financial results)\b|決算/i;

const RELEASE_VERB_RE =
  /\b(?:reports?|reported|posts?|posted|announces?|announced|delivers?|delivered|beats?|tops?|topped|misses?|missed)\b/i;
const PERIOD_RE =
  /\b(?:q[1-4]|first[- ]quarter|second[- ]quarter|third[- ]quarter|fourth[- ]quarter|quarterly|fiscal(?: year)?|full[- ]year|annual|first[- ]half|nine[- ]months?)\b/i;
const FINANCIAL_WORD_RE = /\b(?:results?|earnings|revenue|sales|profit|loss|eps)\b/i;
const EARNINGS_BEAT_RE = /\b(?:earnings|eps|revenue)\b[^.?!]{0,30}\b(?:beat|beats|miss|misses|top|tops|topped)\b|\b(?:beat|beats|miss|misses|tops|topped)\b[^.?!]{0,40}\b(?:estimates|expectations|consensus)\b/i;

const OPINION_TITLE_RE =
  /\?|^\s*(?:prediction|forget|opinion|analysis)\b|\bbetter (?:\w+ )?stock\b|\bhere'?s (?:why|what|how)\b|\bhere are\b|\bwhy i\b|\bi'?d buy\b|\bi'?m buying\b|\bshould you\b|\bworth buying\b|\bbuy[- ]the[- ]dip\b|\bundervalued\b|\bovervalued\b|\bfair value\b|\bfully priced\b|\bat a discount\b|\bcould be\b|\bmay be\b|\bmight be\b|\bgame changer\b|\bbig moment\b|\bstill has room\b|\bcase for\b|\b\d+ (?:reasons|stocks|things)\b|\bvs\.? /i;

const JP_RATING_UP_RE = /格上げ/;
const JP_RATING_DOWN_RE = /格下げ/;
const JP_EARNINGS_RELEASE_RE = /決算(?:を)?発表|決算短信|業績(?:を)?発表/;
const JP_PREVIEW_RE = /決算発表(?:予定|日)|決算説明会/;

function ratingChangeOf(text: string): Classification | null {
  const up = RATING_UP_RE.exec(text);
  const down = RATING_DOWN_RE.exec(text);
  if (!up && !down && !JP_RATING_UP_RE.test(text) && !JP_RATING_DOWN_RE.test(text)) return null;
  // 両方ある見出し（例: "Adobe downgraded, VF Corp. upgraded"）は方向を断定しない
  const isUp = Boolean(up) || JP_RATING_UP_RE.test(text);
  const isDown = Boolean(down) || JP_RATING_DOWN_RE.test(text);
  const direction = isUp && !isDown ? 'up' : isDown && !isUp ? 'down' : undefined;
  return { category: 'rating_change', direction, reason: `レーティング変更の表現: "${(up ?? down)?.[0] ?? '格上げ/格下げ'}"` };
}

const PT_UP_RE = /\b(?:raises?|raised|lifts?|lifted|boosts?|boosted|hikes?|hiked|ups)\b/i;
const PT_DOWN_RE = /\b(?:cuts?|lowers?|lowered|trims?|trimmed|slashes|slashed|reduces?|reduced)\b/i;
const PT_FROM_TO_RE = /\bto \$([\d,]+(?:\.\d+)?) from \$([\d,]+(?:\.\d+)?)/i;

/** 目標株価の向き。"to $369 From $283" の数値、または動詞から判定。どちらも無ければ断定しない */
function priceTargetDirection(text: string): RatingDirection | undefined {
  const m = PT_FROM_TO_RE.exec(text);
  if (m) {
    const to = Number(m[1]!.replace(/,/g, ''));
    const from = Number(m[2]!.replace(/,/g, ''));
    if (to > from) return 'up';
    if (to < from) return 'down';
    return undefined;
  }
  const up = PT_UP_RE.test(text);
  const down = PT_DOWN_RE.test(text);
  return up && !down ? 'up' : down && !up ? 'down' : undefined;
}

/**
 * アナリスト行動（格上げ/据え置き/目標株価）を1つの文から判定する。
 * 本文中の該当文や、見出しの判定で使う。
 */
export function classifyAnalystAction(text: string): Classification | null {
  const change = ratingChangeOf(text);
  if (change) return change;

  const maintained = RATING_MAINTAINED_RE.exec(text);
  const ptChange = PRICE_TARGET_CHANGE_RE.exec(text);
  if (ptChange) {
    return { category: 'price_target', direction: priceTargetDirection(text), reason: `目標株価変更の表現: "${ptChange[0]}"` };
  }
  if (maintained) {
    return { category: 'rating_maintained', reason: `評価維持の表現: "${maintained[0]}"` };
  }
  return null;
}

function classifyEarnings(title: string): Classification | null {
  if (!RESULTS_WORD_RE.test(title) && !FINANCIAL_WORD_RE.test(title)) return null;

  if ((PREVIEW_RE.test(title) && RESULTS_WORD_RE.test(title)) || JP_PREVIEW_RE.test(title)) {
    return { category: 'earnings_preview', reason: '決算日程・説明会の告知' };
  }
  if (JP_EARNINGS_RELEASE_RE.test(title)) {
    return { category: 'earnings_release', reason: '決算発表の表現' };
  }
  if (EARNINGS_BEAT_RE.test(title)) {
    return { category: 'earnings_release', reason: '決算の予想比較（beat/miss）' };
  }
  // 「報告した」動詞 + 期間 + 財務項目 がそろったときだけ決算発表とみなす。
  // "Revenue Trends" や "186x Earnings" のような単語だけの一致は除外される。
  if (RELEASE_VERB_RE.test(title) && PERIOD_RE.test(title) && FINANCIAL_WORD_RE.test(title)) {
    return { category: 'earnings_release', reason: '期間を伴う決算報告の表現' };
  }
  return null;
}

/**
 * 見出し（＋取得できた本文）から記事の分類を決める。
 * 優先順: 週間まとめ → 疑問形 → 市況まとめ → アナリスト行動 → 意見表現 → 決算 → 未確認
 */
export function classifyArticle(title: string, body?: string): Classification {
  if (WEEKLY_TITLE_RE.test(title)) {
    return { category: 'weekly_roundup', reason: '見出しが週次まとめ' };
  }
  if (ROUNDUP_TITLE_RE.test(title) && body && WEEK_BODY_RE.test(body.slice(0, 1500))) {
    return { category: 'weekly_roundup', reason: '見出しがまとめ記事で、本文が週間の動きを扱う' };
  }
  if (title.includes('?') || title.includes('？')) {
    return { category: 'opinion', reason: '見出しが疑問形（筆者の問いかけ）' };
  }
  if (MARKET_WRAP_RE.test(title) || ROUNDUP_TITLE_RE.test(title)) {
    return { category: 'unclassified', reason: '複数銘柄の市況まとめで、個別の行為を特定できない' };
  }

  const action = classifyAnalystAction(title);
  if (action) return refineWithBody(action, body);

  if (OPINION_TITLE_RE.test(title)) {
    return { category: 'opinion', reason: '見出しが比較・予想・筆者の見解の形式' };
  }

  const earnings = classifyEarnings(title);
  if (earnings) return earnings;

  return { category: 'unclassified', reason: '見出しから分類を特定できない' };
}

/** 本文で「目標株価は変更なし」と確認できたら、目標株価変更とは言わない */
function refineWithBody(c: Classification, body?: string): Classification {
  if (!body) return c;
  if (c.category === 'price_target' && PRICE_TARGET_UNCHANGED_RE.test(body)) {
    return { category: 'rating_maintained', reason: `${c.reason}／本文で目標株価は変更なしと記載` };
  }
  return c;
}

// ---------- 主題・関連銘柄 ----------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasRegex(alias: string): RegExp {
  // 社名は大文字小文字を区別しない。tickerは誤一致を避けるため大文字のみ一致させる。
  const isTicker = /^[A-Z0-9.]{1,6}$/.test(alias);
  const pattern = `(?<![A-Za-z0-9])${escapeRegExp(alias)}(?![A-Za-z0-9])`;
  return new RegExp(pattern, isTicker ? '' : 'i');
}

function containsAny(text: string, aliases: string[]): boolean {
  return aliases.some((a) => a && aliasRegex(a).test(text));
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 本文から "Cipher (NASDAQ: CIFR)" 形式の社名とtickerの対応を取り出す。
 */
export function extractNamedTickers(body: string): Array<{ name: string; ticker: string }> {
  const re = /([A-Z][A-Za-z0-9&'.-]*(?: [A-Z][A-Za-z0-9&'.-]*){0,4}) \((?:NASDAQ|NYSE|NYSEMKT|NYSE American|AMEX|OTC|TSE)\s*:\s*([A-Z.]{1,6})\)/g;
  const out: Array<{ name: string; ticker: string }> = [];
  for (const m of body.matchAll(re)) out.push({ name: m[1]!, ticker: m[2]! });
  return out;
}

function subjectNamesOf(title: string, body: string | undefined, watched: WatchedMention[], tickers: WatchedTicker[]): string[] {
  const names: string[] = [];
  const add = (n: string) => { if (!names.includes(n)) names.push(n); };

  for (const m of watched) {
    if (m.role === 'subject') add(m.viaUnderlying ? `${m.viaUnderlying}（${m.ticker}の原資産）` : m.ticker);
  }
  if (body) {
    for (const { name, ticker } of extractNamedTickers(body)) {
      const first = name.split(' ')[0]!;
      if (aliasRegex(first).test(title) || aliasRegex(ticker).test(title)) {
        if (!tickers.some((t) => t.ticker === ticker)) add(`${name}(${ticker})`);
      }
    }
  }
  return names;
}

/**
 * 監視銘柄ごとに、見出しの主題か・本文での言及のみか・無関係かを判定する。
 */
export function findWatchedMentions(title: string, body: string | undefined, tickers: WatchedTicker[]): WatchedMention[] {
  const mentions: WatchedMention[] = [];
  for (const t of tickers) {
    const own = [t.ticker, ...t.aliases];
    const viaUnderlying = t.underlying && containsAny(title, [t.underlying.ticker, ...t.underlying.aliases]) ? t.underlying.ticker : undefined;
    if (containsAny(title, own) || viaUnderlying) {
      mentions.push({ ticker: t.ticker, role: 'subject', viaUnderlying: containsAny(title, own) ? undefined : viaUnderlying });
      continue;
    }
    if (!body) continue;

    const sentences = splitSentences(body).filter((s) => containsAny(s, own));
    if (sentences.length === 0) continue;
    // その銘柄名を含む文に、アナリスト行動が書かれているかを確認する
    const actionSentence = sentences.find((s) => classifyAnalystAction(s));
    if (actionSentence) {
      const c = refineWithBody(classifyAnalystAction(actionSentence)!, body);
      mentions.push({ ticker: t.ticker, role: 'mentioned', classification: c, evidence: actionSentence });
    } else {
      mentions.push({ ticker: t.ticker, role: 'mentioned', evidence: sentences[0] });
    }
  }
  return mentions;
}

/** 有料記事の購読案内など、記事本文ではないページの目印 */
const PAYWALL_RE =
  /\bupgrade to read\b|subscription (?:plan )?is required|\bsubscribe to (?:continue|read|unlock)\b|\balready a subscriber\b|\bsign in to (?:read|continue)\b|\bthis (?:article|content) is (?:for|available to) (?:subscribers|premium)|\bto continue reading\b|\bpremium news articles\b/i;
const MIN_BODY_CHARS = 200;

/**
 * 取得した本文が分類・要約に使えるものか判定する。
 * 有料記事の案内文や短すぎるものは「本文なし（見出しのみ確認）」として扱う。
 */
export function usableBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const text = body.trim();
  if (text.length < MIN_BODY_CHARS || PAYWALL_RE.test(text)) return undefined;
  return text;
}

export function assessArticle(article: RawArticle, body: string | undefined, tickers: WatchedTicker[]): ArticleAssessment {
  const bodyText = usableBody(body);
  const watched = findWatchedMentions(article.title, bodyText, tickers);
  // 配信社経由の発表文でも、発表元が監視銘柄（見出しの主題）でなければ一次資料とは扱わない
  const isPrimarySource = isPressReleasePublisher(article.publisher) && watched.some((w) => w.role === 'subject' && !w.viaUnderlying);
  let classification = classifyArticle(article.title, bodyText);
  if (isPrimarySource && (classification.category === 'unclassified' || classification.category === 'opinion')) {
    classification = { category: 'company_release', reason: `企業の発表文（${article.publisher}配信）` };
  }
  return {
    article,
    classification,
    bodyChecked: Boolean(bodyText),
    isPrimarySource,
    subjectNames: subjectNamesOf(article.title, bodyText, watched, tickers),
    watched,
  };
}

export interface NotifyTarget {
  ticker: string;
  role: MentionRole;
  viaUnderlying?: string;
  classification: Classification;
}

/**
 * 通知対象（監視銘柄 × 分類）を決める。
 * - 見出しの主題: 記事の分類が通知対象のとき
 * - 本文の言及のみ: その銘柄を含む文でアナリスト行動が確認できたとき
 * 決算系は見出しの主題であることを必須にする（他社の決算記事への言及で通知しない）。
 */
export function notifyTargetsOf(a: ArticleAssessment): NotifyTarget[] {
  const targets: NotifyTarget[] = [];
  for (const m of a.watched) {
    if (m.role === 'subject' && NOTIFY_CATEGORIES.has(a.classification.category)) {
      targets.push({ ticker: m.ticker, role: 'subject', viaUnderlying: m.viaUnderlying, classification: a.classification });
    } else if (m.role === 'mentioned' && m.classification && a.classification.category !== 'opinion' && a.classification.category !== 'weekly_roundup') {
      targets.push({ ticker: m.ticker, role: 'mentioned', classification: m.classification });
    }
  }
  return targets;
}

// ---------- 社名の別名 ----------

const NAME_SUFFIX_RE =
  /[,.]?\s+(?:inc\.?|incorporated|corporation|corp\.?|co\.?|company|ltd\.?|limited|plc|n\.v\.?|s\.a\.?|ag|se|holdings?|group|technologies|technology|shares|etf|class [a-z])\.?$/i;

/** よく使われる通称（社名から機械的に作れないもの） */
const ALIAS_OVERRIDES: Record<string, string[]> = {
  SPCX: ['SpaceX'],
  NVDA: ['Nvidia'],
  GOOG: ['Google', 'Alphabet'],
  GOOGL: ['Google', 'Alphabet'],
  META: ['Meta Platforms'],
};

export function aliasesFromName(ticker: string, name: string | undefined): string[] {
  const aliases = new Set<string>(ALIAS_OVERRIDES[ticker] ?? []);
  if (name && name !== ticker) {
    let core = name.trim();
    for (let i = 0; i < 3; i++) core = core.replace(NAME_SUFFIX_RE, '').trim();
    if (core.length >= 3) aliases.add(core);
  }
  return [...aliases];
}

/** "Direxion Daily MU Bull 2X Shares" のようなレバレッジETFから原資産tickerを取り出す */
export function underlyingTickerFromName(name: string | undefined): string | undefined {
  const m = name?.match(/\bDaily ([A-Z]{1,5}) (?:Bull|Bear)\b/);
  return m?.[1];
}

// ---------- 同じ出来事の判定 ----------

const ANALYST_VERB_RE =
  /^(?:just |analyst [A-Z][a-z]+ [A-Z][a-z]+ )?(?:upgrades?|upgraded|downgrades?|downgraded|raises?|raised|lifts?|lifted|cuts?|lowers?|lowered|trims?|trimmed|boosts?|boosted|maintains?|maintained|keeps?|kept|reiterates?|reiterated|initiates?|initiated)\b/i;
const BROKER_TRAILING_RE =
  /\b(?:[Aa]fter|[Aa]s|[Bb]y|[Ff]rom|[Ff]ollowing|[Tt]riggers?|[Oo]n)\s+([A-Z][\w&.'-]*(?:\s+[A-Z&][\w&.'-]*){0,3}?)\s+(?:[Uu]pgrade|[Dd]owngrade|[Pp]rice [Tt]arget|[Rr]ating)s?\b/;
const NOT_BROKER_RE = /^(?:the|this|wall street|analysts?|stocks?|shares|he|she|they|it)$/i;

/** 見出し・文からアナリスト（証券会社）名を取り出す。取り出せなければ undefined */
export function extractBroker(text: string): string | undefined {
  const words = text.trim().split(/\s+/);
  // 先頭の大文字語1〜4個 + アナリスト行動の動詞（例: "Piper Sandler Downgrades ..."）
  for (let n = 1; n <= 4 && n < words.length; n++) {
    if (!/^[A-Z&]/.test(words[n - 1]!)) break;
    const name = words.slice(0, n).join(' ');
    if (ANALYST_VERB_RE.test(words.slice(n).join(' ')) && !NOT_BROKER_RE.test(name)) return name.toLowerCase();
  }
  // "... After Piper Sandler Downgrade" 形式
  const m = BROKER_TRAILING_RE.exec(text);
  const name = m?.[1]?.trim();
  return name && !NOT_BROKER_RE.test(name) ? name.toLowerCase() : undefined;
}

function jstDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().slice(0, 10);
}

/**
 * 通知先ごとの「出来事」キー。別媒体が同じ出来事を報じた記事を1件にまとめ、
 * 実行をまたいだ再通知も防ぐ。アナリスト行動は証券会社名まで含めて区別する。
 */
export function eventKeysOf(a: ArticleAssessment, targets: NotifyTarget[]): string[] {
  const date = jstDate(a.article.publishedAt);
  return targets.map((t) => {
    const c = t.classification;
    const isAnalyst = c.category === 'rating_change' || c.category === 'rating_maintained' || c.category === 'price_target';
    const evidence = t.role === 'mentioned' ? a.watched.find((w) => w.ticker === t.ticker)?.evidence : undefined;
    const broker = isAnalyst ? (extractBroker(a.article.title) ?? (evidence ? extractBroker(evidence) : undefined) ?? '-') : '';
    // 企業発表は発表ごとに別の出来事として扱う（見出しで区別）
    const detail = c.category === 'company_release' ? a.article.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : broker;
    return `event:${t.ticker}:${c.category}:${c.direction ?? '-'}:${detail}:${date}`;
  });
}
