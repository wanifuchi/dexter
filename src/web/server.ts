/**
 * Web APIサーバー - DexterエージェントをHTTP API + チャットUIとして公開
 * SSE (Server-Sent Events) でリアルタイムストリーミング
 */
import { serve } from 'bun';
import { runAgentForMessage } from '../gateway/agent-runner.js';
import { resolveProvider } from '../providers.js';
import type { AgentEvent } from '../agent/types.js';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.WEB_PORT ?? '3456', 10);
const DEFAULT_MODEL = process.env.DEXTER_MODEL ?? 'gpt-5.4';

/**
 * SSEストリーミングでエージェントイベントを送信
 */
function createSSEStream(query: string, sessionKey: string): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const answer = await runAgentForMessage({
          sessionKey,
          query,
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

        // ストリーム終了
        send('complete', { answer });
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send('error', { message });
        controller.close();
      }
    },
  });
}

/**
 * 静的ファイルのContent-Type判定
 */
function getContentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'text/plain; charset=utf-8';
}

/**
 * HTTPサーバー
 */
const server = serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // チャットAPI (SSE)
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await req.json() as { query: string; sessionId?: string };
      const query = body.query?.trim();

      if (!query) {
        return Response.json({ error: 'query is required' }, { status: 400 });
      }

      const sessionKey = body.sessionId ?? 'web-default';
      const stream = createSSEStream(query, sessionKey);

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // ヘルスチェック
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok', model: DEFAULT_MODEL });
    }

    // 静的ファイル配信
    const filePath = url.pathname === '/'
      ? join(__dirname, 'public', 'index.html')
      : join(__dirname, 'public', url.pathname);

    try {
      const content = await readFile(filePath);
      return new Response(content, {
        headers: { 'Content-Type': getContentType(filePath) },
      });
    } catch {
      // フォールバック: index.html
      try {
        const index = await readFile(join(__dirname, 'public', 'index.html'));
        return new Response(index, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
  },
});

console.log(`🚀 Dexter Web is running at http://localhost:${PORT}`);
