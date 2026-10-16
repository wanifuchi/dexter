/**
 * ニュース通知の送信済み管理（重複通知の防止）
 *
 * 記事ごとに2つのキーを持つ:
 * - Yahooの記事ID（uuid）
 * - 正規化した見出し（同じ記事が別IDで配信された場合の重複防止）
 *
 * 状態遷移: (なし) → sending（送信中の予約・10分で失効）→ sent（7日保持）
 * LINE送信に失敗したら予約を消す。送信成功を確認できた記事だけを sent にする。
 */

export interface SentStore {
  readonly available: boolean;
  /** 送信済み、または他の実行が送信中なら true */
  isTaken(keys: string[]): Promise<boolean>;
  /** 送信予約。他の実行が先に予約していたら false */
  claim(keys: string[]): Promise<boolean>;
  markSent(keys: string[]): Promise<void>;
  release(keys: string[]): Promise<void>;
}

const PREFIX = 'finx:news:sent:';
const CLAIM_TTL_SEC = 600;
const SENT_TTL_SEC = 7 * 24 * 3600;

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9぀-ヿ一-鿿]+/g, ' ').trim();
}

export function dedupeKeysOf(article: { id: string; title: string }): string[] {
  return [`id:${article.id}`, `title:${normalizeTitle(article.title)}`];
}

interface RedisLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts?: { nx?: boolean; ex?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export function createRedisSentStore(redis: RedisLike): SentStore {
  return {
    available: true,
    async isTaken(keys) {
      const values = await Promise.all(keys.map((k) => redis.get(PREFIX + k)));
      return values.some((v) => v !== null && v !== undefined);
    },
    async claim(keys) {
      const claimed: string[] = [];
      for (const k of keys) {
        const ok = await redis.set(PREFIX + k, 'sending', { nx: true, ex: CLAIM_TTL_SEC });
        if (ok !== 'OK') {
          if (claimed.length > 0) await redis.del(...claimed.map((c) => PREFIX + c));
          return false;
        }
        claimed.push(k);
      }
      return true;
    },
    async markSent(keys) {
      await Promise.all(keys.map((k) => redis.set(PREFIX + k, 'sent', { ex: SENT_TTL_SEC })));
    },
    async release(keys) {
      if (keys.length > 0) await redis.del(...keys.map((k) => PREFIX + k));
    },
  };
}

/** Redisが無い環境（ローカル等）用。実行をまたいだ重複防止はできない */
export function createMemorySentStore(): SentStore & { dump(): Map<string, string> } {
  const data = new Map<string, string>();
  return {
    available: false,
    async isTaken(keys) { return keys.some((k) => data.has(k)); },
    async claim(keys) {
      if (keys.some((k) => data.has(k))) return false;
      for (const k of keys) data.set(k, 'sending');
      return true;
    },
    async markSent(keys) { for (const k of keys) data.set(k, 'sent'); },
    async release(keys) { for (const k of keys) data.delete(k); },
    dump() { return data; },
  };
}

export async function getSentStore(): Promise<SentStore> {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_KV_REST_API_TOKEN;
  if (!url || !token) return createMemorySentStore();
  const { Redis } = await import('@upstash/redis');
  return createRedisSentStore(new Redis({ url, token }) as unknown as RedisLike);
}
