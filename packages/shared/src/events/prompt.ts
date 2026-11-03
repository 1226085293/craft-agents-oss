/**
 * Event Center prompt block.
 *
 * Lists the listeners that are enabled in this workspace so the agent knows
 * what it *could* subscribe to. Kept to a handful of lines: it rides in every
 * system prompt of the session, and an empty block is omitted entirely.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest } from './manifest.ts';

export interface EventPromptEntry {
  id: string;
  name: string;
  eventTypes: string[];
}

/** Read enabled listeners straight from disk (no supervisor dependency). */
export function readEnabledListeners(workspaceRootPath: string): EventPromptEntry[] {
  const eventsDir = join(workspaceRootPath, 'events');
  if (!existsSync(eventsDir)) return [];

  let enabledIds: string[] = [];
  try {
    const statePath = join(workspaceRootPath, 'events-data', 'listeners.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
        listeners?: Record<string, { enabled?: boolean }>;
      };
      enabledIds = Object.entries(state.listeners ?? {})
        .filter(([, value]) => value?.enabled === true)
        .map(([id]) => id);
    }
  } catch {
    return [];
  }
  if (enabledIds.length === 0) return [];

  const entries: EventPromptEntry[] = [];
  for (const entry of readdirSync(eventsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !enabledIds.includes(entry.name)) continue;
    const manifestPath = join(eventsDir, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const parsed = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), entry.name);
      if (!parsed.ok || !parsed.manifest) continue;
      entries.push({
        id: parsed.manifest.id,
        name: parsed.manifest.name,
        eventTypes: parsed.manifest.eventTypes,
      });
    } catch {
      // A broken manifest is the registry's problem to report, not the prompt's.
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Format the block. Returns '' when nothing is enabled — the caller appends it
 * unconditionally.
 */
export function formatEventsBlock(entries: EventPromptEntry[]): string {
  if (entries.length === 0) return '';

  const lines = entries.map((entry) => {
    const types = entry.eventTypes.length ? entry.eventTypes.join(', ') : '(any)';
    return `- ${entry.name}（\`${entry.id}\`）→ ${types}`;
  });

  return [
    '',
    '## 事件',
    '',
    '以下事件监听器已启用。默认你**不会**收到任何事件；需要时用 `subscribe_event` 订阅：',
    '',
    ...lines,
    '',
    '订阅后事件会以 `[event]` 开头的隐藏消息送达，并唤醒本会话；用 `get_event("<id>")` 读全文，`unsubscribe_event` 取消。',
  ].join('\n');
}

/** Convenience: read + format in one call. */
export function buildEventsBlock(workspaceRootPath: string | undefined): string {
  if (!workspaceRootPath) return '';
  try {
    return formatEventsBlock(readEnabledListeners(workspaceRootPath));
  } catch {
    return '';
  }
}
