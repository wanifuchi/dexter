/**
 * アラートルールの永続化ストア
 * .dexter/trading/alert-rules.json に保存
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dexterPath } from '../../utils/paths.js';
import type { AlertRule, AlertStore } from './types.js';

const ALERT_RULES_PATH = dexterPath('trading', 'alert-rules.json');

function emptyStore(): AlertStore {
  return { version: 1, rules: [] };
}

export function loadAlertStore(): AlertStore {
  if (!existsSync(ALERT_RULES_PATH)) return emptyStore();
  try {
    return JSON.parse(readFileSync(ALERT_RULES_PATH, 'utf-8'));
  } catch {
    return emptyStore();
  }
}

export function saveAlertStore(store: AlertStore): void {
  const dir = dirname(ALERT_RULES_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(ALERT_RULES_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

export function addAlertRule(rule: Omit<AlertRule, 'id' | 'createdAt' | 'enabled'>): AlertRule {
  const store = loadAlertStore();
  const newRule: AlertRule = {
    ...rule,
    id: randomBytes(6).toString('hex'),
    enabled: true,
    createdAt: Date.now(),
  };
  store.rules.push(newRule);
  saveAlertStore(store);
  return newRule;
}

export function removeAlertRule(id: string): boolean {
  const store = loadAlertStore();
  const before = store.rules.length;
  store.rules = store.rules.filter((r) => r.id !== id);
  if (store.rules.length === before) return false;
  saveAlertStore(store);
  return true;
}

export function toggleAlertRule(id: string, enabled: boolean): AlertRule | null {
  const store = loadAlertStore();
  const rule = store.rules.find((r) => r.id === id);
  if (!rule) return null;
  rule.enabled = enabled;
  saveAlertStore(store);
  return rule;
}

export function markTriggered(id: string): void {
  const store = loadAlertStore();
  const rule = store.rules.find((r) => r.id === id);
  if (rule) {
    rule.lastTriggeredAt = Date.now();
    saveAlertStore(store);
  }
}
