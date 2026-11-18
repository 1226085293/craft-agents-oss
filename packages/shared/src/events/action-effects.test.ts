/**
 * H2 compile table: the three rules, and the one exception that matters.
 *
 * `reply` in every mode is not an oversight — a mode gate that also mutes the
 * answer produces a bot that reads a request and says nothing, which reads as
 * broken rather than as restricted.
 */
import { describe, expect, it } from 'bun:test';

import { filterActionsByMode, isEffectOffered, needsConfirmation } from './action-effects.ts';
import { resolveActionEffect } from './manifest.ts';

const action = (name: string, extra: Record<string, unknown> = {}) => ({ name, ...extra });

describe('resolveActionEffect', () => {
  it('honours an explicit effect', () => {
    expect(resolveActionEffect(action('x', { effect: 'read' }) as never)).toBe('read');
    expect(resolveActionEffect(action('x', { effect: 'reply' }) as never)).toBe('reply');
  });

  it('treats repliesToOrigin as reply — existing messaging plugins stay able to answer', () => {
    expect(resolveActionEffect(action('reply', { repliesToOrigin: true }) as never)).toBe('reply');
  });

  it('defaults to write, which is the conservative side', () => {
    expect(resolveActionEffect(action('send_message') as never)).toBe('write');
  });

  it('prefers an explicit effect over the reply flag', () => {
    expect(resolveActionEffect(action('x', { repliesToOrigin: true, effect: 'write' }) as never)).toBe('write');
  });
});

describe('H2 mode → effect table', () => {
  it('exploration offers reads and replies, never writes', () => {
    expect(isEffectOffered('safe', 'read')).toBe(true);
    expect(isEffectOffered('safe', 'reply')).toBe(true);
    expect(isEffectOffered('safe', 'write')).toBe(false);
  });

  it('asking and execution offer all three', () => {
    for (const mode of ['ask', 'allow-all'] as const) {
      for (const effect of ['read', 'write', 'reply'] as const) {
        expect(isEffectOffered(mode, effect)).toBe(true);
      }
    }
  });

  it('keeps a messaging plugin answerable in exploration', () => {
    const actions = [
      action('read_messages', { effect: 'read' }),
      action('reply', { repliesToOrigin: true }),
      action('post_report', { effect: 'write' }),
    ];
    const kept = filterActionsByMode(actions as never, 'safe').map((a) => (a as { name: string }).name);
    expect(kept).toEqual(['read_messages', 'reply']);
  });

  it('confirms writes only in ask mode', () => {
    expect(needsConfirmation('ask', 'write')).toBe(true);
    expect(needsConfirmation('ask', 'reply')).toBe(false);
    expect(needsConfirmation('ask', 'read')).toBe(false);
    expect(needsConfirmation('safe', 'write')).toBe(false);
    expect(needsConfirmation('allow-all', 'write')).toBe(false);
  });
});
