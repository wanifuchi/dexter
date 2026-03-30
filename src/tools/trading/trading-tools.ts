/**
 * Phase 1 トレーディングツール群
 * チャットからポートフォリオ管理・アラート設定・シグナル検出・通知を操作
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { loadPortfolio, addPosition, removePosition } from './portfolio-store.js';
import {
  loadAlertStore,
  addAlertRule,
  removeAlertRule,
  toggleAlertRule,
} from './alert-store.js';
import { loadWatchlist, addToWatchlist, removeFromWatchlist } from './watchlist-store.js';
import { addLearningEntry, updateInvestmentStyle, loadLearning } from './learning-engine.js';
import { sendMessageLine, isLineAvailable } from '../../gateway/channels/line/index.js';
import type { AccountType, AlertCondition, NotificationChannel } from './types.js';

// ---------- ポートフォリオ管理 ----------

const AccountTypeEnum = z.enum([
  'sbi-nisa', 'sbi-tokutei', 'rakuten-nisa', 'rakuten-tokutei',
]);

export const portfolioManager = new DynamicStructuredTool({
  name: 'portfolio_manager',
  description: `保有銘柄（ポートフォリオ）の登録・削除・一覧表示。
口座はsbi-nisa, sbi-tokutei, rakuten-nisa, rakuten-tokuteiの4種類。`,
  schema: z.object({
    action: z.enum(['list', 'add', 'remove']).describe('操作種別'),
    ticker: z.string().optional().describe('銘柄コード (例: 8306, AAPL)'),
    name: z.string().optional().describe('銘柄名 (例: 三菱UFJ)'),
    shares: z.number().optional().describe('保有株数'),
    avgCost: z.number().optional().describe('平均取得単価'),
    account: AccountTypeEnum.optional().describe('口座種別'),
  }),
  func: async (input) => {
    switch (input.action) {
      case 'list': {
        const portfolio = await loadPortfolio();
        return formatToolResult({
          positionCount: portfolio.positions.length,
          positions: portfolio.positions,
          updatedAt: new Date(portfolio.updatedAt).toISOString(),
        });
      }
      case 'add': {
        if (!input.ticker || !input.shares || !input.avgCost || !input.account) {
          return formatToolResult({ error: 'ticker, shares, avgCost, accountは必須です' });
        }
        const portfolio = await addPosition({
          ticker: input.ticker,
          name: input.name ?? input.ticker,
          shares: input.shares,
          avgCost: input.avgCost,
          account: input.account as AccountType,
          addedAt: Date.now(),
        });
        return formatToolResult({
          message: `${input.ticker}を追加しました`,
          positionCount: portfolio.positions.length,
        });
      }
      case 'remove': {
        if (!input.ticker) {
          return formatToolResult({ error: 'tickerは必須です' });
        }
        const portfolio = await removePosition(input.ticker, input.account as AccountType | undefined);
        return formatToolResult({
          message: `${input.ticker}を削除しました`,
          positionCount: portfolio.positions.length,
        });
      }
    }
  },
});

export const PORTFOLIO_MANAGER_DESCRIPTION = `保有銘柄（ポートフォリオ）の管理ツール。
銘柄の登録・削除・一覧表示が可能。口座種別（SBI NISA/一般、楽天NISA/一般）を区別して管理。
- list: 全保有銘柄の一覧を表示
- add: 銘柄を追加（ticker, name, shares, avgCost, accountが必要）
- remove: 銘柄を削除`;

// ---------- アラートルール管理 ----------

const AlertConditionEnum = z.enum([
  'price_above', 'price_below',
  'dividend_yield_above',
  'per_below', 'pbr_below',
  'change_pct_above', 'change_pct_below',
]);

export const alertManager = new DynamicStructuredTool({
  name: 'alert_manager',
  description: `株価アラートルールの作成・削除・一覧・有効/無効切替。
条件: price_above/below, dividend_yield_above, per_below, pbr_below, change_pct_above/below`,
  schema: z.object({
    action: z.enum(['list', 'add', 'remove', 'toggle']).describe('操作種別'),
    ticker: z.string().optional().describe('銘柄コード'),
    name: z.string().optional().describe('銘柄名'),
    condition: AlertConditionEnum.optional().describe('アラート条件'),
    threshold: z.number().optional().describe('閾値'),
    ruleId: z.string().optional().describe('ルールID（remove/toggle用）'),
    enabled: z.boolean().optional().describe('有効/無効（toggle用）'),
  }),
  func: async (input) => {
    switch (input.action) {
      case 'list': {
        const store = await loadAlertStore();
        return formatToolResult({
          ruleCount: store.rules.length,
          rules: store.rules.map((r) => ({
            ...r,
            createdAt: new Date(r.createdAt).toISOString(),
            lastTriggeredAt: r.lastTriggeredAt ? new Date(r.lastTriggeredAt).toISOString() : null,
          })),
        });
      }
      case 'add': {
        if (!input.ticker || !input.condition || input.threshold === undefined) {
          return formatToolResult({ error: 'ticker, condition, thresholdは必須です' });
        }
        const rule = await addAlertRule({
          ticker: input.ticker,
          name: input.name,
          condition: input.condition as AlertCondition,
          threshold: input.threshold,
        });
        return formatToolResult({ message: `アラートルールを作成しました`, rule });
      }
      case 'remove': {
        if (!input.ruleId) {
          return formatToolResult({ error: 'ruleIdは必須です' });
        }
        const removed = await removeAlertRule(input.ruleId);
        return formatToolResult({
          message: removed ? 'ルールを削除しました' : 'ルールが見つかりません',
        });
      }
      case 'toggle': {
        if (!input.ruleId || input.enabled === undefined) {
          return formatToolResult({ error: 'ruleIdとenabledは必須です' });
        }
        const rule = await toggleAlertRule(input.ruleId, input.enabled);
        return formatToolResult({
          message: rule ? `ルールを${input.enabled ? '有効' : '無効'}にしました` : 'ルールが見つかりません',
        });
      }
    }
  },
});

export const ALERT_MANAGER_DESCRIPTION = `株価アラートルールの管理。
自然言語の条件を適切なcondition/thresholdに変換して登録。
例: 「三菱UFJが1400円超えたら教えて」→ ticker:8306, condition:price_above, threshold:1400
例: 「配当利回り5%以上のアラート」→ condition:dividend_yield_above, threshold:5`;

// ---------- 通知送信ツール ----------

export const sendNotification = new DynamicStructuredTool({
  name: 'send_notification',
  description: 'WhatsAppまたはLINE（または両方）にメッセージを送信する通知ツール',
  schema: z.object({
    message: z.string().describe('送信するメッセージ本文'),
    channel: z.enum(['whatsapp', 'line', 'both']).default('both').describe('通知先'),
  }),
  func: async (input) => {
    const results: Record<string, unknown> = {};
    const channel = input.channel as NotificationChannel;

    if (channel === 'line' || channel === 'both') {
      if (isLineAvailable()) {
        const lineResult = await sendMessageLine({ body: input.message });
        results.line = lineResult;
      } else {
        results.line = { success: false, error: 'LINE未設定（LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_IDが必要）' };
      }
    }

    if (channel === 'whatsapp' || channel === 'both') {
      // WhatsAppはCron executor経由で送信されるので、ここではスキップ
      results.whatsapp = { note: 'WhatsAppはCronジョブ経由で自動送信されます' };
    }

    return formatToolResult(results);
  },
});

export const SEND_NOTIFICATION_DESCRIPTION = `WhatsAppやLINEにメッセージを送信。
シグナル検出結果やアラート通知をユーザーに配信する際に使用。
channel: 'whatsapp', 'line', 'both' を指定可能。`;

// ---------- ウォッチリスト管理 ----------

export const watchlistManager = new DynamicStructuredTool({
  name: 'watchlist_manager',
  description: `ウォッチリスト（監視銘柄）の追加・削除・一覧表示。
保有していないが監視したい銘柄を管理する。`,
  schema: z.object({
    action: z.enum(['list', 'add', 'remove']).describe('操作種別'),
    ticker: z.string().optional().describe('銘柄コード'),
    name: z.string().optional().describe('銘柄名'),
    note: z.string().optional().describe('メモ（監視理由など）'),
  }),
  func: async (input) => {
    switch (input.action) {
      case 'list': {
        const wl = await loadWatchlist();
        return formatToolResult({
          itemCount: wl.items.length,
          items: wl.items,
        });
      }
      case 'add': {
        if (!input.ticker) return formatToolResult({ error: 'tickerは必須です' });
        const wl = await addToWatchlist({
          ticker: input.ticker,
          name: input.name ?? input.ticker,
          note: input.note,
        });
        return formatToolResult({ message: `${input.ticker}をウォッチリストに追加しました`, itemCount: wl.items.length });
      }
      case 'remove': {
        if (!input.ticker) return formatToolResult({ error: 'tickerは必須です' });
        const wl = await removeFromWatchlist(input.ticker);
        return formatToolResult({ message: `${input.ticker}をウォッチリストから削除しました`, itemCount: wl.items.length });
      }
    }
  },
});

export const WATCHLIST_MANAGER_DESCRIPTION = `ウォッチリスト（監視銘柄）の管理。
保有していないが気になる銘柄を登録・削除・一覧表示。
例: 「TSLAをウォッチリストに追加して」「ウォッチリスト見せて」`;

// ---------- 学習エンジン ----------

export const learningTool = new DynamicStructuredTool({
  name: 'learning_engine',
  description: `ユーザーの投資スタイル・フィードバック・教訓を記録する学習ツール。
ユーザーが投資判断についてフィードバックを与えた時、好みを表明した時、
失敗や成功から得た教訓を共有した時に自動的に呼び出す。`,
  schema: z.object({
    action: z.enum(['record', 'update_style', 'view']).describe('操作'),
    type: z.enum(['preference', 'feedback', 'lesson', 'style', 'bias_alert']).optional().describe('記録タイプ'),
    content: z.string().optional().describe('学習内容'),
    context: z.string().optional().describe('文脈'),
    // update_style用
    riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).optional(),
    timeHorizon: z.enum(['short', 'medium', 'long']).optional(),
    preferredSectors: z.array(z.string()).optional(),
    avoidSectors: z.array(z.string()).optional(),
    preferredStrategies: z.array(z.string()).optional(),
    note: z.string().optional(),
  }),
  func: async (input) => {
    switch (input.action) {
      case 'record': {
        if (!input.content || !input.type) return formatToolResult({ error: 'typeとcontentは必須' });
        await addLearningEntry({ type: input.type, content: input.content, context: input.context });
        return formatToolResult({ message: '学習データを記録しました', content: input.content });
      }
      case 'update_style': {
        const updates: any = {};
        if (input.riskTolerance) updates.riskTolerance = input.riskTolerance;
        if (input.timeHorizon) updates.timeHorizon = input.timeHorizon;
        if (input.preferredSectors) updates.preferredSectors = input.preferredSectors;
        if (input.avoidSectors) updates.avoidSectors = input.avoidSectors;
        if (input.preferredStrategies) updates.preferredStrategies = input.preferredStrategies;
        if (input.note) {
          const store = await loadLearning();
          updates.notes = [...store.investmentStyle.notes, input.note];
        }
        await updateInvestmentStyle(updates);
        return formatToolResult({ message: '投資スタイルを更新しました' });
      }
      case 'view': {
        const store = await loadLearning();
        return formatToolResult({
          entryCount: store.entries.length,
          investmentStyle: store.investmentStyle,
          recentEntries: store.entries.slice(-10),
        });
      }
    }
  },
});

export const LEARNING_ENGINE_DESCRIPTION = `ユーザーの投資スタイルとフィードバックを学習・記録するツール。
以下の場面で自動的に使用する:
- ユーザーが「この分析は良かった/悪かった」とフィードバックした時 → record(feedback)
- ユーザーが投資の好みを表明した時（例: 「高配当が好き」「テック重視」）→ record(preference) or update_style
- 投資判断の失敗/成功から得た教訓 → record(lesson)
- ユーザーが認知バイアスに陥っている可能性がある時 → record(bias_alert)
学習データは次回以降の対話で自動的に参照され、ユーザーに最適化された提案に活かされる。`;
