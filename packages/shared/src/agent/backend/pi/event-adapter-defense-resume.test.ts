/**
 * Regression tests for the 2026-10-01 two-reply incident (session
 * 261001-ready-sunset): when the defense layer queues a verification-delivery
 * followUp, the resumed turn's final 'stop' reply used to emit as a non-
 * intermediate (top-level) response — the UI then rendered a SECOND reply
 * card identical to the user's original reply.
 *
 * Contract: while a held defense-resume window is open (agent_end carried
 * defenseResumePending=true), the resumed turn's final 'stop' reply is the
 * VERIFICATION-DELIVERY step, with ONE discriminator:
 *   - NO tool executed in the window  -> pure "corresponds -> re-deliver"
 *     duplicate of the original reply; emit isIntermediate=true so the UI
 *     renders it as a process-block step, NOT a second reply card.
 *   - a tool DID execute in the window -> "doesn't correspond -> continue":
 *     the reply is the continuation's NEW answer; emit isIntermediate=false
 *     so it stays a visible reply card.
 * The main turn's reply (emitted before the hold) and replies after the
 * final agent_end (no flag) always stay non-intermediate.
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
    expect(tc[0].isIntermediate).toBe(false);
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
    expect(tc[0].text).toBe('状态复查完毕（验证交付）');
    // A redundant re-delivery is a process-block step, NOT a second reply card.
    expect(tc[0].isIntermediate).toBe(true);
  });

  it('resumed continuation reply stays a normal reply card when the model did NEW tool work', () => {
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
    // Final reply of the continuation — must remain a VISIBLE reply card.
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
    expect(tc[0].isIntermediate).toBe(false);
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
    expect(tc[0].isIntermediate).toBe(false);
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
    expect(tc[0].isIntermediate).toBe(true);
  });

});
