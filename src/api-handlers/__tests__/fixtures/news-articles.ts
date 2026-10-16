/**
 * ニュースアラート回帰テスト用の実記事（2026-10-16 取得、Yahoo Finance掲載）
 * 見出し・媒体・relatedTickers は Yahoo 検索APIの値。本文は元記事から該当箇所を短く抜粋。
 * searchTicker は誤通知時に「検索に使われたticker」。
 */
import type { RawArticle } from '../../news/classify.js';

export interface ArticleFixture {
  article: RawArticle;
  body: string;
}

function article(p: Omit<RawArticle, 'searchTickers'> & { searchTicker: string }): RawArticle {
  const { searchTicker, ...rest } = p;
  return { ...rest, searchTickers: [searchTicker] };
}

const PAD = ' The article continues with further discussion that is not relevant to classification.'.repeat(3);

export const MICRON_BUY_NOW: ArticleFixture = {
  article: article({
    id: 'micron-buy-now',
    title: 'Micron Stock Is 25% Below Its June Record. Is It a Buy Now?',
    publisher: 'Motley Fool',
    link: 'https://finance.yahoo.com/markets/stocks/articles/micron-stock-25-below-june-075702143.html',
    publishedAt: '2026-10-16T07:57:02.000Z',
    relatedTickers: ['MU', 'NVDA'],
    searchTicker: 'NVDA',
  }),
  body: 'Daniel Sparks, The Motley Fool. Micron Technology (NASDAQ:MU) hit its closing high of $1,213.56 on June 25, the day after the memory maker posted its fiscal third-quarter results. On Oct. 14, the stock ended at $914.13 -- around 25% below that record. Missed Nvidia in 2009? This Rare Signal Is Flashing Again. In 2009, a "Double Down" signal flashed for a little-known chipmaker called Nvidia. Continue » I think the drop has more to do with where memory prices are heading than with anything going wrong at Micron.' + PAD,
};

export const SCHD_WORTH_BUYING: ArticleFixture = {
  article: article({
    id: 'schd-worth-buying',
    title: "Schwab's Dividend ETF Has Gained 25% This Year. Is It Still Worth Buying?",
    publisher: 'Motley Fool',
    link: 'https://finance.yahoo.com/markets/stocks/articles/schwabs-dividend-etf-gained-25-073302464.html',
    publishedAt: '2026-10-16T07:33:02.000Z',
    relatedTickers: ['SCHD', 'SCHW', '^GSPC', 'NVDA'],
    searchTicker: 'NVDA',
  }),
  body: 'The Schwab U.S. Dividend Equity ETF (NYSEMKT:SCHD) is having one of its better years. At around $34 as I write, the fund has gained about 25% in 2026. Missed AI\'s "Act 1"? Most investors think they missed the AI boat because they didn\'t buy Nvidia in 2005. Continue » My estimate is that $10,000 put into the fund now might be worth a little over $14,000 in five years.' + PAD,
};

export const AI_SELLOFF_ROUNDUP: ArticleFixture = {
  article: article({
    id: 'ai-roundup',
    title: 'Stocktwits AI Roundup: AI Chip Selloff Deepens, CoreWeave Debt Concerns And Apple’s China AI Launch',
    publisher: 'Stocktwits',
    link: 'https://finance.yahoo.com/technology/ai/articles/stocktwits-ai-roundup-ai-chip-061131771.html',
    publishedAt: '2026-10-16T06:11:31.000Z',
    relatedTickers: ['CRWV', 'SOXX', 'AAPL', 'TSM', 'ASML'],
    searchTicker: 'AAPL',
  }),
  body: 'SOXX fell 10.2% in the week through Thursday. CoreWeave plunged 15% on Wednesday, triggered by a drop in its bond prices. Apple reportedly plans to launch Apple Intelligence in China in December. A sharp selloff in chip and AI-linked stocks dominated the conversation this week, spilling over into markets across Asia.' + PAD,
};

export const TESLA_ROADSTER_186X: ArticleFixture = {
  article: article({
    id: 'roadster-186x',
    title: 'Tesla’s $250,000 Roadster Deposit: Is It a Rounding Error at 186x Earnings?',
    publisher: 'TIKR',
    link: 'https://finance.yahoo.com/markets/stocks/articles/tesla-250-000-roadster-deposit-072447161.html',
    publishedAt: '2026-10-16T07:24:47.000Z',
    relatedTickers: ['TSLA', 'SPCX'],
    searchTicker: 'SPCX',
  }),
  body: 'Tesla (TSLA:NASDAQ) finally showed off the next-generation Roadster on Thursday night, October 15, at a SpaceX test site in McGregor, Texas. Elon Musk said some versions will reach 60 mph in under one second, helped by thrusters built with SpaceX. If all 2,000 cars sold for $250,000, that\'s $500 million a year. Tesla\'s automotive revenue was $69.53 billion in 2025, so the Roadster would add about 0.7%. That\'s a rounding error.' + PAD,
};

export const SPACE_RACE_WEEKLY: ArticleFixture = {
  article: article({
    id: 'space-weekly',
    title: 'Stocktwits Space Race Weekly: SPCX Weathers Selloff Better Than ASTS, RKLB And FLY — RDW Fares Best',
    publisher: 'Stocktwits',
    link: 'https://finance.yahoo.com/markets/stocks/articles/stocktwits-space-race-weekly-spcx-062310719.html',
    publishedAt: '2026-10-16T06:23:10.000Z',
    relatedTickers: ['RDW', 'SPCX', 'ASTS', 'RKLB', 'FLY', 'TSLA'],
    searchTicker: 'SPCX',
  }),
  body: 'SpaceX (SPCX) weathered this week\'s space-stock selloff better than AST SpaceMobile (ASTS), Rocket Lab (RKLB) and Firefly Aerospace (FLY), but Redwire (RDW) held up best. SPCX fell 9% over the past week, compared with declines of 13% for ASTS, 19% for RKLB and FLY each. Meanwhile, Barclays suggested that a Tesla-SpaceX merger announcement could come soon.' + PAD,
};

export const NEBIUS_REVENUE_TRENDS: ArticleFixture = {
  article: article({
    id: 'nebius-revenue',
    title: "Innodata vs. Nebius: Here's What Revenue Trends Tell Investors About These Artificial Intelligence Companies",
    publisher: 'Motley Fool',
    link: 'https://finance.yahoo.com/technology/ai/articles/innodata-vs-nebius-heres-revenue-072233400.html',
    publishedAt: '2026-10-16T07:22:33.000Z',
    relatedTickers: ['INOD', 'NBIS', 'PLTR'],
    searchTicker: 'NBIS',
  }),
  body: 'Innodata (NASDAQ:INOD) primarily generates its revenue by providing data engineering services. Nebius (NASDAQ:NBIS) earns most of its revenue by building dedicated infrastructure and managed cloud platforms. Innodata vs. Nebius Revenue over the last 8 quarters. Back in 2024, Innodata produced greater sales than Nebius. Since then, the latter\'s revenue trend reveals its sales exploded in 2025, only to grow faster in 2026.' + PAD,
};

export const JONESTRADING_KEEPS_BUY: ArticleFixture = {
  article: article({
    id: 'jones-keeps-buy',
    title: 'JonesTrading keeps Buy on Cipher and CoreWeave, says selloff is about financing, not demand',
    publisher: 'Blockspace',
    link: 'https://finance.yahoo.com/markets/stocks/articles/jonestrading-keeps-buy-cipher-coreweave-185734118.html',
    publishedAt: '2026-10-15T18:57:34.000Z',
    relatedTickers: ['CRWV', 'CIFR', 'APLD', 'CORZ'],
    searchTicker: 'APLD',
  }),
  body: 'JonesTrading kept Buy ratings on Cipher (NASDAQ: CIFR) and CoreWeave (NASDAQ: CRWV) on Thursday. Analyst Kevin Dede argued that this week\'s selloff in AI infrastructure equities and credit reflects rising financing costs, not weaker demand for compute. Dede holds a $35 target on Cipher and a $160 target on CoreWeave. He also kept Buy ratings on Applied Digital (NASDAQ: APLD) with a $70 target and Core Scientific (NASDAQ: CORZ) with a $25 target. All four targets date to September 28 and were not changed.' + PAD,
};

export const SEVEN_ARTICLES = [
  MICRON_BUY_NOW,
  SCHD_WORTH_BUYING,
  AI_SELLOFF_ROUNDUP,
  TESLA_ROADSTER_186X,
  SPACE_RACE_WEEKLY,
  NEBIUS_REVENUE_TRENDS,
  JONESTRADING_KEEPS_BUY,
];

/** 2026-10-16 時点の保有+監視銘柄と、Yahooの社名 */
export const WATCHED_NAMES: Array<{ ticker: string; name: string }> = [
  { ticker: 'NVDA', name: 'NVIDIA Corporation' },
  { ticker: 'AAPL', name: 'Apple Inc.' },
  { ticker: 'WULF', name: 'TeraWulf Inc.' },
  { ticker: 'SEI', name: 'Solaris Energy Infrastructure, Inc.' },
  { ticker: 'TE', name: 'T1 Energy Inc.' },
  { ticker: 'SPCX', name: 'Space Exploration Technologies Corp.' },
  { ticker: 'NBIS', name: 'Nebius Group N.V.' },
  { ticker: 'APLD', name: 'Applied Digital Corporation' },
  { ticker: 'MUU', name: 'Direxion Daily MU Bull 2X Shares' },
];
