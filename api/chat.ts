/**
 * Vercel Serverless Function — /api/chat
 * SSE streaming endpoint for the Finx chat agent.
 *
 * Uses Node.js runtime (not Edge) so that better-sqlite3 and all
 * LangChain providers work without changes.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runAgentForMessage } from '../src/gateway/agent-runner.js';
import { resolveProvider } from '../src/providers.js';
import type { AgentEvent } from '../src/agent/types.js';

// Allow up to 5 minutes for complex analyses
export const maxDuration = 300;

const DEFAULT_MODEL = process.env.DEXTER_MODEL ?? 'gpt-5.4';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as { query?: string; sessionId?: string; image?: { base64: string; mimeType: string } } | undefined;
  const query = body?.query?.trim();
  const image = body?.image;

  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const sessionKey = body?.sessionId ?? 'web-default';

  try {
    // 画像が添付されている場合、Visionプロンプトとしてクエリに統合
    const effectiveQuery = image
      ? `[画像が添付されています。以下の質問に画像の内容を踏まえて回答してください]\n\n${query}`
      : query;

    const answer = await runAgentForMessage({
      sessionKey,
      query: effectiveQuery,
      image,
      model: DEFAULT_MODEL,
      modelProvider: resolveProvider(DEFAULT_MODEL).id,
      maxIterations: 15,
      onEvent: async (event: AgentEvent) => {
        switch (event.type) {
          case 'thinking':
            send('thinking', { message: event.message });
            break;
          case 'tool_start':
            send('tool_start', { tool: event.tool, args: event.args });
            break;
          case 'tool_end':
            send('tool_end', { tool: event.tool, duration: event.duration });
            break;
          case 'tool_error':
            send('tool_error', { tool: event.tool, error: event.error });
            break;
          case 'done':
            send('done', {
              answer: event.answer,
              iterations: event.iterations,
              totalTime: event.totalTime,
              tokenUsage: event.tokenUsage,
            });
            break;
        }
      },
    });

    send('complete', { answer });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send('error', { message });
  }

  res.end();
}
