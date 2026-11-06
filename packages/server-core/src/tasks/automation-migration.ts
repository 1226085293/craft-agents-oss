/**
 * One-way import: legacy cron automations → task cron triggers.
 *
 * The automation runtime is gone (it never ran: nothing constructed
 * AutomationSystem). This keeps the user's existing schedule alive by turning
 * each `SchedulerTick` cron matcher into a task trigger, once.
 *
 * Only cron + prompt matchers are imported: an app/agent lifecycle matcher is a
 * hook inside a session's own turn, not a task trigger.
 *
 * Idempotent via `automation:<matcherId>` as the originating tool call.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@craft-agent/shared/utils';
import type { TaskService } from './task-service.ts';

const log = createLogger('tasks');

const AUTOMATIONS_FILE = 'automations.json';
const MIGRATION_SUPERVISOR = 'automation-migration';

export interface MigrationResult {
  created: number;
  skipped: number;
}

interface LegacyMatcher {
  id?: unknown;
  name?: unknown;
  cron?: unknown;
  timezone?: unknown;
  enabled?: unknown;
  actions?: unknown;
}

/**
 * Read cron matchers straight from `automations.json`.
 *
 * Plain JSON rather than the old zod schema: the schema lived in the module we
 * deleted, and this reader only needs four fields. Anything malformed is
 * skipped, never guessed.
 */
function cronMatchers(workspaceRoot: string): Array<{
  id: string;
  name: string;
  expr: string;
  timezone?: string;
  prompt: string;
}> {
  const path = join(workspaceRoot, AUTOMATIONS_FILE);
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    log.warn('[tasks] automations.json is not valid JSON; nothing to migrate');
    return [];
  }

  const automations = (parsed as { automations?: Record<string, unknown> } | null)?.automations;
  if (!automations || typeof automations !== 'object') return [];

  const tickMatchers = (automations as Record<string, unknown>).SchedulerTick;
  if (!Array.isArray(tickMatchers)) return [];

  const out: Array<{ id: string; name: string; expr: string; timezone?: string; prompt: string }> = [];
  for (const [index, raw] of tickMatchers.entries()) {
    const matcher = raw as LegacyMatcher;
    if (!matcher || typeof matcher !== 'object') continue;
    if (matcher.enabled === false) continue;
    const expr = typeof matcher.cron === 'string' ? matcher.cron.trim() : '';
    if (!expr) continue;

    const actions = Array.isArray(matcher.actions) ? matcher.actions : [];
    const promptAction = actions.find(
      (a): a is { prompt: string } =>
        Boolean(a) && typeof a === 'object' && (a as { type?: unknown }).type === 'prompt' &&
        typeof (a as { prompt?: unknown }).prompt === 'string',
    );
    if (!promptAction) continue;

    const id = typeof matcher.id === 'string' && matcher.id ? matcher.id : `anon-${index}`;
    const name =
      typeof matcher.name === 'string' && matcher.name.trim()
        ? matcher.name.trim()
        : promptAction.prompt.slice(0, 40);
    const timezone = typeof matcher.timezone === 'string' && matcher.timezone ? matcher.timezone : undefined;

    out.push({ id, name, expr, ...(timezone ? { timezone } : {}), prompt: promptAction.prompt });
  }
  return out;
}

/** Import cron automations as tasks. Safe to call on every workspace start. */
export function migrateAutomationCronTasks(tasks: TaskService, workspaceRoot: string): MigrationResult {
  const candidates = cronMatchers(workspaceRoot);
  if (!candidates.length) return { created: 0, skipped: 0 };

  let created = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const toolCallId = `automation:${candidate.id}`;
    const existing = tasks
      .list()
      .find((task) => task.origin.toolCallId === toolCallId && task.origin.supervisorSessionId === MIGRATION_SUPERVISOR);

    if (existing) {
      skipped += 1;
      continue;
    }

    tasks.create({
      name: candidate.name,
      instruction: candidate.prompt,
      supervisorSessionId: MIGRATION_SUPERVISOR,
      toolCallId,
      trigger: {
        kind: 'cron',
        expr: candidate.expr,
        ...(candidate.timezone ? { timezone: candidate.timezone } : {}),
        enabled: true,
        sourceId: candidate.id,
      },
    });
    created += 1;
  }

  if (created > 0) {
    log.info(`[tasks] imported ${created} cron automation(s) as tasks (${skipped} already present)`);
  }
  return { created, skipped };
}
