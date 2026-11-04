/**
 * Event Center — envelope, limits and validation.
 *
 * A listener (a user script supervised by Craft) POSTs an `EventInput` to the
 * local ingest server. Craft owns the identity fields: `id`, `source` and
 * `receivedAt` are generated here, never taken from the payload, so a listener
 * cannot forge another listener's events or collide on ids.
 *
 * Spec: craft-event/1 (see docs: event-center design).
 */

export const EVENT_SPEC = 'craft-event/1' as const;

/** Hard limits. Anything above is rejected rather than truncated silently. */
export const EVENT_LIMITS = {
  title: 200,
  summary: 500,
  /** `body` is stored inline. Larger payloads must go through `payloadRef`. */
  bodyBytes: 2 * 1024 * 1024,
  dedupeKey: 200,
  /** Per-array caps. */
  recipients: 20,
  recipientLength: 64,
  links: 10,
  urlLength: 2048,
  attachments: 20,
  attachmentName: 200,
  attachmentPath: 1024,
  /** `occurredAt` may not be further than this ahead of `receivedAt`. */
  clockSkewMs: 5 * 60 * 1000,
} as const;

/** `namespace.action`, e.g. `mail.received`, `github.push`. */
const TYPE_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/;

export interface CraftEventLink {
  rel?: string;
  url: string;
}

export interface CraftEventPayloadRef {
  kind: string;
  path: string;
  size?: number;
}

/**
 * A file that arrived with the event, already written to disk by the listener.
 *
 * Only the location travels in the envelope: attachments are routinely far
 * larger than an inline body, and the reader pulls content on demand when the
 * user opens one.
 */
export interface CraftEventAttachment {
  /** Display name, e.g. `发票.pdf`. */
  name: string;
  /** Best-effort MIME type; `application/octet-stream` when unknown. */
  mime: string;
  /** Absolute path on this machine, inside the workspace's `events-data`. */
  path: string;
  size?: number;
  /**
   * True for an image the mail body embeds (Content-ID) rather than a separate
   * file. The renderer draws these where the body references them, and they are
   * not listed as attachments.
   */
  inline?: boolean;
}

/**
 * A stored event. This is the shape the store returns and the UI renders.
 */
export interface CraftEventEnvelope {
  spec: typeof EVENT_SPEC;
  id: string;
  source: string;
  receivedAt: number;
  type: string;
  occurredAt?: number;
  dedupeKey?: string;
  title: string;
  summary?: string;
  recipients: string[];
  links: CraftEventLink[];
  attachments: CraftEventAttachment[];
  body?: string;
  payloadRef?: CraftEventPayloadRef;
  /** Whether the event was delivered to at least one subscribed session. */
  delivered: boolean;
}

/** What a listener is allowed to send. Identity fields are absent on purpose. */
export interface EventInput {
  type: string;
  title: string;
  summary?: string;
  occurredAt?: number | string;
  dedupeKey?: string;
  recipients?: string[];
  links?: CraftEventLink[];
  attachments?: CraftEventAttachment[];
  body?: unknown;
  payloadRef?: CraftEventPayloadRef;
}

export type EventValidationError =
  | { ok: false; code: 'invalid_payload'; path: string; message: string }
  | { ok: false; code: 'body_too_large'; path: 'body'; message: string };

export type EventValidationResult = { ok: true; event: CraftEventEnvelope } | EventValidationError;

function fail(path: string, message: string): EventValidationError {
  return { ok: false, code: 'invalid_payload', path, message };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArray(value: unknown, cap: number, maxLength: number, path: string): string[] | EventValidationError {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail(path, 'must be an array of strings');
  if (value.length > cap) return fail(path, `at most ${cap} entries`);
  const out: string[] = [];
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== 'string') return fail(`${path}[${i}]`, 'must be a string');
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxLength) return fail(`${path}[${i}]`, `at most ${maxLength} characters`);
    out.push(trimmed);
  }
  return out;
}

function parseTimestamp(value: unknown): number | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 'invalid';
}

/**
 * Normalize + validate a listener payload into a stored envelope.
 *
 * `source` comes from the request path and `id` from the caller of this
 * function (the ingest server), so neither can be spoofed by the payload.
 */
export function normalizeEventInput(
  raw: unknown,
  identity: { id: string; source: string; receivedAt: number },
): EventValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('$', 'payload must be an object');
  }
  const input = raw as Record<string, unknown>;

  const type = asString(input.type)?.trim();
  if (!type) return fail('type', 'is required');
  if (!TYPE_PATTERN.test(type)) return fail('type', 'must look like "namespace.action" (lowercase)');

  const title = asString(input.title)?.trim();
  if (!title) return fail('title', 'is required');
  if (title.length > EVENT_LIMITS.title) return fail('title', `at most ${EVENT_LIMITS.title} characters`);

  const summaryRaw = asString(input.summary)?.trim();
  if (summaryRaw && summaryRaw.length > EVENT_LIMITS.summary) {
    return fail('summary', `at most ${EVENT_LIMITS.summary} characters`);
  }

  const recipients = stringArray(
    input.recipients,
    EVENT_LIMITS.recipients,
    EVENT_LIMITS.recipientLength,
    'recipients',
  );
  if (!Array.isArray(recipients)) return recipients;

  let links: CraftEventLink[] = [];
  if (input.links !== undefined && input.links !== null) {
    if (!Array.isArray(input.links)) return fail('links', 'must be an array');
    if (input.links.length > EVENT_LIMITS.links) return fail('links', `at most ${EVENT_LIMITS.links} entries`);
    for (const [i, entry] of input.links.entries()) {
      if (typeof entry !== 'object' || entry === null) return fail(`links[${i}]`, 'must be an object');
      const url = asString((entry as Record<string, unknown>).url)?.trim();
      if (!url) return fail(`links[${i}].url`, 'is required');
      if (url.length > EVENT_LIMITS.urlLength) return fail(`links[${i}].url`, 'too long');
      const rel = asString((entry as Record<string, unknown>).rel)?.trim();
      links.push(rel ? { rel, url } : { url });
    }
  }

  const dedupeKeyRaw = asString(input.dedupeKey)?.trim();
  if (dedupeKeyRaw && dedupeKeyRaw.length > EVENT_LIMITS.dedupeKey) {
    return fail('dedupeKey', `at most ${EVENT_LIMITS.dedupeKey} characters`);
  }

  const occurredAt = parseTimestamp(input.occurredAt);
  if (occurredAt === 'invalid') return fail('occurredAt', 'must be an ISO timestamp or epoch ms');
  if (occurredAt !== undefined && occurredAt > identity.receivedAt + EVENT_LIMITS.clockSkewMs) {
    return fail('occurredAt', 'is further in the future than the allowed clock skew');
  }

  // `body` may be a string or a JSON object; objects are serialized so the
  // store column stays TEXT and the UI can render it uniformly.
  let body: string | undefined;
  if (input.body !== undefined && input.body !== null) {
    body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > EVENT_LIMITS.bodyBytes) {
      return {
        ok: false,
        code: 'body_too_large',
        path: 'body',
        message: `body is ${bytes} bytes; limit is ${EVENT_LIMITS.bodyBytes}. Use payloadRef for large payloads.`,
      };
    }
  }

  let payloadRef: CraftEventPayloadRef | undefined;
  if (input.payloadRef !== undefined && input.payloadRef !== null) {
    if (typeof input.payloadRef !== 'object') return fail('payloadRef', 'must be an object');
    const ref = input.payloadRef as Record<string, unknown>;
    const kind = asString(ref.kind)?.trim();
    const path = asString(ref.path)?.trim();
    if (!kind) return fail('payloadRef.kind', 'is required');
    if (!path) return fail('payloadRef.path', 'is required');
    const size = typeof ref.size === 'number' && Number.isFinite(ref.size) ? ref.size : undefined;
    payloadRef = size === undefined ? { kind, path } : { kind, path, size };
  }

  let attachments: CraftEventAttachment[] = [];
  if (input.attachments !== undefined && input.attachments !== null) {
    if (!Array.isArray(input.attachments)) return fail('attachments', 'must be an array');
    if (input.attachments.length > EVENT_LIMITS.attachments) {
      return fail('attachments', `at most ${EVENT_LIMITS.attachments} entries`);
    }
    for (const [i, entry] of input.attachments.entries()) {
      if (typeof entry !== 'object' || entry === null) return fail(`attachments[${i}]`, 'must be an object');
      const item = entry as Record<string, unknown>;
      const name = asString(item.name)?.trim();
      if (!name) return fail(`attachments[${i}].name`, 'is required');
      if (name.length > EVENT_LIMITS.attachmentName) return fail(`attachments[${i}].name`, 'too long');
      const path = asString(item.path)?.trim();
      if (!path) return fail(`attachments[${i}].path`, 'is required');
      if (path.length > EVENT_LIMITS.attachmentPath) return fail(`attachments[${i}].path`, 'too long');
      const mime = asString(item.mime)?.trim() || 'application/octet-stream';
      const size = typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : undefined;
      const inline = item.inline === true;
      attachments.push({
        name,
        mime,
        path,
        ...(size === undefined ? {} : { size }),
        ...(inline ? { inline: true } : {}),
      });
    }
  }

  return {
    ok: true,
    event: {
      spec: EVENT_SPEC,
      id: identity.id,
      source: identity.source,
      receivedAt: identity.receivedAt,
      type,
      ...(occurredAt !== undefined ? { occurredAt } : {}),
      ...(dedupeKeyRaw ? { dedupeKey: dedupeKeyRaw } : {}),
      title,
      ...(summaryRaw ? { summary: summaryRaw } : {}),
      recipients,
      links,
      attachments,
      ...(body !== undefined ? { body } : {}),
      ...(payloadRef ? { payloadRef } : {}),
      delivered: false,
    },
  };
}

/** True for CJK ideographs and kana — scripts FTS5's unicode61 cannot split. */
function isUnsegmented(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // kana
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xf900 && cp <= 0xfaff) // CJK compatibility
  );
}

/**
 * Turn text into a space-separated form FTS5's unicode61 tokenizer can index
 * for CJK: every unsegmented character becomes its own token, so a 2-char
 * query like `付款` matches.
 *
 * Measured (Node 22 / SQLite 3.51): `trigram` cannot match 2-character CJK
 * queries at all, while this bigram form matches 2, 3 and 4 character queries.
 * Queries must be passed through the same function.
 */
export function bigramText(text: string | undefined): string {
  if (!text) return '';
  let out = '';
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (isUnsegmented(cp)) {
      if (out && !out.endsWith(' ')) out += ' ';
      out += `${char} `;
    } else if (/\s/.test(char)) {
      if (out && !out.endsWith(' ')) out += ' ';
    } else {
      out += char;
    }
  }
  return out.trim();
}
