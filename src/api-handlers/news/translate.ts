/**
 * ニュース見出し・本文の日本語化（LLM）と、その出力の検証
 *
 * LLMの出力はそのまま信用しない:
 * - 原文に無い数値を含む項目は捨てる（数字の改変・創作の防止）
 * - 見出しの数値が日本語タイトルから消えていたら翻訳を採用しない
 * - 原題が疑問形・推量表現なのに、日本語タイトルが断定になっていたら採用しない
 * 採用できなかった場合は「翻訳未確認」として原題だけを表示する。
 */
import { z } from 'zod';
import { callLlm, getFastModel } from '../../model/llm.js';

export interface JapaneseDigest {
  /** 日本語タイトル（検証済み）。null なら翻訳未確認 */
  jaTitle: string | null;
  /** 短い要約（検証済み） */
  summary: string | null;
  /** 記事が報じている事実（記事の記載であり、一次資料での確認ではない） */
  reported: string | null;
  /** 筆者・アナリストの意見 */
  opinion: string | null;
  /** 予測・目標・見通し */
  forecast: string | null;
  /** 検証で捨てた項目と理由 */
  rejected: string[];
}

export interface DigestInput {
  title: string;
  body?: string;
  /** 通知対象の銘柄（例: "APLD"）。要約をこの銘柄に関係する記載に絞る */
  focus?: string[];
}

export type Translator = (input: DigestInput) => Promise<unknown>;

const digestSchema = z.object({
  jaTitle: z.string().describe('見出しの日本語訳'),
  summary: z.string().nullable().describe('100字以内の要約。本文が無ければ見出しから言える範囲のみ'),
  reported: z.string().nullable().describe('記事が事実として報じている内容（80字以内）。無ければnull'),
  opinion: z.string().nullable().describe('筆者・アナリストの意見や評価（80字以内）。無ければnull'),
  forecast: z.string().nullable().describe('予測・目標株価・見通し（80字以内）。無ければnull'),
});

const SYSTEM_PROMPT = `あなたは金融ニュースの翻訳者です。与えられた英語ニュースを日本語に訳し、要約します。
厳守事項:
- 原文に書かれていないことを書かない。推測で補わない。不明な項目は null にする。
- 数値・通貨・単位・倍率・年は原文の表記のまま残す（例: "$54.2 billion" は "$54.2 billion"、"25%" は "25%"、"186x" は "186x"）。円換算や桁の言い換えをしない。
- 断定の強さを変えない。原文が疑問形なら疑問形（「〜か？」）で訳す。could / may / might は「可能性がある」「〜かもしれない」と訳す。
- 報道された事実(reported)、筆者やアナリストの意見(opinion)、予測・目標(forecast)を混ぜない。
- 日付・曜日は原文の表現のまま訳す（"on Wednesday" は「水曜日に」）。原文に無い年月日を補わない。
- 広告・購読勧誘・他記事への誘導文（"Continue »" など）は無視する。
- 要約は100字以内、各項目は80字以内。通知対象の銘柄が指定されたら、その銘柄に関係する記載を優先する。
- 本文が与えられない場合、要約は見出しから言える範囲だけにする。`;

const BODY_LIMIT = 3500;

export const llmTranslator: Translator = async ({ title, body, focus }) => {
  const prompt = [
    `見出し: ${title}`,
    focus?.length ? `通知対象の銘柄: ${focus.join(', ')}` : '',
    body ? `本文（取得できた範囲）:\n${body.slice(0, BODY_LIMIT)}` : '本文: なし（見出しのみ）',
  ].filter(Boolean).join('\n\n');
  const { response } = await callLlm(prompt, {
    model: getFastModel('openai', 'gpt-4.1'),
    systemPrompt: SYSTEM_PROMPT,
    outputSchema: digestSchema,
  });
  return response;
};

// ---------- 検証 ----------

/** "1,213.56" "25%" "$35" "186x" などから数値部分を正規化して取り出す */
export function extractNumbers(text: string): string[] {
  const matches = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((m) => {
    const n = m.replace(/,/g, '');
    return n.includes('.') ? n.replace(/0+$/, '').replace(/\.$/, '') : n;
  });
}

/** "Third Quarter" → 第3四半期 のように、英語の数詞を数字にした訳は許容する */
const NUMBER_WORDS: Record<string, string> = {
  one: '1', first: '1', two: '2', second: '2', three: '3', third: '3', four: '4', fourth: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  january: '1', jan: '1', february: '2', feb: '2', march: '3', mar: '3', april: '4', apr: '4',
  may: '5', june: '6', jun: '6', july: '7', jul: '7', august: '8', aug: '8', september: '9',
  sept: '9', sep: '9', october: '10', oct: '10', november: '11', nov: '11', december: '12', dec: '12',
};

function unknownNumbers(output: string, source: string): string[] {
  const allowed = new Set(extractNumbers(source));
  for (const word of source.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (NUMBER_WORDS[word]) allowed.add(NUMBER_WORDS[word]);
  }
  return extractNumbers(output).filter((n) => !allowed.has(n));
}

const HEDGE_EN_RE = /\?|\b(?:could|may|might|would|possibly|likely|prediction|predicts?|expects?)\b/i;
const HEDGE_JA_RE = /[?？]|か[。」]?$|可能性|かもしれ|見込|予想|予測|恐れ|おそれ|だろう|見通し|期待/;

function checkTitle(jaTitle: string, title: string): string | null {
  const titleNumbers = extractNumbers(title);
  const jaNumbers = new Set(extractNumbers(jaTitle));
  const missing = titleNumbers.filter((n) => !jaNumbers.has(n));
  if (missing.length > 0) return `見出しの数値が訳から欠落: ${missing.join(', ')}`;
  const extra = unknownNumbers(jaTitle, title);
  if (extra.length > 0) return `見出しに無い数値が訳に混入: ${extra.join(', ')}`;
  if (HEDGE_EN_RE.test(title) && !HEDGE_JA_RE.test(jaTitle)) return '原題の疑問・推量表現が訳で断定になっている';
  return null;
}

/** 長すぎる出力は文の区切りで切る（途中の語を切らない） */
function clampSentences(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const end = cut.lastIndexOf('。');
  return end > 0 ? cut.slice(0, end + 1) : `${cut}…`;
}

function cleanField(value: unknown, source: string, label: string, rejected: string[], maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text === 'null') return null;
  const extra = unknownNumbers(text, source);
  if (extra.length > 0) {
    rejected.push(`${label}: 原文に無い数値 ${extra.join(', ')}`);
    return null;
  }
  return clampSentences(text, maxChars);
}

/** LLMの出力を検証し、原文と矛盾しない項目だけを残す */
export function validateDigest(raw: unknown, input: DigestInput): JapaneseDigest {
  const rejected: string[] = [];
  const parsed = digestSchema.safeParse(raw);
  if (!parsed.success) {
    return { jaTitle: null, summary: null, reported: null, opinion: null, forecast: null, rejected: ['出力形式が不正'] };
  }
  const source = `${input.title}\n${input.body ?? ''}`;
  const d = parsed.data;

  let jaTitle: string | null = d.jaTitle.trim() || null;
  if (jaTitle) {
    const problem = checkTitle(jaTitle, input.title);
    if (problem) {
      rejected.push(`タイトル: ${problem}`);
      jaTitle = null;
    }
  }

  return {
    jaTitle,
    summary: cleanField(d.summary, source, '要約', rejected, 140),
    reported: cleanField(d.reported, source, '報道内容', rejected, 120),
    opinion: cleanField(d.opinion, source, '意見', rejected, 120),
    forecast: cleanField(d.forecast, source, '予測', rejected, 120),
    rejected,
  };
}

const EMPTY_DIGEST = (reason: string): JapaneseDigest => ({
  jaTitle: null, summary: null, reported: null, opinion: null, forecast: null, rejected: [reason],
});

export async function buildDigest(input: DigestInput, translator: Translator | null): Promise<JapaneseDigest> {
  if (!translator) return EMPTY_DIGEST('翻訳機能が利用できない');
  try {
    const raw = await translator(input);
    return validateDigest(raw, input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return EMPTY_DIGEST(`翻訳に失敗: ${message.slice(0, 120)}`);
  }
}
