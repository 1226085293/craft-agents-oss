/**
 * Regression test for the 2026-10-03 blank-message incident
 * (session 261001-active-eclipse): "\n\n" final text was truthy, so
 * text_complete events were emitted and persisted — 585 blank messages
 * landed in session.jsonl. A whitespace-only "final" is NOT a reply;
 * it must emit nothing (the SDK's own defense/empty-response detection
 * keys off the message and is unaffected).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { toolMetadataStore } from '../../interceptor-common.ts';

function collect(gen: Generator<any>): any[] {
  return [...gen];
}

describe('PiEventAdapter blank-text filtering', () => {
  let adapter: PiEventAdapter;
  let sessionDir: string;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    sessionDir = mkdtempSync(join(tmpdir(), 'pi-adapter-blank-'));
    adapter.setSessionDir(sessionDir);
    toolMetadataStore.setSessionDir(sessionDir);
    adapter.startTurn();
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('emits NO text_complete for a whitespace-only final ("\\n\\n" incident shape)', () => {
    const events = collect(adapter.adaptEvent({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: '\n\n' },
    } as any));

    expect(events.filter((e: { type?: string }) => e?.type === 'text_complete')).toHaveLength(0);
  });

  it('emits NO text_complete for a whitespace-only intermediate (toolUse stop)', () => {
    const events = collect(adapter.adaptEvent({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'toolUse', content: '   \n\t  ' },
    } as any));

    expect(events.filter((e: { type?: string }) => e?.type === 'text_complete')).toHaveLength(0);
  });

  it('still emits text_complete for visible text (no over-filtering)', () => {
    const events = collect(adapter.adaptEvent({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: '  done, here is the result ' },
    } as any));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'text_complete',
      text: '  done, here is the result ',
      isIntermediate: false,
    });
  });

  it('still extracts text from whitespace-mixed content blocks', () => {
    const events = collect(adapter.adaptEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [
          { type: 'text', text: '\n\n' },
          { type: 'text', text: 'real answer' },
        ],
      },
    } as any));

    const textComplete = events.find((e: { type?: string }) => e?.type === 'text_complete');
    expect(textComplete).toBeDefined();
    expect(textComplete!.text).toContain('real answer');
  });
});
