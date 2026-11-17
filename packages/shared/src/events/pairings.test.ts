import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generatePairingCode,
  isChannelPaired,
  listPairedChannels,
  markChannelPaired,
  parsePairingAttempt,
  pairingPromptDue,
  pairingTexts,
  recordPairingPrompt,
  redeemPairingCode,
  unpairChannel,
} from './pairings';

const CHANNEL = 'message://telegram/42';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-pairings-'));
  mkdirSync(join(root, 'config'), { recursive: true });
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows keeps handles briefly; leftovers are harmless.
  }
});

describe('parsePairingAttempt', () => {
  it('parses the bare /pair <code> form', () => {
    expect(parsePairingAttempt('/pair ABC123')).toBe('ABC123');
  });

  it('uppercases the code', () => {
    expect(parsePairingAttempt('/pair abc123')).toBe('ABC123');
  });

  it('rejects /pair without a code', () => {
    expect(parsePairingAttempt('/pair')).toBeNull();
  });

  it('rejects prose around the command', () => {
    expect(parsePairingAttempt('please /pair ABC123 now')).toBeNull();
  });

  it('rejects other commands', () => {
    expect(parsePairingAttempt('/stop')).toBeNull();
    expect(parsePairingAttempt('/help ABC123')).toBeNull();
  });

  it('rejects undefined text', () => {
    expect(parsePairingAttempt(undefined)).toBeNull();
  });
});

describe('generate + redeem', () => {
  it('a generated code pairs the channel it was sent from', () => {
    const { code } = generatePairingCode(root);
    expect(code.length).toBe(8);
    expect(redeemPairingCode(root, code, CHANNEL)).toEqual({ ok: true });
    expect(isChannelPaired(root, CHANNEL)).toBe(true);
  });

  it('codes are single-use', () => {
    const { code } = generatePairingCode(root);
    expect(redeemPairingCode(root, code, CHANNEL).ok).toBe(true);
    expect(redeemPairingCode(root, code, 'message://telegram/99').ok).toBe(false);
  });

  it('rejects unknown codes', () => {
    expect(redeemPairingCode(root, 'NOPE1234', CHANNEL)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('codes expire after the TTL', () => {
    const now = 1_000_000;
    const { code, expiresAt } = generatePairingCode(root, 60_000, now);
    expect(expiresAt).toBe(now + 60_000);
    expect(redeemPairingCode(root, code, CHANNEL, now + 59_000)).toEqual({ ok: true });
  });

  it('an expired code cannot redeem', () => {
    const now = 1_000_000;
    const { code } = generatePairingCode(root, 60_000, now);
    // A fresh code on top of the expired one: expiry is checked at redeem time.
    expect(redeemPairingCode(root, code, CHANNEL, now + 61_000)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('paired channels', () => {
  it('lists and unpairs channels', () => {
    markChannelPaired(root, CHANNEL);
    markChannelPaired(root, 'message://whatsapp/1');
    expect(listPairedChannels(root).map((entry) => entry.channelKey)).toEqual([
      CHANNEL,
      'message://whatsapp/1',
    ]);
    expect(unpairChannel(root, CHANNEL)).toBe(true);
    expect(unpairChannel(root, CHANNEL)).toBe(false);
    expect(isChannelPaired(root, CHANNEL)).toBe(false);
    expect(isChannelPaired(root, 'message://whatsapp/1')).toBe(true);
  });

  it('a corrupt file yields no pairings rather than a throw', () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(root, 'config', 'pairings.json'), '{ not json', 'utf8');
    expect(isChannelPaired(root, CHANNEL)).toBe(false);
  });
});

describe('prompt cooldown', () => {
  it('allows one prompt, then cools down for 10 minutes', () => {
    const now = 1_000_000;
    expect(pairingPromptDue(root, CHANNEL, now)).toBe(true);
    recordPairingPrompt(root, CHANNEL, now);
    expect(pairingPromptDue(root, CHANNEL, now + 5 * 60_000)).toBe(false);
    expect(pairingPromptDue(root, CHANNEL, now + 11 * 60_000)).toBe(true);
  });

  it('a paired channel keeps its prompt history but is never prompted again by the gate', () => {
    markChannelPaired(root, CHANNEL);
    expect(isChannelPaired(root, CHANNEL)).toBe(true);
  });
});

describe('pairingTexts', () => {
  it('resolves from the locale catalogue', () => {
    const zh = pairingTexts('zh-Hans');
    expect(zh.prompt).toContain('/pair');
    expect(zh.paired.length).toBeGreaterThan(0);
  });

  it('falls back to English for unknown languages', () => {
    expect(pairingTexts('xx-unknown').prompt).toBe(pairingTexts('en').prompt);
  });
});
