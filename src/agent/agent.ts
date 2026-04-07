import { AIMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';
import { callLlm } from '../model/llm.js';
import { getTools } from '../tools/registry.js';
import { buildSystemPrompt, buildIterationPrompt, loadSoulDocument } from './prompts.js';
import { extractTextContent, hasToolCalls } from '../utils/ai-message.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { buildHistoryContext } from '../utils/history-context.js';
import { estimateTokens, CONTEXT_THRESHOLD, KEEP_TOOL_USES } from '../utils/tokens.js';
import { formatUserFacingError, isContextOverflowError } from '../utils/errors.js';
import type { AgentConfig, AgentEvent, ContextClearedEvent, TokenUsage } from '../agent/types.js';
import { createRunContext, type RunContext } from './run-context.js';
import { AgentToolExecutor } from './tool-executor.js';
import { MemoryManager } from '../memory/index.js';
import { runMemoryFlush, shouldRunMemoryFlush } from '../memory/flush.js';
import { resolveProvider } from '../providers.js';
import type { ImageContent } from '../model/llm.js';
import type { ConversationTurn } from '../conversation/types.js';
import {
  classifyRecommendationIntent,
  checkRecommendationEvidence,
  buildEvidenceInsufficientResponse,
  containsPersonalizationExpressions,
  shouldBlockMemory,
  type RecommendationIntent,
  type ToolCallResult,
} from './recommendation-guard.js';


const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_MAX_ITERATIONS = 10;
const MAX_OVERFLOW_RETRIES = 2;
const OVERFLOW_KEEP_TOOL_USES = 3;

/**
 * The core agent class that handles the agent loop and tool execution.
 */
export class Agent {
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly tools: StructuredToolInterface[];
  private readonly toolMap: Map<string, StructuredToolInterface>;
  private readonly toolExecutor: AgentToolExecutor;
  private readonly systemPrompt: string;
  private readonly signal?: AbortSignal;
  private readonly memoryEnabled: boolean;

  private constructor(
    config: AgentConfig,
    tools: StructuredToolInterface[],
    systemPrompt: string,
  ) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.tools = tools;
    this.toolMap = new Map(tools.map(t => [t.name, t]));
    this.toolExecutor = new AgentToolExecutor(this.toolMap, config.signal, config.requestToolApproval, config.sessionApprovedTools);
    this.systemPrompt = systemPrompt;
    this.signal = config.signal;
    this.memoryEnabled = config.memoryEnabled ?? true;
  }

  /**
   * Create a new Agent instance with tools.
   */
  static async create(config: AgentConfig = {}): Promise<Agent> {
    const model = config.model ?? DEFAULT_MODEL;
    let tools = getTools(model);

    // blockedToolsが指定されている場合、該当ツールを除外
    if (config.blockedTools && config.blockedTools.size > 0) {
      tools = tools.filter(t => !config.blockedTools!.has(t.name));
    }
    const soulContent = await loadSoulDocument();
    let memoryFiles: string[] = [];
    let memoryContext: string | null = null;

    if (config.memoryEnabled !== false) {
      const memoryManager = await MemoryManager.get();
      memoryFiles = await memoryManager.listFiles();
      const session = await memoryManager.loadSessionContext();
      if (session.text.trim()) {
        memoryContext = session.text;
      }
    }

    // 学習データ（ユーザー適応）を読み込み
    let learningContext = '';
    try {
      const { buildLearningContext } = await import('../tools/trading/learning-engine.js');
      learningContext = await buildLearningContext();
    } catch {}

    const systemPrompt = buildSystemPrompt(
      model,
      soulContent,
      config.channel,
      config.groupContext,
      memoryFiles,
      memoryContext,
      learningContext,
    );
    return new Agent(config, tools, systemPrompt);
  }

  /**
   * Run the agent and yield events for real-time UI updates.
   * Anthropic-style context management: full tool results during iteration,
   * with threshold-based clearing of oldest results when context exceeds limit.
   */
  async *run(query: string, inMemoryHistory?: InMemoryChatHistory, image?: ImageContent, threadTurns?: ConversationTurn[]): AsyncGenerator<AgentEvent> {
    const startTime = Date.now();

    if (this.tools.length === 0) {
      yield { type: 'done', answer: 'No tools available. Please check your API key configuration.', toolCalls: [], iterations: 0, totalTime: Date.now() - startTime };
      return;
    }

    const ctx = createRunContext(query);
    const memoryFlushState = { alreadyFlushed: false };
    const recommendationIntent = classifyRecommendationIntent(query);
    const toolResults: ToolCallResult[] = [];
    const failedTools: string[] = [];

    // Build initial prompt with conversation history context
    let currentPrompt = this.buildInitialPrompt(query, inMemoryHistory, threadTurns);

    // Main agent loop
    let overflowRetries = 0;
    while (ctx.iteration < this.maxIterations) {
      ctx.iteration++;

      let response: AIMessage | string;
      let usage: TokenUsage | undefined;

      while (true) {
        try {
          // 画像は最初のイテレーションでのみ送信（以降はテキストのみ）
          const imageForThisCall = ctx.iteration === 1 ? image : undefined;
          const result = await this.callModel(currentPrompt, true, imageForThisCall);
          response = result.response;
          usage = result.usage;
          overflowRetries = 0;
          break;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          if (isContextOverflowError(errorMessage) && overflowRetries < MAX_OVERFLOW_RETRIES) {
            overflowRetries++;
            const clearedCount = ctx.scratchpad.clearOldestToolResults(OVERFLOW_KEEP_TOOL_USES);

            if (clearedCount > 0) {
              yield { type: 'context_cleared', clearedCount, keptCount: OVERFLOW_KEEP_TOOL_USES };
              currentPrompt = buildIterationPrompt(
                query,
                ctx.scratchpad.getToolResults(),
                ctx.scratchpad.formatToolUsageForPrompt()
              );
              continue;
            }
          }

          const totalTime = Date.now() - ctx.startTime;
          const provider = resolveProvider(this.model).displayName;
          yield {
            type: 'done',
            answer: `Error: ${formatUserFacingError(errorMessage, provider)}`,
            toolCalls: ctx.scratchpad.getToolCallRecords(),
            iterations: ctx.iteration,
            totalTime,
            tokenUsage: ctx.tokenCounter.getUsage(),
            tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
          };
          return;
        }
      }

      ctx.tokenCounter.add(usage);
      const responseText = typeof response === 'string' ? response : extractTextContent(response);

      // Emit thinking if there are also tool calls (skip whitespace-only responses)
      if (responseText?.trim() && typeof response !== 'string' && hasToolCalls(response)) {
        const trimmedText = responseText.trim();
        ctx.scratchpad.addThinking(trimmedText);
        yield { type: 'thinking', message: trimmedText };
      }

      // No tool calls = final answer is in this response
      if (typeof response === 'string' || !hasToolCalls(response)) {
        yield* this.handleDirectResponse(responseText ?? '', ctx, recommendationIntent, toolResults, failedTools);
        return;
      }

      // Execute tools and add results to scratchpad (response is AIMessage here)
      for await (const event of this.toolExecutor.executeAll(response, ctx)) {
        yield event;
        // Track tool results for recommendation evidence guard (中身ベース判定)
        if (event.type === 'tool_end') toolResults.push({ tool: event.tool, result: event.result ?? '' });
        if (event.type === 'tool_error') failedTools.push(event.tool);
        if (event.type === 'tool_denied') {
          const totalTime = Date.now() - ctx.startTime;
          yield {
            type: 'done',
            answer: '',
            toolCalls: ctx.scratchpad.getToolCallRecords(),
            iterations: ctx.iteration,
            totalTime,
            tokenUsage: ctx.tokenCounter.getUsage(),
            tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
          };
          return;
        }
      }
      yield* this.manageContextThreshold(ctx, query, memoryFlushState);

      // Build iteration prompt with full tool results (Anthropic-style)
      currentPrompt = buildIterationPrompt(
        query, 
        ctx.scratchpad.getToolResults(),
        ctx.scratchpad.formatToolUsageForPrompt()
      );
    }

    // Max iterations reached with no final response
    const totalTime = Date.now() - ctx.startTime;
    yield {
      type: 'done',
      answer: `Reached maximum iterations (${this.maxIterations}). I was unable to complete the research in the allotted steps.`,
      toolCalls: ctx.scratchpad.getToolCallRecords(),
      iterations: ctx.iteration,
      totalTime,
      tokenUsage: ctx.tokenCounter.getUsage(),
      tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
    };
  }

  /**
   * Call the LLM with the current prompt.
   * @param prompt - The prompt to send to the LLM
   * @param useTools - Whether to bind tools (default: true). When false, returns string directly.
   */
  private async callModel(prompt: string, useTools: boolean = true, image?: ImageContent): Promise<{ response: AIMessage | string; usage?: TokenUsage }> {
    const result = await callLlm(prompt, {
      model: this.model,
      systemPrompt: this.systemPrompt,
      tools: useTools ? this.tools : undefined,
      signal: this.signal,
      image,
    });
    return { response: result.response, usage: result.usage };
  }

  /**
   * Emit the response text as the final answer.
   * For time-sensitive recommendation queries:
   * - 結果の中身ベースでevidence判定（ツール名だけでなく）
   * - 有効な current data が不足していれば推薦をブロック
   * - non-personalized なのに personalization 表現が混ざっていれば差し替え
   */
  private async *handleDirectResponse(
    responseText: string,
    ctx: RunContext,
    recommendationIntent?: RecommendationIntent,
    toolResults?: ToolCallResult[],
    failedTools?: string[],
  ): AsyncGenerator<AgentEvent, void> {
    let finalAnswer = responseText;

    if (recommendationIntent?.isTimeSensitive && toolResults && failedTools) {
      const evidence = checkRecommendationEvidence(toolResults, failedTools);

      // Evidence不足チェック: 有効なcurrent dataが2件未満
      if (!evidence.hasSufficientEvidence) {
        finalAnswer = buildEvidenceInsufficientResponse(evidence);
      }
      // Final answer guard: non-personalizedなのにpersonalization表現が混ざっている
      else if (!recommendationIntent.isExplicitlyPersonalized && containsPersonalizationExpressions(finalAnswer)) {
        finalAnswer = buildEvidenceInsufficientResponse(evidence);
      }
    }

    const totalTime = Date.now() - ctx.startTime;
    yield {
      type: 'done',
      answer: finalAnswer,
      toolCalls: ctx.scratchpad.getToolCallRecords(),
      iterations: ctx.iteration,
      totalTime,
      tokenUsage: ctx.tokenCounter.getUsage(),
      tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
    };
  }

  /**
   * Clear oldest tool results if context size exceeds threshold.
   */
  private async *manageContextThreshold(
    ctx: RunContext,
    query: string,
    memoryFlushState: { alreadyFlushed: boolean },
  ): AsyncGenerator<ContextClearedEvent | AgentEvent, void> {
    const fullToolResults = ctx.scratchpad.getToolResults();
    const estimatedContextTokens = estimateTokens(this.systemPrompt + ctx.query + fullToolResults);

    if (estimatedContextTokens > CONTEXT_THRESHOLD) {
      if (
        this.memoryEnabled &&
        shouldRunMemoryFlush({
          estimatedContextTokens,
          alreadyFlushed: memoryFlushState.alreadyFlushed,
        })
      ) {
        yield { type: 'memory_flush', phase: 'start' };
        const flushResult = await runMemoryFlush({
          model: this.model,
          systemPrompt: this.systemPrompt,
          query,
          toolResults: fullToolResults,
          signal: this.signal,
        }).catch(() => ({ flushed: false, written: false as const }));
        memoryFlushState.alreadyFlushed = flushResult.flushed;
        yield {
          type: 'memory_flush',
          phase: 'end',
          filesWritten: flushResult.written ? [`${new Date().toISOString().slice(0, 10)}.md`] : [],
        };
      }

      const clearedCount = ctx.scratchpad.clearOldestToolResults(KEEP_TOOL_USES);
      if (clearedCount > 0) {
        memoryFlushState.alreadyFlushed = false;
        yield { type: 'context_cleared', clearedCount, keptCount: KEEP_TOOL_USES };
      }
    }
  }

  /**
   * Build initial prompt with conversation history context.
   * Uses InMemoryChatHistory if available, falls back to ThreadStore turns.
   */
  private buildInitialPrompt(
    query: string,
    inMemoryChatHistory?: InMemoryChatHistory,
    threadTurns?: ConversationTurn[],
  ): string {
    // 1. InMemoryChatHistoryがあればそれを使う（既存動作）
    if (inMemoryChatHistory?.hasMessages()) {
      const recentTurns = inMemoryChatHistory.getRecentTurns();
      if (recentTurns.length > 0) {
        // ThreadStoreのturnsも補完的に注入（InMemoryChatHistoryのsummaryが空の場合の保険）
        const threadContext = this.buildThreadContext(threadTurns);
        const historyContext = buildHistoryContext({
          entries: recentTurns,
          currentMessage: query,
        });
        if (threadContext) {
          return `${threadContext}\n\n${historyContext}`;
        }
        return historyContext;
      }
    }

    // 2. InMemoryChatHistoryが空 → ThreadStoreからフォールバック
    const threadContext = this.buildThreadContext(threadTurns);
    if (threadContext) {
      return buildHistoryContext({
        entries: [],
        currentMessage: query,
      }).replace('[Current message - respond to this]', `${threadContext}\n\n[Current message - respond to this]`);
    }

    return query;
  }

  /**
   * ThreadStoreのturnsから会話コンテキストを構築
   */
  private buildThreadContext(threadTurns?: ConversationTurn[]): string | null {
    if (!threadTurns || threadTurns.length === 0) return null;

    // 直近6ターンのうち、最新3ターンはfull、残りはsummary
    const lines = threadTurns.map((turn, i) => {
      const isRecent = i >= threadTurns.length - 3;
      const assistantText = isRecent
        ? turn.assistantMessage
        : (turn.assistantSummary ?? turn.assistantMessage.slice(0, 500));
      return `User: ${turn.userMessage}\nAssistant: ${assistantText}`;
    });

    return `[Thread history (from persistent store)]\n${lines.join('\n\n')}`;
  }
}
