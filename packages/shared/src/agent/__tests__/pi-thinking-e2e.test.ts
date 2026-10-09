/**
 * End-to-end simulation: deepseek-style streaming (long reasoning → short text).
 * Mirrors the real 2026-10-08 166s session flow at the event level.
 */
import { describe, expect, it, beforeEach, afterEach, jest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { toolMetadataStore } from '../../interceptor-common.ts';

function collect(gen: Generator<any>): any[] {
  return [...gen];
}

describe('thinking streaming end-to-end (deepseek-style)', () => {
  let adapter: PiEventAdapter;
  let sessionDir: string;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    sessionDir = mkdtempSync(join(tmpdir(), 'pi-thinking-e2e-'));
    adapter.setSessionDir(sessionDir);
    toolMetadataStore.setSessionDir(sessionDir);
    adapter.startTurn();
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('emits thinking_delta for every reasoning chunk, then a single thinking_complete, then text_delta for the short answer', () => {
    collect(adapter.adaptEvent({ type: 'turn_start' } as any));
    collect(adapter.adaptEvent({ type: 'message_start', message: { role: 'assistant' } } as any));

    // Long reasoning stream — like the 166s deepseek session
    const all: any[] = [];
    const chunks = ['用户问', '的诉求是', '完善最初的想法，', '我需要先分析上下文…', ';λ, c(3) 嗯，思路确定：', '从用户旅程出发，', '补全信息架构。'];
    for (const c of chunks) {
      const ev = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: c },
      } as any));
      all.push(...ev);
    }

    // thinking ends
    const endEv = collect(adapter.adaptEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', content: chunks.join('') },
    } as any));
    all.push(...endEv);

    // short visible answer text
    const textEv = collect(adapter.adaptEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '好的，我把它完善成一份设计稿。' },
    } as any));
    all.push(...textEv);

    // message_end (toolUse → process step)
    const end = collect(adapter.adaptEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: chunks.join('') },
          { type: 'text', text: '好的，我把它完善成一份设计稿。' },
        ],
      },
    } as any));
    all.push(...end);

    const thinkingDeltas = all.filter(e => e.type === 'thinking_delta');
    const thinkingCompletes = all.filter(e => e.type === 'thinking_complete');
    const textDeltas = all.filter(e => e.type === 'text_delta');
    const textCompletes = all.filter(e => e.type === 'text_complete');

    // Phase 1: every reasoning chunk is forwarded live
    expect(thinkingDeltas).toHaveLength(chunks.length);
    expect(thinkingDeltas[0].text).toBe('用户问');
    expect(thinkingDeltas[0].turnId).toMatch(/__t0$/);
    // all thinking chunks share the SAME turnId (one live process step)
    expect(new Set(thinkingDeltas.map(d => d.turnId)).size).toBe(1);

    // Phase 2: one terminal thinking_complete with the FULL text
    expect(thinkingCompletes).toHaveLength(1);
    expect(thinkingCompletes[0].text).toBe(chunks.join(''));

    // Phase 3: the short answer streams as normal text
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].text).toBe('好的，我把它完善成一份设计稿。');
    expect(textDeltas[0].turnId).toMatch(/__m\d+$/);

    // Phase 4: only the text gets a terminal text_complete (NO duplicate
    // truncated thinking record — the pre-fix double-record bug)
    expect(textCompletes).toHaveLength(1);
    expect(textCompletes[0].isIntermediate).toBe(true); // toolUse stop
    expect(textCompletes[0].text).toBe('好的，我把它完善成一份设计稿。');
  });
});