/**
 * "Open this session, at this moment" — a one-shot hand-off.
 *
 * A plan step is a moment in a session: it was written, moved to doing and
 * finished at known times. Making the step clickable means carrying that moment
 * across a navigation that unmounts the component which asked for it, so the
 * request has to live outside React state. It is consumed exactly once and
 * cleared, so a later visit to the same session behaves like a normal visit.
 *
 * Deliberately not part of the route: a URL should not make the app scroll
 * somewhere every time it is restored, and the target is meaningless after the
 * transcript has moved on.
 */

export interface SessionJumpTarget {
  sessionId: string;
  /** Epoch ms. The conversation is scrolled to the nearest message at or after it. */
  at: number;
  /** Why we are jumping — shown as a subtle marker so the landing is not a surprise. */
  label?: string;
}

let pending: SessionJumpTarget | null = null;

/** Ask the next mount of `sessionId` to land on `at`. */
export function requestSessionJump(target: SessionJumpTarget): void {
  pending = target;
}

/**
 * Take the target if it belongs to this session.
 *
 * Consuming on read (rather than peeking) is what makes it one-shot: two panes
 * observing the same session must not both scroll.
 */
export function takeSessionJump(sessionId: string): SessionJumpTarget | null {
  if (!pending || pending.sessionId !== sessionId) return null;
  const target = pending;
  pending = null;
  return target;
}

/** Test seam: forget any pending request. */
export function clearSessionJump(): void {
  pending = null;
}
