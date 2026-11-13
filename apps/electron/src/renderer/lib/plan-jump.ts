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

/**
 * Journal STATUS changes for one step, oldest first.
 *
 * A `plan_updated` line is also written when the plan is created (`{ step, removed: false }`, no
 * status) and when an owner is changed. Those edit the plan; they do not move a step. Counting
 * them as movements put a section's jump target at 「计划写入时刻」 — before anything had run — and
 * let a sub-step fall back to an owner edit instead of its last real transition.
 */
function statusChanges(journal: JournalLine[], stepId: string): Array<{ at: number; status: string }> {
  const changes: Array<{ at: number; status: string }> = [];
  for (const line of journal) {
    if (line.type !== 'plan_updated') continue;
    const data = line.data as { step?: string; status?: string; removed?: boolean } | undefined;
    if (!data || data.removed) continue;
    if (data.step !== stepId) continue;
    if (!data.status) continue;
    changes.push({ at: line.at, status: data.status });
  }
  return changes.sort((a, b) => a.at - b.at);
}

/**
 * A placeholder is not a session.
 *
 * `startRun` claims the lock before the worker session exists and names the claim
 * `pending:<reason>`; the real id arrives later, as a `run_bound` line. The first version of this
 * reader looked only at `run_started`, so a step that moved after a claim but before the bind was
 * attributed to `pending:dispatch` — an id nothing can open. Clicking a section then did nothing
 * (or opened the wrong place), which is what 「跳转到的会话是错的」 looked like from the outside.
 */
function isPlaceholder(id: string): boolean {
  return id.startsWith('pending:');
}

interface RunWindow {
  /** When the run claimed the lock — the claim is the moment work began, not the bind. */
  at: number;
  sessionId: string;
}

/**
 * Every run this journal knows about, with the placeholder resolved to the real session.
 *
 * A claim (`pending:…`) followed by `run_bound` is ONE run: the bind supplies the id and the
 * claim supplies the time, so a change that happened between the two is still attributed to the
 * session that was about to do the work.
 */
function runWindows(journal: JournalLine[]): RunWindow[] {
  const runs: RunWindow[] = [];
  let claimedAt: number | undefined;

  for (const line of journal) {
    if (line.type !== 'run_started' && line.type !== 'run_bound') continue;
    const data = line.data as { sessionId?: string } | undefined;
    const sessionId = data?.sessionId;
    if (!sessionId) continue;
    if (isPlaceholder(sessionId)) {
      // Hold the claim until the bind names the session it belongs to.
      if (claimedAt === undefined) claimedAt = line.at;
      continue;
    }
    runs.push({ at: claimedAt ?? line.at, sessionId });
    claimedAt = undefined;
  }
  return runs;
}

/** The session that was running at `at` — the last run to start at or before it. */
function sessionAt(runs: RunWindow[], at: number): string | undefined {
  let found: string | undefined;
  let best = -Infinity;
  for (const run of runs) {
    if (run.at <= at && run.at > best) {
      best = run.at;
      found = run.sessionId;
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

  const runs = runWindows(journal);
  const statement: string | undefined =
    fallbackSessionId && !isPlaceholder(fallbackSessionId) ? fallbackSessionId : undefined;

  for (const step of steps) {
    const changes = statusChanges(journal, step.id);
    const outline = isOutlineId(step.id);

    /**
     * A section that never recorded `doing` still began somewhere.
     *
     * `deriveOutlineStatus` only writes a section's own status when the derived value differs from
     * the stored one, so a plan written with its sections already `todo` and moved by sub-step can
     * reach `done` without ever producing a `doing` line. Falling back to the last change then sent
     * the reader to the END of the section — the one place 「这一节从哪里开始」 is not.
     * The beginning of a section is the earliest thing that happened under it.
     */
    const ownAndChildren = outline
      ? [...changes, ...steps.flatMap((other) =>
          other.id.startsWith(`${step.id}.`) ? statusChanges(journal, other.id) : [],
        )]
      : changes;
    if (ownAndChildren.length === 0) continue;

    // Outline → when it started. Sub-step → when it finished.
    const wanted = outline ? 'doing' : 'done';
    // Last time it entered that state: re-entry (after a pause) should land on
    // the most recent attempt, not the first one years ago.
    const reached = [...changes].reverse().find((change) => change.status === wanted);
    const chosen = reached
      ?? (outline
        ? ownAndChildren.reduce((earliest, change) => (change.at < earliest.at ? change : earliest))
        : changes[changes.length - 1]!);

    const sessionId = sessionAt(runs, chosen.at) ?? statement;
    result.set(step.id, {
      at: chosen.at,
      ...(sessionId ? { sessionId } : {}),
    });
  }

  return result;
}
