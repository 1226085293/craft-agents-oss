/**
 * Unattended-session approval policy (stage 2: 动手前先问 — without a hang).
 *
 * `ask` mode works by pausing a tool call until a person approves it. That is
 * correct for a session someone is watching, and wrong for one nobody is:
 * a channel-woken session (Telegram group message, scheduled check-in) has no
 * window to answer in, so a paused call would sit until the stall watchdog
 * kills the turn — the person sees nothing, the work silently dies, and the
 * permission prompt is delivered to a UI nobody is looking at.
 *
 * Policy (deliberately conservative — asking is a *gate*, not a queue):
 * - attended   → park the call and wait for the person (today's behaviour).
 * - unattended → do not park. Refuse that one call with a reason the assistant
 *                can act on, so it can tell the requester what it needs and the
 *                turn ends cleanly instead of hanging.
 *
 * The alternative — auto-approving in unattended sessions — would quietly turn
 * `ask` into `allow-all` for exactly the sessions with the least supervision,
 * so it is not an option here.
 */

export type ApprovalDecision = 'park' | 'refuse';

export interface ApprovalContext {
  /** Is a person able to answer right now (a window is showing this session)? */
  attended: boolean;
  /** Channel-woken or scheduled session: work started without someone present. */
  unattendedOrigin: boolean;
}

/**
 * Should a `prompt`-class permission request wait for a human, or be refused?
 *
 * `attended` wins: a channel-woken session that the person then opened is
 * attended, and parking is right there — they are watching the question appear.
 */
export function decideApproval(ctx: ApprovalContext): ApprovalDecision {
  if (ctx.attended) return 'park';
  if (ctx.unattendedOrigin) return 'refuse';
  // Unknown origin with no window: treat as unattended rather than park forever.
  return 'refuse';
}

/**
 * Reason handed back to the model when a call is refused for lack of a person.
 * Written for the assistant to relay, not for a log.
 */
export const UNATTENDED_REFUSAL_REASON =
  '这次操作需要人确认，但当前没有人在界面上看着这个会话（渠道唤醒/定时任务），所以没有放行。' +
  '把你要做的事说清楚交给发起的人，等他回复后再做；不要重试同一个操作。';

/** True when a permission request cannot be answered by anyone right now. */
export function isUnattended(ctx: ApprovalContext): boolean {
  return decideApproval(ctx) === 'refuse';
}
