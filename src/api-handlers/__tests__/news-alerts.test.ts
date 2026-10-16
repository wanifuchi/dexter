import { describe, it, expect } from 'bun:test';
import {
  aliasesFromName,
  assessArticle,
  classifyArticle,
  eventKeysOf,
  extractBroker,
  notifyTargetsOf,
  underlyingTickerFromName,
} from '../news/classify.js';
import type { RawArticle, WatchedTicker } from '../news/classify.js';
import { extractNumbers, validateDigest, buildDigest } from '../news/translate.js';
import { formatAlertItem, packMessages, LINE_TEXT_LIMIT } from '../news/format.js';
import { createMemorySentStore } from '../news/sent-store.js';
import { runNewsAlerts } from '../news-alerts.js';
import type { NewsAlertDeps } from '../news-alerts.js';
import type { LinePushResult } from '../../gateway/channels/line/index.js';
import {
  AI_SELLOFF_ROUNDUP,
  JONESTRADING_KEEPS_BUY,
  MICRON_BUY_NOW,
  NEBIUS_REVENUE_TRENDS,
  SCHD_WORTH_BUYING,
  SEVEN_ARTICLES,
  SPACE_RACE_WEEKLY,
  TESLA_ROADSTER_186X,
  WATCHED_NAMES,
} from './fixtures/news-articles.js';

const WATCHED: WatchedTicker[] = WATCHED_NAMES.map(({ ticker, name }) => {
  const w: WatchedTicker = { ticker, aliases: aliasesFromName(ticker, name) };
  const underlying = underlyingTickerFromName(name);
  if (underlying) w.underlying = { ticker: underlying, aliases: aliasesFromName(underlying, 'Micron Technology, Inc.') };
  return w;
});

function assess(f: { article: RawArticle; body: string }, withBody = true) {
  return assessArticle(f.article, withBody ? f.body : undefined, WATCHED);
}

function rawArticle(title: string, overrides: Partial<RawArticle> = {}): RawArticle {
  return {
    id: title, title, publisher: 'Test Wire', link: 'https://example.com/a',
    publishedAt: '2026-10-16T09:00:00.000Z', relatedTickers: [], searchTickers: [], ...overrides,
  };
}

describe('回帰: 2026-10-16 に誤通知された7記事', () => {
  it('Micronの「買い時か？」はNVDAの格上げではなく解説・意見', () => {
    const a = assess(MICRON_BUY_NOW);
    expect(a.classification.category).toBe('opinion');
    expect(a.watched.find((w) => w.ticker === 'NVDA')?.role).not.toBe('subject');
    expect(notifyTargetsOf(a).map((t) => t.ticker)).not.toContain('NVDA');
  });

  it('SCHDの記事をNVDAのニュースにしない', () => {
    const a = assess(SCHD_WORTH_BUYING);
    expect(a.classification.category).toBe('opinion');
    expect(a.watched.some((w) => w.ticker === 'NVDA' && w.role === 'subject')).toBe(false);
    expect(notifyTargetsOf(a)).toHaveLength(0);
  });

  it('AI株売りの記事をApple格下げにしない（週間まとめ）', () => {
    const a = assess(AI_SELLOFF_ROUNDUP);
    expect(a.classification.category).toBe('weekly_roundup');
    expect(a.classification.category).not.toBe('rating_change');
    expect(notifyTargetsOf(a)).toHaveLength(0);
  });

  it('本文が無くてもAI株売りの見出しを格下げにしない', () => {
    const a = assess(AI_SELLOFF_ROUNDUP, false);
    expect(a.classification.category).toBe('unclassified');
    expect(notifyTargetsOf(a)).toHaveLength(0);
  });

  it('Tesla Roadsterの分析をSPCXの決算にしない', () => {
    const a = assess(TESLA_ROADSTER_186X);
    expect(a.classification.category).toBe('opinion');
    expect(a.watched.find((w) => w.ticker === 'SPCX')?.role).not.toBe('subject');
    expect(notifyTargetsOf(a)).toHaveLength(0);
  });

  it('宇宙株週報を格下げにしない', () => {
    const a = assess(SPACE_RACE_WEEKLY);
    expect(a.classification.category).toBe('weekly_roundup');
    expect(a.watched.find((w) => w.ticker === 'SPCX')?.role).toBe('subject');
    expect(notifyTargetsOf(a)).toHaveLength(0);
  });

  it('過去売上の比較を新しい決算発表にしない', () => {
    const a = assess(NEBIUS_REVENUE_TRENDS);
    expect(a.classification.category).toBe('opinion');
    expect(notifyTargetsOf(a)).toHaveLength(0);
  });

  it('JonesTradingのkeeps Buyを格上げにしない（評価据え置き・APLDは本文の関連銘柄）', () => {
    const a = assess(JONESTRADING_KEEPS_BUY);
    expect(a.classification.category).toBe('rating_maintained');
    const apld = a.watched.find((w) => w.ticker === 'APLD');
    expect(apld?.role).toBe('mentioned');
    expect(apld?.classification?.category).toBe('rating_maintained');
    expect(a.subjectNames).toEqual(expect.arrayContaining(['Cipher(CIFR)', 'CoreWeave(CRWV)']));
    const targets = notifyTargetsOf(a);
    expect(targets).toEqual([expect.objectContaining({ ticker: 'APLD', role: 'mentioned' })]);
    expect(targets[0]!.classification.category).toBe('rating_maintained');
  });

  it('7記事のどれも格上げ・格下げ・決算発表に分類しない', () => {
    for (const f of SEVEN_ARTICLES) {
      for (const withBody of [true, false]) {
        const c = assess(f, withBody).classification.category;
        expect(['rating_change', 'earnings_release']).not.toContain(c);
      }
    }
  });
});

describe('classifyArticle: 正しく通知すべき見出し', () => {
  it.each([
    ['Piper Sandler Downgrades AST SpaceMobile to Neutral From Outperform, $54 Price Target', 'rating_change', 'down'],
    ['Deutsche Bank Upgrades AST SpaceMobile to Buy With Massive Upside Potential', 'rating_change', 'up'],
    ['Piper Sandler Just Downgraded ASTS Stock. SpaceX May Be to Blame.', 'rating_change', 'down'],
    ['Morgan Stanley Raises Nvidia Price Target to $250, Keeps Overweight', 'price_target', 'up'],
    ['Arete Research Adjusts Price Target on Nvidia to $369 From $283', 'price_target', 'up'],
    ['Wedbush Adjusts Price Target on Applied Digital to $55 From $70, Maintains Outperform', 'price_target', 'down'],
    ['Barclays Cuts Apple Price Target', 'price_target', 'down'],
    ['Citi maintains Buy rating on Apple', 'rating_maintained', undefined],
    ['Solaris Energy Infrastructure Schedules Third Quarter 2026 Results Conference Call', 'earnings_preview', undefined],
    ['Technip Energies Announces Publication Date for the First Nine Months of 2026 Financial Results and Conference Call', 'earnings_preview', undefined],
    ['Nebius Reports Third Quarter 2026 Results', 'earnings_release', undefined],
    ['Apple Q4 earnings beat estimates as iPhone sales jump', 'earnings_release', undefined],
    ['アップル、7-9月期決算を発表', 'earnings_release', undefined],
    ['This Week In Electric Vehicles - Charging Market Surge', 'weekly_roundup', undefined],
    ['WULF Stock Set For Biggest Weekly Loss Of 2026, Morgan Stanley Says Shares Are ‘Mispriced’', 'unclassified', undefined],
    ['Better AI Stock: SpaceX vs. Nvidia', 'opinion', undefined],
    ['Prediction: A $10,000 Investment in This AI Hardware Stock Will At Least Double by 2030', 'opinion', undefined],
    ['Apple Insider Sold Shares Worth $827,655, According to a Recent SEC Filing', 'unclassified', undefined],
    ['ETFs Are Net Sellers of SpaceX (SPCX) on Oct. 14', 'unclassified', undefined],
    ['Rocket Lab Stocks Fall 10.9% as Neutron Delay Pushes Revenue Test Into 2027', 'unclassified', undefined],
    ['Premarket Movers: MU, ASTS, ADBE Slide As China Chip Threat And Analyst Downgrades Rattle Stocks', 'unclassified', undefined],
  ])('%s → %s', (title, category, direction) => {
    const c = classifyArticle(title);
    expect(c.category).toBe(category as string);
    if (direction) expect(c.direction).toBe(direction as 'up' | 'down');
  });

  it('見出しが目標株価変更でも、本文で変更なしと書かれていれば評価据え置き', () => {
    const c = classifyArticle('Analyst lifts price target on Foo', 'Analyst kept Buy. All targets were not changed.');
    expect(c.category).toBe('rating_maintained');
  });
});

describe('主題と関連銘柄の区別', () => {
  it('検索tickerやrelatedTickersだけでは主題にしない', () => {
    const a = assessArticle(
      rawArticle('Nebius Reports Third Quarter 2026 Results', { relatedTickers: ['NBIS', 'NVDA'], searchTickers: ['NVDA'] }),
      undefined,
      WATCHED,
    );
    expect(notifyTargetsOf(a).map((t) => t.ticker)).toEqual(['NBIS']);
  });

  it('決算記事で本文に名前が出るだけの銘柄には通知しない', () => {
    const body = 'Nebius posted record revenue in the third quarter. Customers include Nvidia and Apple, the company said.' + ' filler'.repeat(40);
    const a = assessArticle(rawArticle('Nebius Reports Third Quarter 2026 Results'), body, WATCHED);
    expect(notifyTargetsOf(a).map((t) => t.ticker)).toEqual(['NBIS']);
  });

  it('tickerの小文字一致や社名の一部一致で誤判定しない', () => {
    const a = assessArticle(rawArticle('Applied Materials raises guidance; the te of the market'), undefined, WATCHED);
    expect(a.watched.map((w) => w.ticker)).not.toContain('AAPL');
    expect(a.watched.map((w) => w.ticker)).not.toContain('TE');
  });

  it('レバレッジETFは原資産の記事を原資産経由の主題として扱う', () => {
    const a = assessArticle(rawArticle('Micron Reports Fourth Quarter Results'), undefined, WATCHED);
    const targets = notifyTargetsOf(a);
    expect(targets).toEqual([expect.objectContaining({ ticker: 'MUU', viaUnderlying: 'MU' })]);
  });
});

describe('翻訳の検証', () => {
  const input = { title: 'Micron Stock Is 25% Below Its June Record. Is It a Buy Now?', body: MICRON_BUY_NOW.body };

  it('数値と疑問形を保った訳は採用する', () => {
    const d = validateDigest({
      jaTitle: 'マイクロン株は6月の最高値を25%下回る。今が買い時か？',
      summary: '株価は$914.13で、6月25日の最高値$1,213.56から約25%下落。',
      reported: null, opinion: '筆者は下落はメモリ価格見通しによるものとみている。', forecast: null,
    }, input);
    expect(d.jaTitle).toBe('マイクロン株は6月の最高値を25%下回る。今が買い時か？');
    expect(d.summary).not.toBeNull();
    expect(d.rejected).toEqual([]);
  });

  it('見出しの数値を変えた訳は採用しない', () => {
    const d = validateDigest({ jaTitle: 'マイクロン株は最高値を30%下回る。買い時か？', summary: null, reported: null, opinion: null, forecast: null }, input);
    expect(d.jaTitle).toBeNull();
  });

  it('疑問形を断定に変えた訳は採用しない', () => {
    const d = validateDigest({ jaTitle: 'マイクロン株は最高値を25%下回り、買い推奨', summary: null, reported: null, opinion: null, forecast: null }, input);
    expect(d.jaTitle).toBeNull();
    expect(d.rejected.join()).toContain('断定');
  });

  it('原文に無い数値を含む要約は捨てる', () => {
    const d = validateDigest({ jaTitle: 'マイクロン株は25%下落。買い時か？', summary: '目標株価は$1,500。', reported: null, opinion: null, forecast: null }, input);
    expect(d.summary).toBeNull();
    expect(d.rejected.join()).toContain('1500');
  });

  it('翻訳に失敗しても内容を創作せず空にする', async () => {
    const d = await buildDigest(input, async () => { throw new Error('timeout'); });
    expect(d.jaTitle).toBeNull();
    expect(d.summary).toBeNull();
  });

  it('extractNumbers はカンマと末尾0を正規化する', () => {
    expect(extractNumbers('$1,213.56 と 25% と 2.50')).toEqual(['1213.56', '25', '2.5']);
  });
});

describe('一次資料と同じ出来事', () => {
  it('監視銘柄自身のプレスリリースは一次資料として企業発表に分類する', () => {
    const a = assessArticle(rawArticle('Solaris Energy Infrastructure Announces Pricing of Senior Notes Offering', { publisher: 'Business Wire' }), undefined, WATCHED);
    expect(a.isPrimarySource).toBe(true);
    expect(a.classification.category).toBe('company_release');
    expect(notifyTargetsOf(a).map((t) => t.ticker)).toEqual(['SEI']);
  });

  it('配信社経由でも発表元が監視銘柄でなければ一次資料にしない', () => {
    const a = assessArticle(rawArticle('Technip Energies awarded large EPC contract by HPCL', { publisher: 'GlobeNewswire', relatedTickers: ['TE'] }), undefined, WATCHED);
    expect(a.isPrimarySource).toBe(false);
    expect(notifyTargetsOf(a)).toHaveLength(0);
  });

  it('PR Newswireの他社まとめ記事は監視銘柄の発表にしない', () => {
    const a = assessArticle(rawArticle('15 Press Releases You Need to See This Week', { publisher: 'PR Newswire', relatedTickers: ['AAPL'] }), undefined, WATCHED);
    expect(notifyTargetsOf(a)).toHaveLength(0);
  });

  it.each([
    ['Piper Sandler Downgrades AST SpaceMobile to Neutral From Outperform', 'piper sandler'],
    ['AST SpaceMobile Shares Fall After Piper Sandler Downgrade', 'piper sandler'],
    ['AST SpaceMobile Shares Fall 5% as Piper Sandler Downgrades Stock', 'piper sandler'],
    ['Morgan Stanley Raises Nvidia Price Target to $250', 'morgan stanley'],
    ['He also kept Buy ratings on Applied Digital', undefined],
  ])('証券会社名: %s → %s', (title, broker) => {
    expect(extractBroker(title)).toBe(broker);
  });

  it('同じ証券会社の同じ行動を報じた別媒体の記事は同じ出来事', () => {
    const a = assessArticle(rawArticle('Piper Sandler Downgrades Nebius to Neutral', { publisher: 'MT Newswires' }), undefined, WATCHED);
    const b = assessArticle(rawArticle('Nebius Shares Fall After Piper Sandler Downgrade', { publisher: 'InvestorsHub' }), undefined, WATCHED);
    const c = assessArticle(rawArticle('Morgan Stanley Downgrades Nebius to Equal-Weight'), undefined, WATCHED);
    const keyA = eventKeysOf(a, notifyTargetsOf(a));
    expect(eventKeysOf(b, notifyTargetsOf(b))).toEqual(keyA);
    expect(eventKeysOf(c, notifyTargetsOf(c))).not.toEqual(keyA);
  });
});

describe('有料記事の案内文', () => {
  const paywall = 'PREMIUM MT Newswires Fri, October 16, 2026 at 6:28 PM GMT+9 NVDA -1.84% Nvidia (NVDA) has an average rating of buy and mean price target of $334.45, according to analysts p PREMIUM Upgrade to read this MT Newswires article and get so much more. A Silver or Gold subscription plan is required to access premium news articles. Upgrade Already have a subscription? Sign in';

  it('購読案内は本文として扱わず「見出しのみ確認」にする', () => {
    const a = assessArticle(rawArticle('Arete Research Adjusts Price Target on Nvidia to $369 From $283', { publisher: 'MT Newswires' }), paywall, WATCHED);
    expect(a.bodyChecked).toBe(false);
    expect(a.classification).toMatchObject({ category: 'price_target', direction: 'up' });
  });

  it('購読案内の "Upgrade" を本文言及銘柄の格上げにしない', () => {
    const a = assessArticle(rawArticle('Chip stocks slide on rate fears', { publisher: 'MT Newswires' }), paywall, WATCHED);
    expect(a.watched).toHaveLength(0);
    expect(notifyTargetsOf(a)).toHaveLength(0);
  });
});

describe('LINE文面', () => {
  const a = assessArticle(JONESTRADING_KEEPS_BUY.article, JONESTRADING_KEEPS_BUY.body, WATCHED);
  const item = {
    assessment: a,
    targets: notifyTargetsOf(a),
    eventKeys: [],
    corroborating: [],
    digest: { jaTitle: null, summary: null, reported: null, opinion: null, forecast: null, rejected: [] },
  };

  it('分類・対象銘柄・媒体・公開日時・URL・確認範囲を含む', () => {
    const text = formatAlertItem(item);
    expect(text).toContain('【評価据え置き】APLD');
    expect(text).toContain('APLD：評価据え置き／関連（本文で言及）');
    expect(text).toContain('記事の主題: Cipher(CIFR), CoreWeave(CRWV)');
    expect(text).toContain('媒体: Blockspace');
    expect(text).toContain('公開: 2026/10/16 03:57 JST');
    expect(text).toContain('確認範囲: 見出し＋本文（取得できた範囲）');
    expect(text).toContain('（翻訳未確認：原題のみ表示）');
    expect(text).toContain('・一次資料: 未確認');
    expect(text).toContain(JONESTRADING_KEEPS_BUY.article.link);
    expect(text).not.toContain('格上げ');
  });

  it('本文未取得なら「見出しのみ確認」と明記する', () => {
    const noBody = assessArticle(rawArticle('Nebius Reports Third Quarter 2026 Results'), undefined, WATCHED);
    const text = formatAlertItem({ ...item, assessment: noBody, targets: notifyTargetsOf(noBody) });
    expect(text).toContain('確認範囲: 見出しのみ確認');
  });

  it('上限を超える分は切り詰めずに次回へ回す', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...item,
      assessment: { ...a, article: { ...a.article, id: `id-${i}` } },
      digest: { ...item.digest, summary: 'あ'.repeat(800) },
    }));
    const packed = packMessages('header', many);
    expect(packed.messages.length).toBeLessThanOrEqual(5);
    expect(packed.messages.every((m) => m.length <= LINE_TEXT_LIMIT)).toBe(true);
    expect(packed.includedIds.length + packed.deferredIds.length).toBe(40);
    expect(packed.deferredIds.length).toBeGreaterThan(0);
  });
});

describe('runNewsAlerts: 重複防止と送信結果の扱い', () => {
  const NOW = Date.parse('2026-10-16T12:00:00.000Z');
  const preview = rawArticle('Solaris Energy Infrastructure Schedules Third Quarter 2026 Results Conference Call', { id: 'sei-call', publishedAt: '2026-10-16T08:00:00.000Z' });
  const syndicated = { ...preview, id: 'sei-call-dup' };

  function deps(sendLine: NewsAlertDeps['sendLine'], store = createMemorySentStore()): NewsAlertDeps {
    return {
      loadTickers: async () => WATCHED_NAMES.map(({ ticker }) => ({ ticker })),
      fetchCompanyName: async (t) => WATCHED_NAMES.find((w) => w.ticker === t)?.name ?? (t === 'MU' ? 'Micron Technology, Inc.' : undefined),
      searchNews: async (t) => {
        const byTicker: Record<string, RawArticle[]> = {
          SEI: [preview, syndicated],
          NVDA: [MICRON_BUY_NOW.article, SCHD_WORTH_BUYING.article],
          AAPL: [AI_SELLOFF_ROUNDUP.article],
          SPCX: [TESLA_ROADSTER_186X.article, SPACE_RACE_WEEKLY.article],
          NBIS: [NEBIUS_REVENUE_TRENDS.article],
          APLD: [JONESTRADING_KEEPS_BUY.article],
        };
        return (byTicker[t] ?? []).map((a) => ({ ...a, searchTickers: [t] }));
      },
      fetchBody: async (url) => SEVEN_ARTICLES.find((f) => f.article.link === url)?.body,
      translator: null,
      sentStore: store,
      sendLine,
      now: () => NOW,
    };
  }

  it('7記事からは誤通知せず、SEI決算予告とAPLD評価据え置きだけを1回で送る', async () => {
    const sent: string[][] = [];
    const report = await runNewsAlerts(deps(async (texts) => { sent.push(texts); return { success: true, status: 200, requestId: 'req-1' }; }));
    expect(sent).toHaveLength(1);
    expect(report.alerts.map((a) => a.id).sort()).toEqual(['jones-keeps-buy', 'sei-call']);
    expect(report.line).toMatchObject({ attempted: true, success: true, requestId: 'req-1' });
    const text = sent[0]!.join('\n');
    expect(text).toContain('【決算予告】SEI');
    expect(text).toContain('【評価据え置き】APLD');
    expect(text).not.toMatch(/格上げ|格下げ|【決算発表】/);
  });

  it('送信成功した記事は次回送らない（別IDの同一見出しも含む）', async () => {
    const store = createMemorySentStore();
    const send = async (): Promise<LinePushResult> => ({ success: true, status: 200 });
    await runNewsAlerts(deps(send, store));
    let calls = 0;
    const second = await runNewsAlerts(deps(async () => { calls++; return { success: true }; }, store));
    expect(calls).toBe(0);
    expect(second.alerts).toHaveLength(0);
    expect(second.alreadySent).toBeGreaterThanOrEqual(2);
  });

  it('LINE APIが失敗したら送信済みにせず、次回に再送する', async () => {
    const store = createMemorySentStore();
    const failed = await runNewsAlerts(deps(async () => ({ success: false, status: 429, error: 'LINE API 429' }), store));
    expect(failed.status).toBe('line_failed');
    expect([...store.dump().values()]).not.toContain('sent');
    expect(store.dump().size).toBe(0);

    const retried = await runNewsAlerts(deps(async () => ({ success: true, status: 200 }), store));
    expect(retried.line.success).toBe(true);
    expect(retried.alerts).toHaveLength(2);
  });

  it('同じ出来事の別媒体記事は1件にまとめ、次回も送らない', async () => {
    const store = createMemorySentStore();
    const first = rawArticle('Piper Sandler Downgrades Nebius to Neutral', { id: 'nb-1', publisher: 'MT Newswires', publishedAt: '2026-10-16T08:00:00.000Z' });
    const second = rawArticle('Nebius Shares Fall After Piper Sandler Downgrade', { id: 'nb-2', publisher: 'InvestorsHub', publishedAt: '2026-10-16T08:30:00.000Z' });
    const later = rawArticle('Nebius Slides as Piper Sandler Downgrades Stock', { id: 'nb-3', publisher: 'Stocktwits', publishedAt: '2026-10-16T10:00:00.000Z' });
    const base = deps(async () => ({ success: true, status: 200 }), store);
    const sent: string[][] = [];
    const run1 = await runNewsAlerts({
      ...base,
      searchNews: async (t) => (t === 'NBIS' ? [first, second] : []),
      sendLine: async (texts) => { sent.push(texts); return { success: true, status: 200 }; },
    });
    expect(run1.alerts).toHaveLength(1);
    expect(run1.alerts[0]!.id).toBe('nb-1');
    expect(sent[0]!.join()).toContain('同じ内容の報道: 他1件（InvestorsHub）');

    const run2 = await runNewsAlerts({ ...base, searchNews: async (t) => (t === 'NBIS' ? [first, second, later] : []) });
    expect(run2.alerts).toHaveLength(0);
  });

  it('レバレッジETFの原資産tickerでもニュースを検索する', async () => {
    const searched: string[] = [];
    await runNewsAlerts({ ...deps(null), searchNews: async (t) => { searched.push(t); return []; } }, { dryRun: true });
    expect(searched).toContain('MU');
  });

  it('dryRun では送信も送信済み記録もしない', async () => {
    const store = createMemorySentStore();
    let calls = 0;
    const report = await runNewsAlerts(deps(async () => { calls++; return { success: true }; }, store), { dryRun: true });
    expect(calls).toBe(0);
    expect(store.dump().size).toBe(0);
    expect(report.messages?.length).toBe(1);
  });

  it('LINE未設定なら送信済みにしない', async () => {
    const store = createMemorySentStore();
    const report = await runNewsAlerts(deps(null, store));
    expect(report.line.attempted).toBe(false);
    expect(store.dump().size).toBe(0);
  });
});
