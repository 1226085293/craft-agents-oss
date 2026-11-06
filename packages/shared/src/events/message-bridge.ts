/**
 * Message → event bridge.
 *
 * Not every message is an event. The distinction that matters is *who is
 * talking*:
 *
 *  - A DM from the owner is the user typing. It goes to a session as user input,
 *    exactly like the composer, and it must never be filtered by a rule.
 *  - A group message that mentions the bot, or hits a keyword, is an **external
 *    event**: somebody else's conversation, arriving on somebody else's
 *    schedule. It belongs in the event center, where it can be filtered, routed
 *    to the right worker, deduped and audited — the same path a webhook takes.
 *
 * Keeping this separate from the router means the routing decision (which
 * session?) and the event decision (is this an event at all?) stay independent.
 */

import { randomBytes } from 'node:crypto';

import type { CraftEventEnvelope, CraftEventLink } from '../events/types.ts';

/** The slice of an inbound message this bridge needs. */
export interface BridgeableMessage {
  platform: string;
  channelId: string;
  threadId?: number;
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  chatKind?: 'private' | 'group';
  /**
   * The adapter's own @-mention verdict.
   *
   * Needed because adapters strip mention markup before dispatch: the QQ
   * adapter rewrites `<@openid> 你好` down to `你好` and keeps the fact in
   * `mentionKind`. Scanning `text` for `@name` therefore reports "not
   * mentioned" for every QQ group message. When present, this flag is
   * authoritative and the text scan is only a fallback.
   */
  mentionKind?: 'at' | 'none';
}

export interface MessageEventRules {
  /**
   * Group channels that are allowed to produce events. Empty = none.
   *
   * Separate from the messaging allow-list on purpose: being allowed to talk to
   * the bot is not the same as being allowed to wake agents.
   */
  channels?: string[];
  /** Case-insensitive substrings; a hit turns the message into an event. */
  keywords?: string[];
  /**
   * Treat an @-mention as an event even without a keyword. Default true —
   * a mention in a group *is* a request addressed to the bot.
   */
  onMention?: boolean;
}

export interface BridgeContext {
  /** The bot's own display names/usernames, for mention detection. */
  botNames?: string[];
  rules: MessageEventRules;
  now?: number;
  /**
   * Id generator. Injected so the bridge stays pure and testable, and so the
   * host keeps one id scheme (the ingest server generates `evt_…` too).
   */
  newId?: () => string;
}

/** Same shape the ingest server uses, so ids from both sources look alike. */
export function defaultEventId(): string {
  return `evt_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

export type BridgeVerdict =
  | { kind: 'user-input'; reason: string }
  | { kind: 'event'; event: CraftEventEnvelope; reason: string }
  | { kind: 'ignored'; reason: string };

/** Mention forms across the supported platforms. */
function mentions(text: string, names: string[]): boolean {
  const lower = text.toLowerCase();
  return names.some((name) => {
    const n = name.toLowerCase().replace(/^@/, '').trim();
    if (!n) return false;
    return lower.includes(`@${n}`);
  });
}

function keywordHit(text: string, keywords: string[] | undefined): string | undefined {
  if (!keywords?.length) return undefined;
  const lower = text.toLowerCase();
  return keywords.find((raw) => {
    const k = raw.trim().toLowerCase();
    return k.length > 0 && lower.includes(k);
  });
}

/** Stable across reconnects: the platform's own message identity. */
export function messageDedupeKey(msg: BridgeableMessage): string {
  const base = `${msg.platform}:${msg.channelId}:${msg.messageId}`;
  return msg.threadId !== undefined ? `${base}:${msg.threadId}` : base;
}

/**
 * Decide what one inbound message is.
 *
 * Order matters: private first (a DM is never an event), then channel
 * membership (an unlisted group is silent, not queued), then mention/keyword.
 */
export function bridgeMessage(msg: BridgeableMessage, context: BridgeContext): BridgeVerdict {
  const chatKind = msg.chatKind ?? 'private';

  // A DM is the owner typing. It is input, always, and never filtered.
  if (chatKind === 'private') {
    return { kind: 'user-input', reason: '私聊属于用户输入' };
  }

  const allowed = context.rules.channels ?? [];
  if (allowed.length === 0) {
    return { kind: 'ignored', reason: '未配置群聊事件频道' };
  }
  if (!allowed.includes(msg.channelId)) {
    return { kind: 'ignored', reason: `频道 ${msg.channelId} 不在事件白名单` };
  }

  const hitKeyword = keywordHit(msg.text, context.rules.keywords);
  // Prefer the adapter's verdict: it saw the raw payload, including mention
  // markup that never survives into `text`.
  const addressedToBot =
    msg.mentionKind === 'at' || mentions(msg.text, context.botNames ?? []);
  const hitMention = (context.rules.onMention ?? true) && addressedToBot;
  if (!hitKeyword && !hitMention) {
    return { kind: 'ignored', reason: '未命中关键词或 @提及' };
  }

  const now = context.now ?? Date.now();
  const links: CraftEventLink[] = [
    {
      rel: 'source',
      // A deep link back to the message. Platforms differ, so this stays a
      // best-effort pointer rather than a promise; the five-field rule needs
      // *a* link back, not a canonical one.
      url: `message://${msg.platform}/${msg.channelId}/${msg.messageId}`,
    },
  ];

  const summary = (msg.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  // Say where it happened. A bare `提到了你` reads the same for a group and a
  // DM, and a reader with no channel to look at fills the gap by guessing —
  // observed: a group message described to the user as a private message.
  const where = msg.channelId.startsWith('group:') ? '在群里提到了你' : '提到了你';

  const event: CraftEventEnvelope = {
    spec: 'craft-event/1',
    id: (context.newId ?? defaultEventId)(),
    source: msg.platform,
    type: 'message.mention',
    receivedAt: now,
    dedupeKey: messageDedupeKey(msg),
    title: `${msg.senderName ?? msg.senderId} · ${hitKeyword ? `命中关键词「${hitKeyword}」` : where}`,
    summary,
    recipients: [],
    links,
    attachments: [],
    body: msg.text,
    delivered: false,
  };

  return {
    kind: 'event',
    event,
    reason: hitKeyword ? `命中关键词「${hitKeyword}」` : '群里 @ 了机器人',
  };
}
