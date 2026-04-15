/**
 * 金融センチメント分析ツール — FinBERT (Hugging Face Inference API)
 *
 * ProsusAI/finbert: BERTベースの金融ニュース特化センチメント分類器
 * - positive / negative / neutral の3値分類
 * - Financial PhraseBank でファインチューン
 * - FinGPTプロジェクトの姉妹モデル
 *
 * HF_API_TOKEN 環境変数が必要
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';

const HF_API = 'https://router.huggingface.co/hf-inference/models';
const MODEL = 'ProsusAI/finbert';

type FinBertLabel = 'positive' | 'negative' | 'neutral';
interface FinBertScore {
  label: FinBertLabel;
  score: number;
}

/**
 * HF Inference APIでFinBERTを呼び出し
 */
async function callFinBert(text: string): Promise<FinBertScore[]> {
  const token = process.env.HF_API_TOKEN;
  if (!token) throw new Error('HF_API_TOKEN is not configured');

  const res = await fetch(`${HF_API}/${MODEL}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs: text }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`FinBERT API error (${res.status}): ${errText}`);
  }

  const data = await res.json() as FinBertScore[][] | FinBertScore[];
  // Hugging Face APIは配列の配列を返すことがある
  const scores = Array.isArray(data[0]) ? (data as FinBertScore[][])[0] : (data as FinBertScore[]);
  return scores;
}

/**
 * センチメントスコアを日本語ラベルに変換
 */
function interpretSentiment(scores: FinBertScore[]): {
  label: string;
  confidence: string;
  bullish: string;
  bearish: string;
  neutral: string;
} {
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const top = sorted[0];

  const labelMap: Record<FinBertLabel, string> = {
    positive: '🟢 Bullish (ポジティブ)',
    negative: '🔴 Bearish (ネガティブ)',
    neutral: '⚪ Neutral (中立)',
  };

  const getScore = (label: FinBertLabel) =>
    `${((scores.find(s => s.label === label)?.score ?? 0) * 100).toFixed(1)}%`;

  return {
    label: labelMap[top.label] || top.label,
    confidence: `${(top.score * 100).toFixed(1)}%`,
    bullish: getScore('positive'),
    bearish: getScore('negative'),
    neutral: getScore('neutral'),
  };
}

export const newsSentimentTool = new DynamicStructuredTool({
  name: 'news_sentiment',
  description: 'Analyze financial sentiment of news text using FinBERT (ProsusAI/finbert). Returns bullish/neutral/bearish scores. Use for: news headlines, earnings press releases, company announcements, market commentary. Works best with English text but handles short Japanese too.',
  schema: z.object({
    text: z.string().describe('Financial text to analyze (news headline, earnings summary, etc.). English preferred. Max ~500 chars.'),
    items: z.array(z.string()).optional().describe('Optional array of texts to analyze in batch (e.g., multiple headlines)'),
  }),
  func: async (input) => {
    if (!process.env.HF_API_TOKEN) {
      return formatToolResult({
        error: 'HF_API_TOKEN is not configured. Set it in environment variables.',
      });
    }

    try {
      // バッチモード
      if (input.items && input.items.length > 0) {
        const results = await Promise.all(
          input.items.slice(0, 10).map(async (text) => {
            try {
              const scores = await callFinBert(text.slice(0, 500));
              const interpreted = interpretSentiment(scores);
              return { text: text.slice(0, 100), ...interpreted };
            } catch (e) {
              return { text: text.slice(0, 100), error: e instanceof Error ? e.message : String(e) };
            }
          })
        );

        // 平均スコアを計算
        const validResults = results.filter(r => !('error' in r)) as Array<ReturnType<typeof interpretSentiment> & { text: string }>;
        if (validResults.length > 0) {
          let bullishSum = 0, bearishSum = 0, neutralSum = 0;
          for (const r of validResults) {
            bullishSum += parseFloat(r.bullish);
            bearishSum += parseFloat(r.bearish);
            neutralSum += parseFloat(r.neutral);
          }
          const n = validResults.length;
          const avg = {
            bullish: `${(bullishSum / n).toFixed(1)}%`,
            bearish: `${(bearishSum / n).toFixed(1)}%`,
            neutral: `${(neutralSum / n).toFixed(1)}%`,
          };
          const dominant = bullishSum > bearishSum && bullishSum > neutralSum ? '🟢 Bullish'
            : bearishSum > bullishSum && bearishSum > neutralSum ? '🔴 Bearish'
            : '⚪ Neutral';

          return formatToolResult({
            mode: 'batch',
            itemCount: results.length,
            dominant,
            average: avg,
            items: results,
            source: 'FinBERT (ProsusAI/finbert) via Hugging Face Inference API',
          });
        }

        return formatToolResult({ mode: 'batch', items: results, error: 'All items failed' });
      }

      // 単一モード
      const scores = await callFinBert(input.text.slice(0, 500));
      const interpreted = interpretSentiment(scores);

      return formatToolResult({
        text: input.text.slice(0, 200),
        ...interpreted,
        source: 'FinBERT (ProsusAI/finbert) via Hugging Face Inference API',
        note: 'FinBERTは金融ニュース特化のBERTモデル。ポジティブ=株価にプラス、ネガティブ=マイナスの解釈。',
      });
    } catch (error) {
      return formatToolResult({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

export const NEWS_SENTIMENT_DESCRIPTION = `Analyzes financial sentiment of news text using FinBERT.
Returns bullish/bearish/neutral scores for:
- News headlines
- Earnings announcements
- Company press releases
- Market commentary
Supports batch mode (analyze multiple headlines at once, returns dominant sentiment).
Works best with English text. Use with finnhub_news or get_market_data news results.
Combine with prediction_market + fred_data for full market picture.`;
