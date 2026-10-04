// scripts/patch-pi-coding-agent-queue-drain.ts
//
// Queue-drain fix for pi-coding-agent AgentSession (applied post-install).
//
// Bug ("no final bubble" after steer/followUp): the SDK records queued
// steer()/followUp() messages as plain strings in `_steeringMessages` /
// `_followUpMessages` and removes them in `_handleAgentEvent` on
// `message_start(role=user)` via an exact `indexOf` text match. Whenever the
// injected message's text differs even slightly from the queued string
// (image attachments, prompt-template/skill expansion drift, whitespace
// normalization), the entry is never removed. `pendingMessageCount` stays >
// 0, so pi-agent-server stamps the final reply `assistantFollowUpPending`
// and the event adapter renders it as an intermediate process step — the
// user's last bubble disappears into the process block.
//
// Fix ("plan A" — marked entries + FIFO fallback):
//   1. `_queueSteer` / `_queueFollowUp` push `{ text, _craftQueued: true }`
//      instead of a bare string.
//   2. On `message_start(role=user)`, removal becomes:
//        a. exact match against marked entries (`entry.text === messageText`);
//        b. otherwise, legacy exact match against plain-string entries;
//        c. if a marked entry is present at the head but its text did not
//           match, `shift()` it — marked entries only ever enter the queue
//           via steer()/followUp(), and injections drain FIFO, so a
//           non-matching head can only be the text-mismatched injection we
//           are trying to drain. Plain string entries are never touched by
//           the fallback, so no real queued message is lost.
//
// Downstream consumers are length/shape-tolerant: `pendingMessageCount`
// sums array lengths, `clearQueue()` resets the arrays, and craft's
// event-adapter only reads `queue_update` `steering`/`followUp` lengths.
//
// Tolerant of upstream changes: if a target pattern is not found, the patch
// is skipped with a warning (never breaks bun install).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const QUEUE_DRAIN_MARKER = "_craftQueued";

const REL = "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";

export interface QueueDrainPatchResult {
  changed: boolean;
  source: string;
  warning?: string;
}

export function patchQueueDrain(src: string): QueueDrainPatchResult {
  if (src.includes(QUEUE_DRAIN_MARKER)) {
    return { changed: false, source: src };
  }

  const TARGETS: Array<{ name: string; from: string; to: string }> = [
    {
      name: "_queueSteer marked push",
      from: [
        "    async _queueSteer(text, images) {",
        "        this._steeringMessages.push(text);",
      ].join("\n"),
      to: [
        "    async _queueSteer(text, images) {",
        "        this._steeringMessages.push({ text, _craftQueued: true });",
      ].join("\n"),
    },
    {
      name: "_queueFollowUp marked push",
      from: [
        "    async _queueFollowUp(text, images) {",
        "        this._followUpMessages.push(text);",
      ].join("\n"),
      to: [
        "    async _queueFollowUp(text, images) {",
        "        this._followUpMessages.push({ text, _craftQueued: true });",
      ].join("\n"),
    },
    {
      name: "message_start queue removal (marked entries + FIFO fallback)",
      from: [
        '            this._overflowRecoveryAttempted = false;',
        '            const messageText = contentText(event.message.content, "");',
        "            if (messageText) {",
        "                // Check steering queue first",
        "                const steeringIndex = this._steeringMessages.indexOf(messageText);",
        "                if (steeringIndex !== -1) {",
        "                    this._steeringMessages.splice(steeringIndex, 1);",
        "                    this._emitQueueUpdate();",
        "                }",
        "                else {",
        "                    // Check follow-up queue",
        "                    const followUpIndex = this._followUpMessages.indexOf(messageText);",
        "                    if (followUpIndex !== -1) {",
        "                        this._followUpMessages.splice(followUpIndex, 1);",
        "                        this._emitQueueUpdate();",
        "                    }",
        "                }",
        "            }",
      ].join("\n"),
      to: [
        '            this._overflowRecoveryAttempted = false;',
        '            const messageText = contentText(event.message.content, "");',
        "            // CRAFT PATCH (queue drain, 2026-10-07): steer()/followUp() push",
        "            // marked entries ({ text, _craftQueued: true }) into the queues.",
        "            // The legacy indexOf removal left stale entries whenever the",
        "            // injected message_start text did not exactly match the queued",
        "            // text (images, template drift, whitespace), which kept",
        "            // pendingMessageCount > 0 and made pi-agent-server stamp the",
        "            // final reply assistantFollowUpPending - hiding the last",
        "            // bubble inside process steps. Prefer the exact marked match,",
        "            // then the legacy string match; if a marked head entry's text",
        "            // did not match, shift it so the queue cannot hold residue.",
        "            const markedRemove = (queue) => {",
        "                if (!queue.length) {",
        "                    return false;",
        "                }",
        '                const exactIdx = messageText ? queue.findIndex((entry) => entry !== null && typeof entry === "object" && entry._craftQueued === true && entry.text === messageText) : -1;',
        "                if (exactIdx !== -1) {",
        "                    queue.splice(exactIdx, 1);",
        "                    this._emitQueueUpdate();",
        "                    return true;",
        "                }",
        "                const head = queue[0];",
        '                if (head !== null && typeof head === "object" && head._craftQueued === true) {',
        "                    queue.shift();",
        "                    this._emitQueueUpdate();",
        "                    return true;",
        "                }",
        "                return false;",
        "            };",
        "            if (!markedRemove(this._steeringMessages)) {",
        "                if (messageText) {",
        "                    // Legacy string entries keep the original exact-text removal.",
        "                    const steeringIndex = this._steeringMessages.indexOf(messageText);",
        "                    if (steeringIndex !== -1) {",
        "                        this._steeringMessages.splice(steeringIndex, 1);",
        "                        this._emitQueueUpdate();",
        "                    }",
        "                    else if (!markedRemove(this._followUpMessages)) {",
        "                        const followUpIndex = this._followUpMessages.indexOf(messageText);",
        "                        if (followUpIndex !== -1) {",
        "                            this._followUpMessages.splice(followUpIndex, 1);",
        "                            this._emitQueueUpdate();",
        "                        }",
        "                    }",
        "                }",
        "                else if (!markedRemove(this._followUpMessages)) {",
        "                    // Empty text (image-only injection): no legacy string",
        "                    // entry can match, just drain the marked head.",
        "                }",
        "            }",
      ].join("\n"),
    },
  ];

  for (const { name, from } of TARGETS) {
    if (!src.includes(from)) {
      return {
        changed: false,
        source: src,
        warning: `anchor not found for "${name}" - queue-drain patch skipped. pi-coding-agent may have changed upstream; re-check ${REL}.`,
      };
    }
  }

  let result = src;
  for (const { from, to } of TARGETS) {
    result = result.replace(from, to);
  }

  return { changed: true, source: result };
}

const file = path.join(import.meta.dir, "..", REL);
if (!existsSync(file)) {
  console.log(`[patch-queue-drain] skipped: ${REL} not found`);
  process.exit(0);
}

let src = readFileSync(file, "utf8");
const result = patchQueueDrain(src);
if (result.warning) {
  console.warn(`[patch-queue-drain] WARNING: ${result.warning}`);
  process.exit(0);
}
if (result.changed) {
  writeFileSync(file, result.source);
  console.log(`[patch-queue-drain] queue-drain patch applied to ${REL}`);
} else {
  console.log("[patch-queue-drain] already applied");
}
