/**
 * Scheduled page refresh — selection only.
 *
 * A page may declare `refresh: { cron, script }`. This module answers "which
 * pages are due in this minute?"; running them belongs to server-core, which
 * owns the script runner and the page store.
 *
 * Kept separate from the task scheduler on purpose: a page refresh is a script,
 * not an agent run. Making it a task would burn a session per tick for work that
 * never needs a model.
 */

import type { PageConfig, PageRefreshSpec } from './types.ts';
import { matchesCron } from '../tasks/cron.ts';

export interface DuePageRefresh {
  pageSlug: string;
  refresh: PageRefreshSpec;
}

/** Pages whose refresh spec fires in the minute containing `at`. */
export function duePageRefreshes(
  pages: readonly { config: PageConfig }[],
  at: Date,
): DuePageRefresh[] {
  const due: DuePageRefresh[] = [];
  for (const page of pages) {
    const refresh = page.config.refresh;
    if (!refresh || refresh.enabled === false) continue;
    if (!refresh.cron || !refresh.script) continue;
    if (!matchesCron(refresh.cron, refresh.timezone, at)) continue;
    due.push({ pageSlug: page.config.slug, refresh });
  }
  return due;
}
