/**
 * Channel judge (stage 5, D2/D3): should this batch of messages get a reply?
 *
 * Design decisions this file encodes:
 *
 * **Stateless, one call.** The judge reads one batch and answers once. It keeps
 * no memory between calls — state would make the same messages judge differently
 * depending on what happened before, which is impossible to reason about and
 * impossible to test.
 *
 * **Injectable model.** `callModel` is a parameter, not an import. That keeps
 * this testable with a fake (no key, no network), and keeps the wiring — which
 * connection, which model, how to authenticate — in server-core where those
 * facts live.
 *
 * **Failing closed, not open.** A judge that cannot answer must not become
 * "reply to everything": the whole point of the judge is that a group channel is
 * mostly not for the bot. A failure degrades to `at_only` — the behaviour a
 * person explicitly chose by default — and after repeated failures the channel is
 * marked so someone can look at it.
 *
 * **The daily limit is the guard against runaway cost.** 500 judged replies per
 * channel per day; past that the channel falls back to `at_only` rather than
 * going silent, because going silent looks like a broken bot.
 */

/** What the judge may decide about a batch. */
export type JudgeAction = 'respond' | 'ignore' | 'escalate';

export interface JudgeDecision {
  action: JudgeAction;
  /** Short reason, kept for the transcript and for debugging a channel. */
  reason?: string;
  /**
   * Which messages the reply should be about. Empty means the whole batch.
   * Ids, not indices: the batch may be re-read after the decision.
   */
  eventIds?: string[];
}

export interface JudgeBatchMessage {
  eventId: string;
  /** Display name of the sender, when the platform gives one. */
  sender?: string;
  text: string;
  at: number;
  mentionsBot?: boolean;
}

export interface JudgeInput {
  /** Harness label, e.g. the channel's display name. Never a user id. */
  channelLabel: string;
  /** 'private' or 'group'; private channels usually skip the judge entirely. */
  channelKind: 'private' | 'group';
  /** The assistant's own brief, so the judge knows what this bot is for. */
  assistantHint?: string;
  messages: JudgeBatchMessage[];
}

/** The model contract: one prompt in, one string out. */
export type JudgeModelCall = (prompt: string) => Promise<string>;

/**
 * Build the prompt. One template, in one place, so the policy a person can read
 * and the policy the model receives cannot drift apart.
 *
 * The instruction is deliberately about *deciding*, not about wording a reply —
 * the assistant writes the reply, and it has context the judge does not.
 */
export function buildJudgePrompt(input: JudgeInput): string {
  const lines = input.messages.map((message) => {
    const who = message.sender ? `${message.sender}: ` : '';
    const mention = message.mentionsBot ? ' [@bot]' : '';
    return `- (${message.eventId})${mention} ${who}${message.text}`;
  });
  return [
    `你是消息分流判定器。判断下面这个${input.channelKind === 'group' ? '群组' : '私聊'}里的消息，是否需要由助手回应。`,
    input.assistantHint ? `这个助手的职责：${input.assistantHint}` : '',
    `渠道：${input.channelLabel}`,
    '',
    '消息（按时间顺序）：',
    ...lines,
    '',
    '只在以下情况回答 respond：有人在向助手提问、请求、或明确需要助手的回应。',
    '人和人之间的对话、通知、无关闲聊、以及助手插话只会打断的内容，回答 ignore。',
    '如果拿不准但看起来与助手职责相关，回答 escalate（交给助手自己判断，不要代它决定内容）。',
    '',
    '只输出一行 JSON，不要解释：',
    '{"action":"respond|ignore|escalate","reason":"...","eventIds":["..."]}',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Parse the model's answer.
 *
 * Tolerant on shape, strict on meaning: a reply that is not recognisable as one
 * of the three actions is treated as `undefined` (the caller degrades) rather
 * than guessed at. Guessing here would silently turn a malformed answer into
 * "reply to everything".
 */
export function parseJudgeReply(raw: string): JudgeDecision | undefined {
  if (!raw) return undefined;
  // Models wrap JSON in prose or fences often enough that a bare JSON.parse is
  // not a real attempt at parsing.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const value = parsed as { action?: unknown; reason?: unknown; eventIds?: unknown };
  const action = value.action;
  if (action !== 'respond' && action !== 'ignore' && action !== 'escalate') return undefined;
  const reason = typeof value.reason === 'string' ? value.reason.trim().slice(0, 200) : undefined;
  const eventIds = Array.isArray(value.eventIds)
    ? value.eventIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    : undefined;
  return {
    action,
    ...(reason ? { reason } : {}),
    ...(eventIds?.length ? { eventIds } : {}),
  };
}

/** Per-channel judge budget for one day. */
export const JUDGE_DAILY_LIMIT = 500;

/** Consecutive failures before a channel is flagged for a person to look at. */
export const JUDGE_FAILURE_FLAG_THRESHOLD = 3;

export interface ChannelJudgeState {
  /** Judged batches since local midnight. */
  judgedToday: number;
  /** Consecutive failures (reset by any success). */
  consecutiveFailures: number;
  /** Set when the channel needs a human look (repeated failures). */
  flaggedAt?: number;
}

export function emptyJudgeState(): ChannelJudgeState {
  return { judgedToday: 0, consecutiveFailures: 0 };
}

/** Is this channel out of judge budget for today? */
export function isOverDailyLimit(state: ChannelJudgeState): boolean {
  return state.judgedToday >= JUDGE_DAILY_LIMIT;
}

export type JudgeOutcome =
  | { action: 'judge'; decision: JudgeDecision; state: ChannelJudgeState }
  /** No judgement: the caller falls back to `at_only` for this batch. */
  | { action: 'degrade'; reason: string; state: ChannelJudgeState }
  /** No judgement and no fallback either: skip the batch entirely. */
  | { action: 'skip'; reason: string; state: ChannelJudgeState };

/**
 * Run one judgement, applying the budget and the failure policy.
 *
 * Both the budget and the failure path land on the same fallback (`degrade`,
 * meaning "behave as at_only") rather than on "reply": the safe direction for a
 * bot that is unsure of its budget is to be quiet in groups it was not
 * addressed in, which is also the behaviour the person chose by default.
 */
export async function judgeBatch(
  input: JudgeInput,
  state: ChannelJudgeState,
  callModel: JudgeModelCall,
): Promise<JudgeOutcome> {
  if (isOverDailyLimit(state)) {
    return { action: 'degrade', reason: `daily limit ${JUDGE_DAILY_LIMIT} reached`, state };
  }

  const prompt = buildJudgePrompt(input);
  let raw: string;
  try {
    raw = await callModel(prompt);
  } catch (error) {
    const consecutiveFailures = state.consecutiveFailures + 1;
    return {
      action: 'degrade',
      reason: `judge call failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      state: {
        ...state,
        judgedToday: state.judgedToday + 1,
        consecutiveFailures,
        ...(consecutiveFailures >= JUDGE_FAILURE_FLAG_THRESHOLD
          ? { flaggedAt: state.flaggedAt ?? Date.now() }
          : {}),
      },
    };
  }

  const decision = parseJudgeReply(raw);
  if (!decision) {
    const consecutiveFailures = state.consecutiveFailures + 1;
    return {
      action: 'degrade',
      reason: 'judge reply was not a recognisable decision',
      state: {
        ...state,
        judgedToday: state.judgedToday + 1,
        consecutiveFailures,
        ...(consecutiveFailures >= JUDGE_FAILURE_FLAG_THRESHOLD
          ? { flaggedAt: state.flaggedAt ?? Date.now() }
          : {}),
      },
    };
  }

  return {
    action: 'judge',
    decision,
    state: { ...state, judgedToday: state.judgedToday + 1, consecutiveFailures: 0 },
  };
}
