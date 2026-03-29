/**
 * アラートルールの永続化ストア
 * Upstash Redis優先、ローカルファイルフォールバック
 */
import { randomBytes } from 'node:crypto';
import { loadAlertStoreKV, saveAlertStoreKV } from './kv-store.js';
import type { AlertRule, AlertStore } from './types.js';

export async function loadAlertStore(): Promise<AlertStore> {
  return loadAlertStoreKV();
}

export async function saveAlertStore(store: AlertStore): Promise<void> {
  await saveAlertStoreKV(store);
}

export async function addAlertRule(rule: Omit<AlertRule, 'id' | 'createdAt' | 'enabled'>): Promise<AlertRule> {
  const store = await loadAlertStore();
  const newRule: AlertRule = {
    ...rule,
    id: randomBytes(6).toString('hex'),
    enabled: true,
    createdAt: Date.now(),
  };
  store.rules.push(newRule);
  await saveAlertStore(store);
  return newRule;
}

export async function removeAlertRule(id: string): Promise<boolean> {
  const store = await loadAlertStore();
  const before = store.rules.length;
  store.rules = store.rules.filter((r) => r.id !== id);
  if (store.rules.length === before) return false;
  await saveAlertStore(store);
  return true;
}

export async function toggleAlertRule(id: string, enabled: boolean): Promise<AlertRule | null> {
  const store = await loadAlertStore();
  const rule = store.rules.find((r) => r.id === id);
  if (!rule) return null;
  rule.enabled = enabled;
  await saveAlertStore(store);
  return rule;
}

export async function markTriggered(id: string): Promise<void> {
  const store = await loadAlertStore();
  const rule = store.rules.find((r) => r.id === id);
  if (rule) {
    rule.lastTriggeredAt = Date.now();
    await saveAlertStore(store);
  }
}
