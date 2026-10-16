/**
 * ニュースアラートのLINE文面
 */
import { CATEGORY_LABELS } from './classify.js';
import type { ArticleAssessment, Classification, NotifyTarget } from './classify.js';
import type { JapaneseDigest } from './translate.js';

export interface AlertItem {
  assessment: ArticleAssessment;
  targets: NotifyTarget[];
  /** 同じ出来事（送信済み判定に使う） */
  eventKeys: string[];
  /** 同じ出来事を報じた他の記事 */
  corroborating: ArticleAssessment[];
  digest: JapaneseDigest;
}

/** LINEのテキスト上限は5000文字。余裕を持たせる */
export const LINE_TEXT_LIMIT = 4800;
/** 1回のpushで送れるメッセージ数の上限 */
export const LINE_MESSAGES_PER_PUSH = 5;

export function categoryLabel(c: Classification): string {
  if (c.category === 'price_target') {
    if (c.direction === 'up') return '目標株価変更（引き上げ）';
    if (c.direction === 'down') return '目標株価変更（引き下げ）';
    return CATEGORY_LABELS.price_target;
  }
  if (c.category !== 'rating_change') return CATEGORY_LABELS[c.category];
  if (c.direction === 'up') return '格上げ';
  if (c.direction === 'down') return '格下げ';
  return '格上げ・格下げ（方向未確認）';
}

export function formatJst(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '不明';
  return d.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }) + ' JST';
}

function targetLine(t: NotifyTarget): string {
  const role = t.role === 'subject'
    ? (t.viaUnderlying ? `主題（原資産${t.viaUnderlying}）` : '主題')
    : '関連（本文で言及）';
  return `${t.ticker}：${categoryLabel(t.classification)}／${role}`;
}

export function formatAlertItem(item: AlertItem): string {
  const { assessment: a, targets, digest } = item;
  const lines: string[] = [];
  const mainLabel = categoryLabel(targets[0]?.classification ?? a.classification);

  lines.push(`【${mainLabel}】${targets.map((t) => t.ticker).join(', ')}`);
  lines.push(digest.jaTitle ?? '（翻訳未確認：原題のみ表示）');
  lines.push(`原題: ${a.article.title}`);
  if (digest.summary) lines.push(`要約: ${digest.summary}`);
  if (digest.reported) lines.push(`・報道内容: ${digest.reported}`);
  if (digest.opinion) lines.push(`・筆者/アナリストの意見: ${digest.opinion}`);
  if (digest.forecast) lines.push(`・予測・目標: ${digest.forecast}`);
  lines.push(a.isPrimarySource
    ? `・一次資料: 企業自身の発表文（${a.article.publisher}配信）`
    : '・一次資料: 未確認（記事の記載に基づく）');

  lines.push(`対象銘柄: ${targets.map(targetLine).join(' / ')}`);
  const others = a.subjectNames.filter((n) => !targets.some((t) => n.startsWith(t.ticker)));
  if (others.length > 0) lines.push(`記事の主題: ${others.join(', ')}`);
  lines.push(`記事の分類: ${categoryLabel(a.classification)}`);
  lines.push(`確認範囲: ${a.bodyChecked ? '見出し＋本文（取得できた範囲）' : '見出しのみ確認'}`);
  lines.push(`媒体: ${a.article.publisher || '不明'}`);
  if (item.corroborating.length > 0) {
    const publishers = [...new Set(item.corroborating.map((c) => c.article.publisher || '不明'))];
    lines.push(`同じ内容の報道: 他${item.corroborating.length}件（${publishers.join(', ')}）`);
  }
  lines.push(`公開: ${formatJst(a.article.publishedAt)}`);
  lines.push(a.article.link);
  return lines.join('\n');
}

export interface PackedMessages {
  messages: string[];
  /** messages に含めた記事ID */
  includedIds: string[];
  /** 上限超過で今回送らない記事ID（次回以降に回る） */
  deferredIds: string[];
}

/**
 * 記事ブロックを途中で切らずにLINEメッセージへ詰める。
 * 入りきらない記事は送らず deferred にする（切り詰めて送信済み扱いにしない）。
 */
export function packMessages(header: string, items: AlertItem[]): PackedMessages {
  const messages: string[] = [];
  const includedIds: string[] = [];
  const deferredIds: string[] = [];
  let current = header;

  for (const item of items) {
    const block = formatAlertItem(item).slice(0, LINE_TEXT_LIMIT - header.length - 4);
    const candidate = `${current}\n\n${block}`;
    if (candidate.length <= LINE_TEXT_LIMIT) {
      current = candidate;
      includedIds.push(item.assessment.article.id);
      continue;
    }
    if (messages.length + 1 >= LINE_MESSAGES_PER_PUSH) {
      deferredIds.push(item.assessment.article.id);
      continue;
    }
    messages.push(current);
    current = `${header}（続き）\n\n${block}`;
    includedIds.push(item.assessment.article.id);
  }
  if (includedIds.length > 0) messages.push(current);
  return { messages, includedIds, deferredIds };
}
