import type { Message, StoredMessage } from './message.ts';

/**
 * Coerce a message body to the string the transcript contract promises.
 *
 * `Message.content` is text. The one thing that has ever violated that is the
 * SDK's content-block array (`[{ type: 'text', text }]`), which a writer cast
 * through `as never` to satisfy the compiler (SessionManager.appendSyntheticMessage —
 * fixed at the source). Because the renderer's turn builder calls
 * `content.trim()`, a single such row made every load of that session throw
 * `message.content?.trim is not a function` and take the whole chat panel down
 * to the error boundary.
 *
 * Rows already on disk cannot be fixed retroactively, so the conversion points
 * flatten blocks back to text: read-side so old sessions open again, write-side
 * so no new row can ever carry a non-string body.
 */
function toTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text;
        }
        return '';
      })
      .filter((part) => part.length > 0)
      .join('\n');
  }
  return String(content);
}

/**
 * Convert runtime Message to StoredMessage for persistence.
 *
 * Excludes transient runtime-only fields:
 * - isStreaming
 * - isPending
 */
export function messageToStored(msg: Message): StoredMessage {
  const { role, isStreaming, isPending, ...rest } = msg;
  return { ...rest, content: toTextContent(rest.content), type: role } as StoredMessage;
}

/**
 * Convert StoredMessage to runtime Message.
 *
 * Adds a timestamp fallback for legacy messages where timestamp was omitted.
 */
export function storedToMessage(stored: StoredMessage): Message {
  const { type, ...rest } = stored;
  return {
    ...rest,
    content: toTextContent(rest.content),
    role: type,
    timestamp: stored.timestamp ?? Date.now(),
  } as Message;
}
