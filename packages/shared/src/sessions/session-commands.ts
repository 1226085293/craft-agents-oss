/**
 * Session-level slash commands.
 *
 * These are commands the SESSION understands, independent of which entry point
 * delivered the text: the desktop composer (RPC SEND_MESSAGE), a bound
 * messaging chat (Telegram/QQ/... via the gateway), or another agent through
 * `send_agent_message`. Parsing lives in this dependency-free shared layer so
 * every path agrees on the syntax and nobody has to re-implement it.
 *
 * Two deliberate restrictions:
 *
 * 1. **Allowlist, not a generic `/xxx` matcher.** `/reject` is an internal
 *    plan-approval prompt that travels through the same `sendMessage` path
 *    (SessionManager.ts). A generic matcher would swallow it.
 * 2. **No arguments.** `/stop` is a command; `/stop doing that and try again`
 *    is a sentence that happens to start with a slash, and must reach the model
 *    as ordinary user text.
 *
 * The optional `@BotName` suffix is Telegram's way of addressing one bot in a
 * shared group (`/stop@MyBot`); the messaging gateway already strips it, and
 * accepting it here keeps both layers consistent.
 */

export const SESSION_COMMAND_NAMES = ['stop'] as const;

export type SessionCommandName = (typeof SESSION_COMMAND_NAMES)[number];

export interface SessionCommand {
  name: SessionCommandName;
  /** Trimmed original text, for logs and delivery receipts. */
  raw: string;
}

const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(SESSION_COMMAND_NAMES);

/**
 * Outcome of running a session command, shaped so callers can write a truthful
 * receipt instead of an unconditional "stopped".
 */
export interface SessionCommandResult {
  name: SessionCommandName;
  /** True when a turn was actually running and got cancelled. */
  stopped: boolean;
  /**
   * Messages still queued behind the stopped turn. An explicit stop ends the
   * CURRENT turn only — `onProcessingStopped` drains the queue right after, so
   * a receipt must tell the caller that more work is about to run.
   */
  queueLength: number;
}

/** `/cmd` or `/cmd@Bot`, with nothing after it. */
const COMMAND_PATTERN = /^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?$/i;

/**
 * Parse a session command, or return null when the text is ordinary content.
 *
 * Tolerates surrounding whitespace and upper-case (`  /STOP  `). Rejects
 * trailing arguments and unknown names.
 */
export function parseSessionCommand(text: string): SessionCommand | null {
  if (typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const match = trimmed.match(COMMAND_PATTERN);
  if (!match) return null;

  const name = match[1]!.toLowerCase();
  if (!ALLOWED_COMMANDS.has(name)) return null;

  return { name: name as SessionCommandName, raw: trimmed };
}

/** Convenience guard for callers that only need the boolean. */
export function isSessionCommand(text: string): boolean {
  return parseSessionCommand(text) !== null;
}
