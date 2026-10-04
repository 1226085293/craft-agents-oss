import { describe, expect, it } from 'bun:test';
import { drainQueuedFollowUp, type ResumeSessionLike } from './resume-followup.ts';

function fakeSession(opts: { streaming?: boolean; continueImpl?: () => Promise<void>; }): ResumeSessionLike {
  return {
    isStreaming: opts.streaming ?? false,
    agent: {
      continue: opts.continueImpl ?? (async () => {}),
    },
  };
}

describe('drainQueuedFollowUp', () => {
  it('skips explicit continuation while a run is streaming (SDK drains)', async () => {
    let called = 0;
    const session = fakeSession({ streaming: true, continueImpl: async () => { called += 1; } });
    const result = await drainQueuedFollowUp(session);
    expect(result).toBe('drained-by-sdk');
    expect(called).toBe(0);
  });

  it('starts an explicit continuation when the session is idle (the 2026-10-04 fix)', async () => {
    let called = 0;
    const session = fakeSession({ streaming: false, continueImpl: async () => { called += 1; } });
    const result = await drainQueuedFollowUp(session);
    expect(result).toBe('explicit-continue');
    expect(called).toBe(1);
  });

  it('treats a racing "already processing" failure as busy-will-drain', async () => {
    const session = fakeSession({
      streaming: false,
      continueImpl: async () => {
        throw new Error('Agent is already processing. Wait for completion before continuing.');
      },
    });
    const result = await drainQueuedFollowUp(session);
    expect(result).toBe('busy-will-drain');
  });

  it('reports other continuation failures as failed', async () => {
    const session = fakeSession({
      streaming: false,
      continueImpl: async () => {
        throw new Error('Cannot continue from message role: assistant');
      },
    });
    const result = await drainQueuedFollowUp(session);
    expect(result).toBe('failed');
  });
});
