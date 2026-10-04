import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { patchQueueDrain, QUEUE_DRAIN_MARKER } from './patch-pi-coding-agent-queue-drain.ts';

const SDK_SOURCE = new URL(
  '../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js',
  import.meta.url,
);

const REMOVAL_BLOCK = [
  '            this._overflowRecoveryAttempted = false;',
  '            const messageText = contentText(event.message.content, "");',
  '            if (messageText) {',
  '                // Check steering queue first',
  '                const steeringIndex = this._steeringMessages.indexOf(messageText);',
  '                if (steeringIndex !== -1) {',
  '                    this._steeringMessages.splice(steeringIndex, 1);',
  '                    this._emitQueueUpdate();',
  '                }',
  '                else {',
  '                    // Check follow-up queue',
  '                    const followUpIndex = this._followUpMessages.indexOf(messageText);',
  '                    if (followUpIndex !== -1) {',
  '                        this._followUpMessages.splice(followUpIndex, 1);',
  '                        this._emitQueueUpdate();',
  '                    }',
  '                }',
  '            }',
].join('\n');

const PATCH_FIXTURE = [
  '    async _queueSteer(text, images) {',
  '        this._steeringMessages.push(text);',
  '    async _queueFollowUp(text, images) {',
  '        this._followUpMessages.push(text);',
  REMOVAL_BLOCK,
].join('\n');

/**
 * Mirror of the patched removal algorithm, used to lock the intended
 * behavior (the real `_handleAgentEvent` is an instance arrow function we
 * cannot instantiate without the full SDK harness).
 */
function simulateRemoval(
  steering: Array<string | { text: string; _craftQueued: boolean }>,
  followUp: Array<string | { text: string; _craftQueued: boolean }>,
  messageText: string,
) {
  const markedRemove = (queue: typeof steering): boolean => {
    if (!queue.length) {
      return false;
    }
    const exactIdx = messageText
      ? queue.findIndex(
          (entry) =>
            entry !== null &&
            typeof entry === 'object' &&
            entry._craftQueued === true &&
            entry.text === messageText,
        )
      : -1;
    if (exactIdx !== -1) {
      queue.splice(exactIdx, 1);
      return true;
    }
    const head = queue[0] as { _craftQueued?: boolean } | string;
    if (head !== null && typeof head === 'object' && head._craftQueued === true) {
      queue.shift();
      return true;
    }
    return false;
  };
  if (!markedRemove(steering)) {
    if (messageText) {
      const steeringIndex = steering.indexOf(messageText as string);
      if (steeringIndex !== -1) {
        steering.splice(steeringIndex, 1);
      } else if (!markedRemove(followUp)) {
        const followUpIndex = followUp.indexOf(messageText as string);
        if (followUpIndex !== -1) {
          followUp.splice(followUpIndex, 1);
        }
      }
    } else if (!markedRemove(followUp)) {
      // empty text: nothing more to do here
    }
  }
  return { steering, followUp };
}

describe('Pi SDK queue-drain patch', () => {
  it('applies to the real pinned SDK source and marks the entries', () => {
    const source = readFileSync(SDK_SOURCE, 'utf8');
    const result = patchQueueDrain(source);
    expect(result.warning).toBeUndefined();
    expect(result.source).toContain(QUEUE_DRAIN_MARKER);
    expect(result.source).toContain('this._steeringMessages.push({ text, _craftQueued: true });');
    expect(result.source).toContain('this._followUpMessages.push({ text, _craftQueued: true });');
    // The fragile exact-match-only path must be gone, replaced by marked removal.
    expect(result.source).toContain('const markedRemove = (queue) => {');
    expect(result.source).toContain('queue.shift();');
    expect(result.source).not.toContain('checkQueue'); // no accidental leftover marker
  });

  it('is idempotent', () => {
    const once = patchQueueDrain(PATCH_FIXTURE);
    const twice = patchQueueDrain(once.source);
    expect(once.changed).toBe(true);
    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once.source);
  });

  it('warns and leaves source unchanged when SDK internals drift', () => {
    const source = 'this._steeringMessages.push(expandedText);';
    const result = patchQueueDrain(source);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
    expect(result.warning).toContain('anchor not found');
  });

  describe('patched removal semantics (simulation)', () => {
    it('removes a marked entry on exact text match', () => {
      const { steering, followUp } = simulateRemoval(
        [{ text: 'guide me', _craftQueued: true }],
        [],
        'guide me',
      );
      expect(steering).toHaveLength(0);
      expect(followUp).toHaveLength(0);
    });

    it('drains a marked entry when injected text mismatches (the residue bug)', () => {
      const { steering } = simulateRemoval(
        [{ text: 'guide me', _craftQueued: true }],
        [],
        'guide me (normalized differently)',
      );
      expect(steering).toHaveLength(0);
    });

    it('drains the marked head even for empty text (image-only injection)', () => {
      const { followUp } = simulateRemoval([], [{ text: 'resume', _craftQueued: true }], '');
      expect(followUp).toHaveLength(0);
    });

    it('prefers the steering queue over the followUp queue', () => {
      const { steering, followUp } = simulateRemoval(
        [{ text: 'a', _craftQueued: true }],
        [{ text: 'b', _craftQueued: true }],
        'b',
      );
      // Steering head "a" does not match "b", so it is shifted; followUp keeps "b".
      expect(steering).toHaveLength(0);
      expect(followUp).toHaveLength(1);
    });

    it('keeps legacy string-entry behavior: exact match removes, mismatch leaves entries', () => {
      const matched = simulateRemoval(['legacy text'], [], 'legacy text');
      expect(matched.steering).toHaveLength(0);
      const unmatched = simulateRemoval(['legacy text'], [], 'different');
      expect(unmatched.steering).toHaveLength(1);
    });

    it('does not shift real legacy string entries on mismatch (no message loss)', () => {
      const { steering } = simulateRemoval(['user queued reply'], [], 'injected variant');
      // Legacy strings are only removed by exact match — the fallback never
      // shifts them, so no queued message is lost.
      expect(steering).toEqual(['user queued reply']);
    });

    it('removes legacy string followUp entries on exact match', () => {
      const { followUp } = simulateRemoval([], ['legacy follow-up'], 'legacy follow-up');
      expect(followUp).toHaveLength(0);
    });

    it('leaves legacy string followUp entries when only empty text matches nothing', () => {
      const { followUp } = simulateRemoval([], ['legacy follow-up'], '');
      expect(followUp).toEqual(['legacy follow-up']);
    });
  });
});
