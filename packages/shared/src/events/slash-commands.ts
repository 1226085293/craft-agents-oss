/**
 * The host-owned slash command catalogue.
 *
 * Platform plugins do NOT define slash commands. At startup they fetch this
 * catalogue from the host (`POST /host/slash_commands` over the ingest
 * endpoint) and register it in their platform's command menu; when a command
 * arrives as an incoming event, the host executes it (see
 * server-core's EventService). Adding a command is a data change here plus a
 * case in the executor — no per-platform code, no per-plugin maintenance.
 *
 * Note the division of labour: a plugin still owns its conversation policy
 * (which chats are accepted, group @-mention rules). The host owns what
 * commands exist and what they do.
 */

export interface SlashCommandInfo {
  name: string;
  description: string;
}

/**
 * The slash commands the host exposes today.
 *
 * Keep `description` short: Telegram's Bot API truncates menu descriptions at
 * 25 characters, and the menu has to read well on a phone.
 */
export const SLASH_COMMANDS: readonly SlashCommandInfo[] = [
  { name: 'stop', description: 'Stop the current run' },
  { name: 'help', description: 'List available commands' },
];

/**
 * Parse a leading slash command out of a message body.
 *
 * Accepts `/stop`, `/stop@BotName` and `/stop <args>`; only names in the
 * catalogue are commands — everything else is plain text, whatever it looks
 * like.
 */
export function parseSlashCommand(
  text: string | undefined,
  catalog: readonly SlashCommandInfo[] = SLASH_COMMANDS,
): { name: string; args: string } | null {
  const match = /^\s*\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?\s*([\s\S]*)$/.exec(text ?? '');
  if (!match) return null;
  const name = (match[1] ?? '').toLowerCase();
  if (!catalog.some((command) => command.name === name)) return null;
  return { name, args: (match[2] ?? '').trim() };
}

/** The /help reply: the catalogue as a short, phone-readable list. */
export function formatSlashCommandHelp(
  catalog: readonly SlashCommandInfo[] = SLASH_COMMANDS,
): string {
  return ['Available commands:', ...catalog.map((command) => `/${command.name} — ${command.description}`)].join('\n');
}
