/**
 * Post-switch compaction orchestration.
 *
 * The gateway reports a key/provider/model switch as soon as the upstream
 * response is written, while the agent may still be finishing its turn.
 * Compaction rewrites the conversation context, so this helper waits for the
 * agent to go idle and then calls the backend's **existing** `compact()`
 * entry point — the same `/compact` path. It does not implement, replace or
 * tune any compaction logic.
 */

import { buildCompactionSummaryParams } from '@craft-agent/shared/agent/compaction-summary';

export interface PostSwitchCompactSession {
  agent?: {
    isProcessing(): boolean;
    /**
     * Backend hook that delegates to the native compaction path. Optional:
     * a backend without one simply opts out.
     */
    compact?(): Promise<{
      tokensBefore: number;
      tokensAfter: number;
      /** Backend-reported accounting for the summary row. */
      stats?: unknown;
    } | null>;
  } | null;
  workspace: { id: string };
}

export interface PostSwitchCompactEvent {
  type: 'info';
  sessionId: string;
  message: string;
  statusType: string;
  statusParams: Record<string, unknown>;
}

export interface PostSwitchCompactDeps {
  getSession(sessionId: string): PostSwitchCompactSession | undefined;
  sendEvent(event: PostSwitchCompactEvent, workspaceId: string): void;
  log(message: string): void;
}

/**
 * Run one compaction after a route switch, once the session is idle.
 *
 * `running` coalesces concurrent notifications: several switches during one
 * turn produce a single compaction, and a second notification while it runs is
 * a no-op.
 */
export function schedulePostSwitchCompaction(
  deps: PostSwitchCompactDeps,
  sessionId: string,
  reason: 'key' | 'model' | 'both',
  running: Map<string, Promise<void>>,
): void {
  if (running.has(sessionId)) return;

  const task = (async () => {
    // Bounded wait (2 minutes). A turn longer than that finishes without a
    // compaction; the next switch schedules a fresh one, so nothing is lost.
    for (let i = 0; i < 120; i++) {
      const managed = deps.getSession(sessionId);
      if (!managed?.agent) return;
      if (!managed.agent.isProcessing()) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const managed = deps.getSession(sessionId);
    if (!managed?.agent?.compact || managed.agent.isProcessing()) return;

    try {
      const result = await managed.agent.compact();
      if (!result) return;

      const stats = result.stats as
        | { before?: number; retained?: number; compacted?: number; checkpoint?: number; viaRelief?: boolean }
        | undefined;
      const before = stats?.before ?? result.tokensBefore;
      const after = result.tokensAfter;
      const reasonLabel =
        reason === 'key' ? '切换 key 后' : reason === 'model' ? '切换模型后' : '切换 key/模型后';

      deps.sendEvent(
        {
          type: 'info',
          sessionId,
          message: `已压缩会话上下文（${reasonLabel}）`,
          statusType: 'compaction_complete',
          statusParams: { tokens: before.toLocaleString() },
        },
        managed.workspace.id,
      );

      if (before > 0) {
        // Same accounting as the /compact and auto paths (see
        // buildCompactionSummaryParams): the arrow target is the SDK's real
        // post-compaction size, and retained is derived from it so the row
        // adds up and matches the context ring.
        const summaryParams = buildCompactionSummaryParams({
          tokensBefore: before,
          estimatedTokensAfter: after,
          retained: stats?.retained,
          checkpoint: stats?.checkpoint,
          viaRelief: stats?.viaRelief,
        });
        if (summaryParams) {
          deps.sendEvent(
            {
              type: 'info',
              sessionId,
              message: 'Compaction summary',
              statusType: 'compaction_summary',
              statusParams: summaryParams,
            },
            managed.workspace.id,
          );
        }
      }
    } catch (error) {
      // Best-effort: a failed compaction must not break the session, and the
      // numeric budget simply stays as it was.
      deps.log(
        `Post-switch compaction failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })().finally(() => {
    running.delete(sessionId);
  });

  running.set(sessionId, task);
}
