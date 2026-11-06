/**
 * One-way migration: automation cron matchers → task cron triggers.
 *
 * The automation runtime is no longer started (nothing constructs
 * `AutomationSystem`), so a scheduled automation was a config the user could
 * edit and test but never fire. Rather than rebuild a second scheduler, the
 * existing config is imported into the task system, which now owns scheduling.
 *
 * Only cron matchers are imported. App/agent lifecycle matchers (Stop,
 * PreToolUse, SessionStart …) are hooks into a session's own turn — they have no
 * meaning outside a session, so they are left where they are instead of being
 * misrepresented as an external event trigger.
 *
 * Idempotent: each imported task carries `automation:<matcherId>` as its
 * originating tool call, and `TaskService.create` dedupes on that.
 */

import { existsSync, readFileSync } from 'fs';
import { createLogger } from '@craft-agent/shared/utils';
import { resolveAutomationsConfigPath } from '@craft-agent/shared/automations/resolve-config-path';
import { validateAutomationsConfig } from '@craft-agent/shared/automations/validation';
import type { AutomationMatcher, PromptAction } from '@craft-agent/shared/automations/types';
import type { TaskService } from './task-service.ts';

const log = createLogger('tasks');

const MIGRATION_SUPERVISOR = 'automation-migration';

export interface MigrationResult {
  created: number;
  skipped: number;
}

/** Matchers that should become scheduled tasks. */
function cronMatchers(workspaceRoot: string): Array<{ id: string; name: string; matcher: AutomationMatcher; prompt: PromptAction }> {
  const path = resolveAutomationsConfigPath(workspaceRoot);
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    log.warn('[tasks] automations.json is not valid JSON; nothing to migrate');
    return [];
  }

  const result = validateAutomationsConfig(parsed);
  if (!result.valid || !result.config) {
    log.warn('[tasks] automations.json failed validation; nothing to migrate', { errors: result.errors });
    return [];
  }

  const out: Array<{ id: string; name: string; matcher: AutomationMatcher; prompt: PromptAction }> = [];
  for (const [event, matchers] of Object.entries(result.config.automations)) {
    // Only the cron tick maps onto a task trigger. Everything else is a
    // session-lifecycle hook and stays out of the task system.
    if (event !== 'SchedulerTick') continue;
    for (const matcher of matchers ?? []) {
      if (!matcher.cron || matcher.enabled === false) continue;
      const prompt = matcher.actions.find((a): a is PromptAction => a.type === 'prompt');
      if (!prompt) continue;
      out.push({
        id: matcher.id ?? `anon-${out.length}`,
        name: matcher.name ?? prompt.prompt.slice(0, 40),
        matcher,
        prompt,
      });
    }
  }
  return out;
}

/**
 * Import cron automations as tasks.
 *
 * Safe to call on every workspace start: already-imported matchers resolve to
 * the task that was created for them, and nothing is overwritten.
 */
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
      instruction: candidate.prompt.prompt,
      supervisorSessionId: MIGRATION_SUPERVISOR,
      toolCallId,
      trigger: {
        kind: 'cron',
        expr: candidate.matcher.cron!,
        ...(candidate.matcher.timezone ? { timezone: candidate.matcher.timezone } : {}),
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
