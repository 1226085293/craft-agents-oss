/**
 * Channel judge: the decisions that must not be guessed at.
 *
 * Three properties matter more than any single answer:
 * 1. A malformed model reply never becomes "reply to everything".
 * 2. Running out of budget never becomes silence either — it degrades to the
 *    behaviour the person chose by default (at_only).
 * 3. Repeated failures get a channel flagged for a human, instead of quietly
 *    degrading forever.
 */
import { describe, expect, it } from 'bun:test';

import {
  JUDGE_DAILY_LIMIT,
  JUDGE_FAILURE_FLAG_THRESHOLD,
  buildJudgePrompt,
  emptyJudgeState,
  isOverDailyLimit,
  judgeBatch,
  parseJudgeReply,
  type JudgeInput,
} from './judge.ts';

const input: JudgeInput = {
  channelLabel: '测试群',
  channelKind: 'group',
  assistantHint: '负责整理需求',
  messages: [
    { eventId: 'e1', sender: '小明', text: '这个报表能加一列吗', at: 1 },
    { eventId: 'e2', sender: '小红', text: '@bot 帮我看看', at: 2, mentionsBot: true },
  ],
};

const model = (reply: string) => async () => reply;

describe('buildJudgePrompt', () => {
  it('carries the messages with ids and the mention marker', () => {
    const prompt = buildJudgePrompt(input);
    expect(prompt).toContain('(e1)');
    expect(prompt).toContain('(e2) [@bot]');
    expect(prompt).toContain('小明: 这个报表能加一列吗');
    expect(prompt).toContain('负责整理需求');
  });

  it('asks for one JSON line and offers exactly three actions', () => {
    const prompt = buildJudgePrompt(input);
    expect(prompt).toContain('respond|ignore|escalate');
    expect(prompt).toContain('只输出一行 JSON');
  });
});

describe('parseJudgeReply', () => {
  it('parses a bare JSON reply', () => {
    expect(parseJudgeReply('{"action":"ignore"}')?.action).toBe('ignore');
  });

  it('parses JSON wrapped in prose or fences', () => {
    const raw = '好的，判定如下：\n```json\n{"action":"respond","reason":"在问功能"}\n```';
    const decision = parseJudgeReply(raw);
    expect(decision?.action).toBe('respond');
    expect(decision?.reason).toBe('在问功能');
  });

  it('keeps only string event ids', () => {
    const decision = parseJudgeReply('{"action":"respond","eventIds":["e2",3,"",null]}');
    expect(decision?.eventIds).toEqual(['e2']);
  });

  it('refuses unknown actions instead of guessing', () => {
    expect(parseJudgeReply('{"action":"maybe"}')).toBeUndefined();
    expect(parseJudgeReply('{"action":"YES"}')).toBeUndefined();
    expect(parseJudgeReply('完全没有 JSON')).toBeUndefined();
    expect(parseJudgeReply('')).toBeUndefined();
  });
});

describe('judgeBatch', () => {
  it('returns the decision and resets the failure streak', async () => {
    const state = { judgedToday: 3, consecutiveFailures: 2 };
    const outcome = await judgeBatch(input, state, model('{"action":"respond"}'));
    expect(outcome.action).toBe('judge');
    if (outcome.action === 'judge') expect(outcome.decision.action).toBe('respond');
    expect(outcome.state.consecutiveFailures).toBe(0);
    expect(outcome.state.judgedToday).toBe(4);
  });

  it('degrades instead of replying when the model throws', async () => {
    const outcome = await judgeBatch(input, emptyJudgeState(), async () => {
      throw new Error('connection refused');
    });
    expect(outcome.action).toBe('degrade');
    if (outcome.action === 'degrade') expect(outcome.reason).toContain('connection refused');
  });

  it('degrades on an unparseable reply — never falls through to respond', async () => {
    const outcome = await judgeBatch(input, emptyJudgeState(), model('我觉得应该回复'));
    expect(outcome.action).toBe('degrade');
  });

  it('flags the channel after repeated failures', async () => {
    let state = emptyJudgeState();
    for (let i = 0; i < JUDGE_FAILURE_FLAG_THRESHOLD; i += 1) {
      const outcome = await judgeBatch(input, state, model('nonsense'));
      state = outcome.state;
    }
    expect(state.consecutiveFailures).toBe(JUDGE_FAILURE_FLAG_THRESHOLD);
    expect(state.flaggedAt).toBeNumber();
  });

  it('degrades (not silences) once the daily budget is gone', async () => {
    const state = { judgedToday: JUDGE_DAILY_LIMIT, consecutiveFailures: 0 };
    expect(isOverDailyLimit(state)).toBe(true);
    const outcome = await judgeBatch(input, state, model('{"action":"respond"}'));
    expect(outcome.action).toBe('degrade');
    if (outcome.action === 'degrade') expect(outcome.reason).toContain('daily limit');
    // Budget is not consumed by a call that never happened.
    expect(outcome.state.judgedToday).toBe(JUDGE_DAILY_LIMIT);
  });
});
