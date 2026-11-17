import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LOCALE_REGISTRY, type LanguageCode } from '../i18n/registry.ts';

/**
 * Channel pairing — the host-owned answer to 「who is allowed to send events
 * to this workspace」.
 *
 * The model:
 * - A channel (`message://<platform>/<chatId>`) is NOT paired by default.
 * - While unpaired, its messages never become events: the host answers
 *   every one of them with a pairing prompt (no rate limit), and handles
 *   `/pair <code>` redemption.
 * - A code is generated in the app (the plugin's detail page), is single-use and
 *   expires after a minute. Redeeming it from a chat pairs that chat.
 *
 * Pairing state is plain JSON beside the other workspace state
 * (`<root>/config/pairings.json`), like thread bindings and the outbox: it
 * survives restarts and is readable from any host component.
 */

export interface PairedChannelRecord {
  /** `message://<platform>/<chatId>` — exactly what deriveThreadKey produces. */
  channelKey: string;
  /** Paired when this timestamp was set. 0 in legacy prompt-cooldown rows. */
  pairedAt: number;
}

export interface PendingCodeRecord {
  code: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

interface PairingsFile {
  version: 1;
  codes: PendingCodeRecord[];
  channels: PairedChannelRecord[];
}

const EMPTY: PairingsFile = { version: 1, codes: [], channels: [] };

export function pairingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'pairings.json');
}

/** A corrupt or missing file yields no pairings, never a throw. */
export function loadPairings(workspaceRoot: string): PairingsFile {
  const path = pairingsPath(workspaceRoot);
  if (!existsSync(path)) return { ...EMPTY, codes: [], channels: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PairingsFile>;
    return {
      version: 1,
      codes: Array.isArray(parsed.codes) ? parsed.codes : [],
      channels: Array.isArray(parsed.channels) ? parsed.channels : [],
    };
  } catch {
    return { ...EMPTY, codes: [], channels: [] };
  }
}

function savePairings(workspaceRoot: string, file: PairingsFile): void {
  const path = pairingsPath(workspaceRoot);
  mkdirSync(join(workspaceRoot, 'config'), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), 'utf8');
}

/** Drop codes that are used up or past their expiry. */
function pruneCodes(file: PairingsFile, now: number): PairingsFile {
  return {
    ...file,
    codes: file.codes.filter((entry) => !entry.used && entry.expiresAt > now),
  };
}

/**
 * A channel is paired only when an entry was created by a real pairing
 * (markChannelPaired / redeemPairingCode — `pairedAt > 0`). Legacy files
 * may still hold prompt-cooldown rows (`pairedAt: 0`) written before the
 * cooldown was dropped, and those must NOT open the gate: otherwise the
 * first pairing prompt would let every later message through.
 */
export function isChannelPaired(workspaceRoot: string, channelKey: string): boolean {
  return loadPairings(workspaceRoot).channels.some(
    (entry) => entry.channelKey === channelKey && entry.pairedAt > 0,
  );
}

export function listPairedChannels(workspaceRoot: string): PairedChannelRecord[] {
  return loadPairings(workspaceRoot).channels;
}

/** Record a channel as paired (idempotent — re-pairing just refreshes the timestamp). */
export function markChannelPaired(workspaceRoot: string, channelKey: string, now = Date.now()): void {
  const file = pruneCodes(loadPairings(workspaceRoot), now);
  file.channels = [
    ...file.channels.filter((entry) => entry.channelKey !== channelKey),
    { channelKey, pairedAt: now },
  ];
  savePairings(workspaceRoot, file);
}

export function unpairChannel(workspaceRoot: string, channelKey: string): boolean {
  const file = loadPairings(workspaceRoot);
  const before = file.channels.length;
  file.channels = file.channels.filter((entry) => entry.channelKey !== channelKey);
  if (file.channels.length === before) return false;
  savePairings(workspaceRoot, file);
  return true;
}

/** Unambiguous alphabet (no 0/O, 1/I) — the code is typed on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/**
 * Generate a single-use pairing code valid for `ttlMs` (default 60s — the
 * plugin detail page shows a one-minute countdown for a reason: a code left
 * sitting on screen is a credential).
 */
export function generatePairingCode(
  workspaceRoot: string,
  ttlMs = 60_000,
  now = Date.now(),
): { code: string; expiresAt: number } {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    const b = bytes[i] ?? 0;
    code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  const file = pruneCodes(loadPairings(workspaceRoot), now);
  file.codes.push({ code, createdAt: now, expiresAt: now + ttlMs, used: false });
  savePairings(workspaceRoot, file);
  return { code, expiresAt: now + ttlMs };
}

export type PairingRedemption =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'expired' };

/**
 * Redeem a code and pair the channel it was sent from. One code, one chat:
 * the second attempt (same code, any chat) is `invalid`.
 */
export function redeemPairingCode(
  workspaceRoot: string,
  code: string,
  channelKey: string,
  now = Date.now(),
): PairingRedemption {
  const file = loadPairings(workspaceRoot);
  const entry = file.codes.find((candidate) => candidate.code === code);
  if (!entry) return { ok: false, reason: 'invalid' };
  if (entry.expiresAt <= now || entry.used) {
    const pruned = pruneCodes(file, now);
    savePairings(workspaceRoot, pruned);
    return { ok: false, reason: entry.used && entry.expiresAt > now ? 'invalid' : 'expired' };
  }
  entry.used = true;
  file.channels = [
    ...file.channels.filter((candidate) => candidate.channelKey !== channelKey),
    { channelKey, pairedAt: now },
  ];
  savePairings(workspaceRoot, pruneCodes(file, now));
  return { ok: true };
}

/**
 * The pairing protocol as spoken in a chat: `/pair <code>`.
 * Only the bare form is a pairing attempt — `/pair` without a code, or with
 * prose around it, stays an ordinary message.
 */
export function parsePairingAttempt(text: string | undefined): string | null {
  const match = /^\s*\/pair\s+([A-Za-z0-9]{6,16})\s*$/i.exec(text ?? '');
  return match ? (match[1] ?? '').toUpperCase() : null;
}

/**
 * The user-facing texts, resolved from the app's i18n catalogue. The host
 * does not yet know the renderer's language (it is not persisted), so this
 * defaults to the registry's base language; wire the app language through
 * when it gains a server-side home.
 */
export function pairingTexts(language?: string): { prompt: string; paired: string; codeInvalid: string } {
  const code = (language && language in LOCALE_REGISTRY ? language : 'en') as LanguageCode;
  const messages = LOCALE_REGISTRY[code].messages as Record<string, string>;
  const fallback = LOCALE_REGISTRY.en.messages as Record<string, string>;
  const pick = (key: string): string => messages[key] ?? fallback[key] ?? key;
  return {
    prompt: pick('events.pairing.prompt'),
    paired: pick('events.pairing.paired'),
    codeInvalid: pick('events.pairing.codeInvalid'),
  };
}
