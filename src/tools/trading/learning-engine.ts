/**
 * ユーザー適応学習エンジン
 * 対話を通じてユーザーの投資スタイル・判断基準・成功/失敗パターンを学習し、
 * Finxの提案を個人に最適化する。
 *
 * 学習データはRedisに永続化し、システムプロンプト生成時に参照される。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dexterPath } from '../../utils/paths.js';

export interface LearningEntry {
  id: string;
  type: 'preference' | 'feedback' | 'lesson' | 'style' | 'bias_alert';
  content: string;
  context?: string;
  createdAt: number;
}

export interface LearningStore {
  version: 1;
  entries: LearningEntry[];
  investmentStyle: {
    riskTolerance: 'conservative' | 'moderate' | 'aggressive' | null;
    timeHorizon: 'short' | 'medium' | 'long' | null;
    preferredSectors: string[];
    avoidSectors: string[];
    preferredStrategies: string[];
    notes: string[];
  };
}

const LEARNING_KEY = 'finx:learning';
const LEARNING_PATH = dexterPath('trading', 'learning.json');

const EMPTY_STORE: LearningStore = {
  version: 1,
  entries: [],
  investmentStyle: {
    riskTolerance: null,
    timeHorizon: null,
    preferredSectors: [],
    avoidSectors: [],
    preferredStrategies: [],
    notes: [],
  },
};

async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url, token });
  } catch { return null; }
}

export async function loadLearning(): Promise<LearningStore> {
  const redis = await getRedis();
  if (redis) {
    try {
      let data = await redis.get(LEARNING_KEY);
      while (typeof data === 'string') { try { data = JSON.parse(data); } catch { break; } }
      if (data && typeof data === 'object' && (data as any).entries) return data as LearningStore;
    } catch {}
  }
  if (existsSync(LEARNING_PATH)) {
    try { return JSON.parse(readFileSync(LEARNING_PATH, 'utf-8')); } catch {}
  }
  return { ...EMPTY_STORE };
}

async function save(store: LearningStore): Promise<void> {
  // 最新100件のみ保持
  if (store.entries.length > 100) store.entries = store.entries.slice(-100);
  const redis = await getRedis();
  if (redis) { try { await redis.set(LEARNING_KEY, JSON.stringify(store)); } catch {} }
  try {
    mkdirSync(dirname(LEARNING_PATH), { recursive: true });
    writeFileSync(LEARNING_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch {}
}

export async function addLearningEntry(entry: Omit<LearningEntry, 'id' | 'createdAt'>): Promise<void> {
  const store = await loadLearning();
  store.entries.push({
    ...entry,
    id: Date.now().toString(36),
    createdAt: Date.now(),
  });
  await save(store);
}

export async function updateInvestmentStyle(updates: Partial<LearningStore['investmentStyle']>): Promise<void> {
  const store = await loadLearning();
  Object.assign(store.investmentStyle, updates);
  await save(store);
}

/**
 * 学習データをシステムプロンプト用のテキストに変換
 */
export async function buildLearningContext(): Promise<string> {
  const store = await loadLearning();
  if (store.entries.length === 0 && !store.investmentStyle.riskTolerance) return '';

  const parts: string[] = ['## ユーザー学習データ（過去の対話から蓄積）\n'];

  // 投資スタイル
  const s = store.investmentStyle;
  if (s.riskTolerance || s.timeHorizon || s.preferredSectors.length > 0) {
    parts.push('### 投資スタイル');
    if (s.riskTolerance) parts.push(`- リスク許容度: ${s.riskTolerance}`);
    if (s.timeHorizon) parts.push(`- 投資期間: ${s.timeHorizon}`);
    if (s.preferredSectors.length > 0) parts.push(`- 好みのセクター: ${s.preferredSectors.join(', ')}`);
    if (s.avoidSectors.length > 0) parts.push(`- 避けたいセクター: ${s.avoidSectors.join(', ')}`);
    if (s.preferredStrategies.length > 0) parts.push(`- 好みの戦略: ${s.preferredStrategies.join(', ')}`);
    if (s.notes.length > 0) parts.push(`- メモ: ${s.notes.join('; ')}`);
    parts.push('');
  }

  // 直近のフィードバック・教訓
  const recent = store.entries.slice(-20);
  if (recent.length > 0) {
    parts.push('### 過去のフィードバック・教訓');
    for (const entry of recent) {
      const typeLabel = {
        preference: '好み',
        feedback: 'フィードバック',
        lesson: '教訓',
        style: 'スタイル',
        bias_alert: 'バイアス警告',
      }[entry.type];
      parts.push(`- [${typeLabel}] ${entry.content}`);
    }
    parts.push('');
  }

  parts.push('上記の学習データを踏まえて、このユーザーに最適化された提案をしてください。');
  return parts.join('\n');
}
