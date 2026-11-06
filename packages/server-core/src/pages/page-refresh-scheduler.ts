/**
 * Scheduled page refresh loop.
 *
 * One minute tick, one question: which pages are due? Then run their refresh
 * script through the same hardened runner page actions use. No model, no
 * session — a data refresh must never cost tokens.
 *
 * The loop is intentionally dumb: `duePageRefreshes` does the cron matching,
 * this only owns the timer and the run.
 */

import { createLogger } from '@craft-agent/shared/utils';
import { duePageRefreshes, executeScriptAction, buildBaseScriptEnv } from '@craft-agent/shared/pages';
import { loadWorkspacePages } from '@craft-agent/shared/pages/storage';

const log = createLogger('page-refresh');

export const PAGE_REFRESH_INTERVAL_MS = 60_000;

export interface PageRefreshDeps {
  workspaceRootPath: string;
  now?: () => Date;
}

/** Run every page whose refresh spec is due in `at`'s minute. Returns the count started. */
export async function runPageRefreshPass(deps: PageRefreshDeps, at: Date): Promise<number> {
  const pages = loadWorkspacePages(deps.workspaceRootPath);
  const due = duePageRefreshes(pages, at);
  let started = 0;

  for (const { pageSlug, refresh } of due) {
    const env = buildBaseScriptEnv({ workspaceRootPath: deps.workspaceRootPath, page: pageSlug });
    try {
      const result = await executeScriptAction(
        {
          type: 'script',
          script: refresh.script,
          ...(refresh.args ? { args: refresh.args } : {}),
          ...(refresh.runtime ? { runtime: refresh.runtime } : {}),
          ...(refresh.timeoutMs ? { timeoutMs: refresh.timeoutMs } : {}),
          // Marks the run as a scheduled refresh (recordPageRefresh writes the
          // page's completion marker); an on-demand run must not set this.
          page: pageSlug,
        },
        { workspaceRootPath: deps.workspaceRootPath, env },
      );
      if (!result.success) {
        log.warn(`[page-refresh] ${pageSlug} failed`, { exitCode: result.exitCode });
      }
      started += 1;
    } catch (error) {
      log.warn(`[page-refresh] ${pageSlug} could not run`, { error });
    }
  }

  return started;
}

/**
 * Start the loop. Returns a disposer.
 *
 * `unref` so a pending timer never keeps the host process alive on shutdown.
 */
export function startPageRefreshScheduler(deps: PageRefreshDeps, intervalMs = PAGE_REFRESH_INTERVAL_MS): () => void {
  let lastMinute = '';
  const timer = setInterval(() => {
    const now = (deps.now ?? (() => new Date()))();
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    // A slow tick must not double-fire the same minute.
    if (minute === lastMinute) return;
    lastMinute = minute;
    void runPageRefreshPass(deps, now).catch((error) => {
      log.warn('[page-refresh] pass failed', { error });
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
