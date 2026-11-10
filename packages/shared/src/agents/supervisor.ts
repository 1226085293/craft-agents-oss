/**
 * Supervisor coordination.
 *
 * The supervisor is a session with a pruned tool table, not a separate runtime.
 * What lives here are the guards that make "a session that dispatches work"
 * safe: a per-turn fan-out cap, a delegation-depth cap, duplicate suppression,
 * and an event queue that cannot grow without bound.
 *
 * Nothing in this file calls a model. Routing decisions belong to the
 * supervisor session; every deterministic rule belongs here.
 *
 * There is deliberately **no per-turn time cap**. One existed (300s, then
 * convertible into a task on expiry) and it did more harm than good: it forced a
 * second mechanism — turn-to-task conversion plus a backoff streak — to clean up
 * after a turn the supervisor could have simply finished, and the turn it killed
 * was usually one that had already dispatched its work. What remains for a stuck
 * turn is the stall watchdog: a turn that stops producing activity is closed,
 * which is the failure mode that actually needs guarding. A turn that keeps
 * working is allowed to keep working.
 */

/** Max dispatches a single supervisor turn may fan out to. */
export const MAX_DISPATCHES_PER_TURN = 3;

/** supervisor 0 → worker 1 → sub-worker 2. Deeper is refused. */
export const MAX_SPAWN_DEPTH = 2;

/** How many unclaimed events may queue before they get merged. */
export const MAX_QUEUED_EVENTS = 20;

/** Two sessions ping-ponging similar text this many times is a loop. */
export const PING_PONG_LIMIT = 2;

/** Similarity above which two messages count as "the same thing". */
export const PING_PONG_SIMILARITY = 0.9;

export class DispatchRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'DispatchRefused';
  }
}

/**
 * Per-session bookkeeping for the guards. Lives in the supervisor's runtime,
 * reset at the start of every turn.
 */
/**
 * A side effect a turn defers to its end.
 *
 * A turn is one decision, and starting someone else's work in the middle of writing that
 * decision makes the supervisor reason about a world it has already changed. The queue holds
 * the resolved action — the target is already known, so nothing is re-decided later — and
 * lives on the turn state, which is disposed exactly when the turn is.
 */
export type QueuedActivation =
  | { kind: 'send'; sessionId: string; message: string }
  | {
      kind: 'spawn';
      name?: string;
      agentId?: string;
      scope: string;
      instruction: string;
      taskId?: string;
      spawnDepth: number;
    };

export interface SupervisorTurnState {
  dispatchesThisTurn: number;
  /** Actions this turn asked for, in order; drained once when the turn ends. */
  queuedActivations: QueuedActivation[];
  /** sessionId → normalized instruction of the last thing we sent it. */
  lastInstructionBySession: Map<string, string>;
  /** sessionId → how many consecutive times we sent it near-identical text. */
  repeatedSendCount: Map<string, number>;
}

export function newTurnState(): SupervisorTurnState {
  return {
    dispatchesThisTurn: 0,
    queuedActivations: [],
    lastInstructionBySession: new Map(),
    repeatedSendCount: new Map(),
  };
}

/** Normalize for comparison: drop whitespace/punctuation, keep the substance. */
export function normalizeInstruction(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？；：、,.!?;:'"“”‘’()（）\[\]【】]/g, '')
    .slice(0, 80);
}

/** Cheap similarity: shared prefix ratio over the normalized strings. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) break;
    same += 1;
  }
  return same / max;
}

/**
 * Guard a dispatch before it happens.
 *
 * @throws DispatchRefused with a message the supervisor can act on.
 */
export function assertDispatchAllowed(params: {
  state: SupervisorTurnState;
  spawnDepth: number;
  targetKey: string;
  instruction: string;
  parallel: boolean;
}): void {
  const { state, spawnDepth, targetKey, instruction, parallel } = params;

  if (spawnDepth >= MAX_SPAWN_DEPTH) {
    throw new DispatchRefused(
      `Delegation depth limit reached (${spawnDepth}/${MAX_SPAWN_DEPTH}). Do this work here or report it to the user.`,
    );
  }

  if (parallel && state.dispatchesThisTurn >= MAX_DISPATCHES_PER_TURN) {
    throw new DispatchRefused(
      `At most ${MAX_DISPATCHES_PER_TURN} parallel dispatches per turn. Wait for one to report back.`,
    );
  }

  const normalized = normalizeInstruction(instruction);
  const previous = state.lastInstructionBySession.get(targetKey);
  if (previous) {
    const score = similarity(previous, normalized);
    if (score >= PING_PONG_SIMILARITY) {
      const count = (state.repeatedSendCount.get(targetKey) ?? 0) + 1;
      state.repeatedSendCount.set(targetKey, count);
      if (count >= PING_PONG_LIMIT) {
        throw new DispatchRefused(
          `Refusing to send the same instruction to ${targetKey} again (${count}×). Escalate to the user or change the approach.`,
        );
      }
    } else {
      // Different work: reset the streak, then count this send as the first.
      state.repeatedSendCount.set(targetKey, 1);
    }
  }
  state.lastInstructionBySession.set(targetKey, normalized);
  state.dispatchesThisTurn += 1;
}

/**
 * Queue for events that arrive while no supervisor exists or while it is busy.
 *
 * Events are merged rather than dropped: the supervisor is told "there are N
 * pending" instead of being woken N times, which is what keeps a noisy source
 * from spending a turn per message.
 */
export class EventBacklog {
  private items: Array<{ id: string; summary: string }> = [];
  /** Running total of events dropped by the cap, reported in the next nudge. */
  private overflowed = 0;

  push(item: { id: string; summary: string }): void {
    if (this.items.some((existing) => existing.id === item.id)) return;
    if (this.items.length >= MAX_QUEUED_EVENTS) {
      // Drop the oldest, but keep counting: the supervisor must know that the
      // queue existed, not just how big it currently is.
      this.items.shift();
      this.overflowed += 1;
    }
    this.items.push(item);
  }

  /** Hand everything over and reset — the supervisor drains in one turn. */
  drain(): Array<{ id: string; summary: string }> {
    const items = this.items;
    const dropped = this.overflowed;
    this.items = [];
    this.overflowed = 0;
    const head = items[0];
    if (dropped > 0 && head) {
      items[0] = {
        ...head,
        summary: `（另有 ${dropped} 条较早事件已合并）${head.summary}`,
      };
    }
    return items;
  }

  get size(): number {
    return this.items.length;
  }
}

/** One-line descriptor the supervisor gets instead of a full event body. */
export function formatBacklogNudge(items: Array<{ id: string; summary: string }>): string {
  if (items.length === 0) return '';
  // Name the tool explicitly. The summary alone is not enough to act on, and a
  // supervisor that has to discover `get_event` by trial and error spends its
  // whole turn cap on category expansion instead of handling the event.
  const readHint = '读全文：call_tool get_event({"id": "<上面的 id>"})（分层模式下先展开 tools_workspace）';
  if (items.length === 1) {
    const only = items[0];
    if (only) {
      return `有一条未处理的事件：${only.summary}（id: ${only.id}）\n${readHint}`;
    }
  }
  return [
    `有 ${items.length} 条未处理的事件：`,
    ...items.slice(0, 10).map((item) => `- ${item.summary}（id: ${item.id}）`),
    items.length > 10 ? `…以及 ${items.length - 10} 条` : '',
    readHint,
  ]
    .filter(Boolean)
    .join('\n');
}
