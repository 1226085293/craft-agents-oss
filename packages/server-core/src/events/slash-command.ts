import {
  SLASH_COMMANDS,
  formatSlashCommandHelp,
  parseSlashCommand,
  type SlashCommandInfo,
} from '@craft-agent/shared/events/slash-commands.ts';
import { recordOutboxCall } from '@craft-agent/shared/events/outbox.ts';
import type { CraftEventEnvelope } from '@craft-agent/shared/events/types.ts';
import { deriveThreadKey, findThreadOwner } from '@craft-agent/shared/events/thread-bindings.ts';

/**
 * Extract the channel a command should answer on, from the event's origin
 * link (`message://<platform>/<channelId>/<messageId>`). The link is what the
 * plugin always carries; `channelId` is exactly what the platform's
 * `send_message` action expects.
 */
export function commandReplyChannel(event: CraftEventEnvelope): string | undefined {
  const threadKey = deriveThreadKey(event.links);
  if (!threadKey) return undefined;
  const channelId = threadKey.slice('message://'.length).split('/').pop();
  return channelId || undefined;
}

export interface SlashCommandDeps {
  /** The workspace whose outbox and thread bindings the command acts on. */
  workspaceRoot: string;
  /** Stop the turn a session is currently running. Absent: /stop reports idle. */
  stopSession?: (sessionId: string) => Promise<void>;
}

/**
 * Consume a host slash command from an incoming event.
 *
 * Returns true when the event was a catalogue command and the host executed
 * it — the caller must mark it handled and skip session dispatch. Returns
 * false for ordinary text, which keeps flowing to subscriptions / the
 * supervisor exactly as before.
 *
 * Execution is deliberately catalogue-driven: the names come from
 * SLASH_COMMANDS, so a platform never decides which commands exist.
 */
export async function executeSlashCommand(
  event: CraftEventEnvelope,
  deps: SlashCommandDeps,
): Promise<boolean> {
  const parsed = parseSlashCommand(event.body);
  if (!parsed) return false;

  const reply = (text: string): void => {
    const channelId = commandReplyChannel(event);
    if (!channelId) return;
    // Recorded as pending: the outbox dispatcher delivers it through the
    // plugin's control service (with the usual pacing / retry), so a reply
    // survives a plugin restart like any other outbound message.
    recordOutboxCall(deps.workspaceRoot, {
      listenerId: event.source,
      action: 'send_message',
      args: { channelId, text },
      ok: false,
      error: 'queued by host slash command',
    });
  };

  switch (parsed.name) {
    case 'help': {
      reply(formatSlashCommandHelp(SLASH_COMMANDS));
      break;
    }
    case 'stop': {
      const threadKey = deriveThreadKey(event.links);
      const owner = threadKey ? findThreadOwner(deps.workspaceRoot, threadKey) : undefined;
      if (owner && deps.stopSession) {
        await deps.stopSession(owner.sessionId);
        reply('Stopped.');
      } else {
        reply('Nothing is running here.');
      }
      break;
    }
    default: {
      // Unreachable while the catalogue is authoritative (parseSlashCommand
      // already rejects unknown names); the case is here so adding a command
      // is a visible change, not a silent fall-through.
      return false;
    }
  }

  return true;
}

/** The catalogue, as a plain JSON-able shape for the /host endpoint. */
export function slashCommandCatalogue(): SlashCommandInfo[] {
  return SLASH_COMMANDS.map((command) => ({ ...command }));
}
