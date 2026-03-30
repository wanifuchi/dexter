/**
 * 取引日記
 * 売買の判断理由と結果を記録し、学習エンジンと連携
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dexterPath } from '../../utils/paths.js';

export interface JournalEntry {
  id: string;
  date: string;
  ticker: string;
  action: 'buy' | 'sell' | 'hold' | 'watchlist';
  reason: string;
  emotion?: string;
  priceAtTime?: number;
  outcome?: string;
  lessonsLearned?: string;
  createdAt: number;
}

interface JournalStore {
  version: 1;
  entries: JournalEntry[];
}

const JOURNAL_KEY = 'finx:journal';
const JOURNAL_PATH = dexterPath('trading', 'journal.json');

async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url, token });
  } catch { return null; }
}

export async function loadJournal(): Promise<JournalStore> {
  const redis = await getRedis();
  if (redis) {
    try {
      let data = await redis.get(JOURNAL_KEY);
      while (typeof data === 'string') { try { data = JSON.parse(data); } catch { break; } }
      if (data && typeof data === 'object' && (data as any).entries) return data as JournalStore;
    } catch {}
  }
  if (existsSync(JOURNAL_PATH)) {
    try { return JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')); } catch {}
  }
  return { version: 1, entries: [] };
}

async function save(store: JournalStore): Promise<void> {
  if (store.entries.length > 500) store.entries = store.entries.slice(-500);
  const redis = await getRedis();
  if (redis) { try { await redis.set(JOURNAL_KEY, JSON.stringify(store)); } catch {} }
  try {
    mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
    writeFileSync(JOURNAL_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch {}
}

export async function addJournalEntry(entry: Omit<JournalEntry, 'id' | 'createdAt'>): Promise<JournalEntry> {
  const store = await loadJournal();
  const newEntry: JournalEntry = { ...entry, id: Date.now().toString(36), createdAt: Date.now() };
  store.entries.push(newEntry);
  await save(store);
  return newEntry;
}

export async function updateJournalOutcome(id: string, outcome: string, lessonsLearned?: string): Promise<boolean> {
  const store = await loadJournal();
  const entry = store.entries.find(e => e.id === id);
  if (!entry) return false;
  entry.outcome = outcome;
  if (lessonsLearned) entry.lessonsLearned = lessonsLearned;
  await save(store);
  return true;
}
