/**
 * Regression tests for the 2026-10-01 two-reply incident (session
 * 261001-ready-sunset) and its 2026-10-04 refinement (session
 * 261004-fleet-mist: three mid-process result bubbles during a defense
 * auto-recovery cycle).
 *
 * Contract: a reply bubble represents the turn's RESULT — the LAST message.
 * While a DEFENSE hold is open (agent_end carried defenseResumePending /
 * verification pending), that cycle's final 'stop' text is a process-block
 * step (isIntermediate=true) UNCONDITIONALLY — the original two-reply
 * tool-work discriminator was inverted on 2026-10-04: keeping tool-work
 * continuations as visible cards surfaced as premature result bubbles.
 *
 * REFINEMENT (2026-10-07 active-wren): a pure queued steering/follow-up
 * drain (queuedFollowUpPending set, but NO defense/verification hold) is
 * different: the SDK's drain answers a USER message, so its terminal stop
 * (nothing pending left) is released from the queued-follow-up hold and
 * becomes the turn's result bubble. Defense lanes keep their demotion.
 * The FINAL agent_end (no flag) completes the queue in all cases.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

function collect<T>(gen: Generator<T>): T[] {
  return [...gen];
}

function textCompletes(events: any[]): Array<{ text: string; isIntermediate: boolean }> {
  return events.filter((e) => e.type === 'text_complete').map((e) => ({
    text: e.text,
    isIntermediate: e.isIntermediate,
  }));
}

describe('PiEventAdapter — defense-resume held window (2026-10-01 two-reply incident)', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  it('main-turn final reply emits non-intermediate (single top-level reply)', () => {
    const events = collect(
      adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'a1',
          stopReason: 'stop',
          content: [{ type: 'text', text: '构建 + 安装 + 重启全部完成 ✅' }],
        },
      } as any),
    );
    const tc = textCompletes(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.isIntermediate).toBe(false);
  });

  it('resumed verification-delivery reply emits intermediate when NO tool work happened in the window', () => {
    // Main turn ends; the subprocess flagged a defense resume on this agent_end.
    collect(adapter.adaptEvent({ type: 'agent_end', defenseResumePending: true } as any));
    // The resumed turn's final reply streams in while the hold is open, and the
    // model did NO new tool work — pure "corresponds → re-deliver" duplicate.
    const events = collect(
      adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'a2',
          stopReason: 'stop',
          content: [{ type: 'text', text: '状态复查完毕（验证交付）' }],
        },
      } as any),
    );
    const tc = textCompletes(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.text).toBe('状态复查完毕（验证交付）');
    // A redundant re-delivery is a process-block step, NOT a second reply card.
    expect(tc[0]!.isIntermediate).toBe(true);
  });

  it('resumed continuation reply stays a process step even when the model did NEW tool work (2026-10-04 fleet-mist rule)', () => {
    // Main turn ends; defense resume queued.
    collect(adapter.adaptEvent({ type: 'agent_end', defenseResumePending: true } as any));
    // The resumed turn does new work: a tool executes inside the held window.
    collect(
      adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'echo 1' },
      } as any),
    );
    // The continuation's final text must NOT surface as a result bubble while
    // the turn is still running — it folds into the process block; only the
    // FINAL agent_end's reply becomes the single result bubble.
    const events = collect(
      adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'a2b',
          stopReason: 'stop',
          content: [{ type: 'text', text: '继续完成了剩余步骤' }],
        },
      } as any),
    );
    const tc = textCompletes(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.isIntermediate).toBe(true);
  });

  it('queued-followUp drain: the drained steer\'s answer becomes the result bubble (2026-10-07 active-wren)', () => {
    collect(adapter.adaptEvent({ type: 'agent_end', queuedFollowUpPending: true } as any));
    // No defense/verification flag on that agent_end → only the queued-
    // follow-up hold is open. The SDK drains the queued user steer; its
    // answer is the turn's result — the clean terminal stop releases the
    // queued-follow-up hold.
    const events = collect(
      adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'a2c',
          stopReason: 'stop',
          content: [{ type: 'text', text: '我是 Craft Agent。' }],
        },
      } as any),
    );
    const tc = textCompletes(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.isIntermediate).toBe(false);
    // No demoted final existed before this agent_end → nothing to re-promote
    // (fleet-mist: only pure user-steer drains re-promote).
    expect(events.find((e: any) => e.type === 'text_promote')).toBeUndefined();
    // Terminal agent_end completes the queue.
    collect(adapter.adaptEvent({ type: 'agent_end' } as any));
    // The NEXT user turn (fresh turn state) gets normal finals again.
    adapter.startTurn();
    const terminal = collect(
      adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'a2d',
          stopReason: 'stop',
          content: [{ type: 'text', text: '真正最终的回答' }],
        },
      } as any),
    );
    expect(textCompletes(terminal)[0]!.isIntermediate).toBe(false);
  });

  it('final agent_end (no flag) clears the hold — later replies are normal finals', () => {
    collect(adapter.adaptEvent({ type: 'agent_end', defenseResumePending: true } as any));
    collect(adapter.adaptEvent({ type: 'agent_end' } as any));
    const events = collect(
      adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'a3',
          stopReason: 'stop',
          content: [{ type: 'text', text: '下一个用户回合的回复' }],
        },
      } as any),
    );
    const tc = textCompletes(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.isIntermediate).toBe(false);
  });

  it('toolUse replies stay intermediate with or without a hold', () => {
    const events = collect(
      adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'a4',
          stopReason: 'toolUse',
          content: [{ type: 'text', text: '继续干活中…' }],
        },
      } as any),
    );
    const tc = textCompletes(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.isIntermediate).toBe(true);
  });

});
