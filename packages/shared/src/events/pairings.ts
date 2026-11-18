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

/** 模式天花板（B2）：缺省 = 不设天花板，跟随助手默认。更严者生效。 */
export type PermissionModeCeiling = 'safe' | 'ask' | 'allow-all';

/** 接收模式：at_only = 只收@（现状）；all = 全收（阶段 6 随判定器上）。 */
export type IngestMode = 'at_only' | 'all';

/** 渠道种类（兑换消息 meta.channelKind 的原值）。 */
export type ChannelKind = 'private' | 'group' | 'channel';

export interface PairedChannelRecord {
  /** `message://<platform>/<chatId>` — exactly what deriveThreadKey produces. */
  channelKey: string;
  /** Paired when this timestamp was set. 0 in legacy prompt-cooldown rows. */
  pairedAt: number;
  /**
   * 谁完成了配对（平台用户 ID，兑换时刻的身份快照；洞 3）。
   * 老记录缺省 = 未记录：群内写操作一律拒绝 + 上报私聊，不猜 owner。
   */
  pairedBy?: string;
  /** 配对时刻的渠道种类（来自兑换消息 meta.channelKind，D5 合并判个人渠道用）。 */
  channelKind?: ChannelKind;
  /** 该通道用哪个助手（agents.json 的 id）；缺省 = 默认助手。 */
  agentId?: string;
  /**
   * 标签闸开关（H1 空值语义，钉死）：
   * 缺省/false = 闸未启用（零回归，放行一切）；
   * true + 空 allowedLabels = 故意全禁（UI 红警）。
   */
  gateEnabled?: boolean;
  /** 启用标签闸时放行的标签列表。 */
  allowedLabels?: string[];
  /** 模式天花板：缺省 = 跟随助手默认（严禁回填 'safe' 到旧记录）。 */
  permissionMode?: PermissionModeCeiling;
  /** 接收模式（缺省 at_only；'all' 相关字段随阶段 6 使用）。 */
  ingestMode?: IngestMode;
  /** 全收触发提示词（判定参考规则，每通道可单独写）。 */
  triggerPrompt?: string;
  /** 全收：只默默记不回话。 */
  recordOnly?: boolean;
  /** 全收：入库喂记忆。 */
  memoryFeed?: boolean;
}

export interface PendingCodeRecord {
  code: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

interface PairingsFile {
  version: 1 | 2;
  codes: PendingCodeRecord[];
  channels: PairedChannelRecord[];
}

/** v2 = 通道闸门字段（agentId/allowedLabels/gateEnabled/permissionMode/ingestMode/pairedBy…）。 */
export const PAIRINGS_FILE_VERSION = 2;

const EMPTY: PairingsFile = { version: PAIRINGS_FILE_VERSION, codes: [], channels: [] };

export function pairingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'pairings.json');
}

/** A corrupt or missing file yields no pairings, never a throw. */
export function loadPairings(workspaceRoot: string): PairingsFile {
  const path = pairingsPath(workspaceRoot);
  if (!existsSync(path)) return { ...EMPTY, codes: [], channels: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PairingsFile>;
    // v1 老文件原样读入（新字段全可选，缺省 = 闸关）；绝不回填字段，避免改变行为。
    return {
      version: parsed.version === PAIRINGS_FILE_VERSION ? PAIRINGS_FILE_VERSION : 1,
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
  // 首次写入即升 v2（v1 记录的新字段全可选，升版无迁移成本）。
  writeFileSync(path, JSON.stringify({ ...file, version: PAIRINGS_FILE_VERSION }, null, 2), 'utf8');
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
export function markChannelPaired(
  workspaceRoot: string,
  channelKey: string,
  now = Date.now(),
  pairedBy?: string,
): void {
  const file = pruneCodes(loadPairings(workspaceRoot), now);
  const record: PairedChannelRecord = { channelKey, pairedAt: now };
  if (pairedBy) record.pairedBy = pairedBy;
  file.channels = [...file.channels.filter((entry) => entry.channelKey !== channelKey), record];
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
  pairedBy?: string,
  channelKind?: ChannelKind,
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
  // 洞 3：兑换时刻把身份快照写进记录（pairedBy/channelKind）——
  // 后续「群里只有配对成员能写」判定用的就是这里，不是比对消息自带 sender。
  const record: PairedChannelRecord = { channelKey, pairedAt: now };
  if (pairedBy) record.pairedBy = pairedBy;
  if (channelKind) record.channelKind = channelKind;
  file.channels = [
    ...file.channels.filter((candidate) => candidate.channelKey !== channelKey),
    record,
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
