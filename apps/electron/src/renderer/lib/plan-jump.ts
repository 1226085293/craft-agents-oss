/**
 * Where in a session does a plan step come from?
 *
 * The task journal already records both things needed:
 *
 *   `plan_updated { step, status }` — when a step moved, and to what
 *   `run_started  { sessionId }`    — which session was running at that time
 *
 * So the answer is derivable from data rather than guessed from the transcript.
 *
 * The two step kinds answer different questions, and the difference is the point:
 *
 *   - an outline (`1`) is a section. Clicking it should show where that section
 *     STARTED — the moment it moved to `doing` — because that is where its work
 *     begins.
 *   - a sub-step (`1.2`) is a unit of finished work. Clicking it should show the
 *     moment it became `done`, because that is where its evidence is.
 *
 * A step that never reached the relevant status has no target; the row stays
 * inert instead of jumping somewhere arbitrary.
 */

export interface JournalLine {
  at: number;
  type: string;
  data?: unknown;
}

export interface PlanJumpTarget {
  /** Epoch ms to land on. */
  at: number;
  /** Session that was running then, when the journal names one. */
  sessionId?: string;
}

function isOutlineId(id: string): boolean {
  return !id.includes('.');
}

/** Journal status changes for one step, oldest first. */
function statusChanges(journal: JournalLine[], stepId: string): Array<{ at: number; status?: string }> {
  const changes: Array<{ at: number; status?: string }> = [];
  for (const line of journal) {
    if (line.type !== 'plan_updated') continue;
    const data = line.data as { step?: string; status?: string; removed?: boolean } | undefined;
    if (!data || data.removed) continue;
    if (data.step !== stepId) continue;
    changes.push({ at: line.at, ...(data.status ? { status: data.status } : {}) });
  }
  return changes.sort((a, b) => a.at - b.at);
}

/** The session that was running at `at` — the last run to start at or before it. */
function sessionAt(journal: JournalLine[], at: number): string | undefined {
  let found: string | undefined;
  let best = -Infinity;
  for (const line of journal) {
    if (line.type !== 'run_started') continue;
    const data = line.data as { sessionId?: string } | undefined;
    if (!data?.sessionId) continue;
    if (line.at <= at && line.at > best) {
      best = line.at;
      found = data.sessionId;
    }
  }
  return found;
}

/**
 * Resolve a jump target for every step in the plan.
 *
 * Returns a map keyed by step id; steps without a usable moment are absent.
 */
export function resolvePlanJumps(
  steps: Array<{ id: string; status: string }> | undefined,
  journal: JournalLine[] | undefined,
  fallbackSessionId?: string,
): Map<string, PlanJumpTarget> {
  const result = new Map<string, PlanJumpTarget>();
  if (!steps?.length || !journal?.length) return result;

  for (const step of steps) {
    const changes = statusChanges(journal, step.id);
    if (changes.length === 0) continue;

    // Outline → when it started. Sub-step → when it finished.
    const wanted = isOutlineId(step.id) ? 'doing' : 'done';
    // Last time it entered that state: re-entry (after a pause) should land on
    // the most recent attempt, not the first one years ago.
    const reached = [...changes].reverse().find((change) => change.status === wanted);
    const chosen = reached ?? changes[changes.length - 1]!;

    const sessionId = sessionAt(journal, chosen.at) ?? fallbackSessionId;
    result.set(step.id, {
      at: chosen.at,
      ...(sessionId ? { sessionId } : {}),
    });
  }

  return result;
}
