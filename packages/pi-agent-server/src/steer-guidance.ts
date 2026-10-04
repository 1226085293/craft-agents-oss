/**
 * Mid-turn guidance wrapper (2026-10-07 misty-plain incident, refined after
 * 261007-slim-badger, strengthened after 261007-wise-boulder): the SDK's
 * steer() injects the raw text as a PLAIN user message at the next model
 * round. Three failure shapes had to be handled:
 *
 * - misty-plain: a model that treats the LAST user message as "the" question
 *   silently drops the original in-progress request — the steer ("你叫什么
 *   名字") arrived between the tool result and the next model round, and only
 *   the steer got a reply.
 * - slim-badger: the COMPLETION nudge made the model RE-LIST content it had
 *   already answered earlier in the turn ("你桌面上的文件夹刚才已经列出来
 *   了：..."), duplicating the demoted-then-re-promoted main reply and
 *   phrasing it as if the user had already seen it.
 * - wise-boulder: the soft completion nudge was STILL skipped — with two
 *   queued steers the model answered steer 1, then steer 2, and never
 *   delivered the original task's reply at all (the folder listing was
 *   collected by the tool but never presented). The note is therefore an
 *   ORDERED MANDATE: complete the original task FIRST, then answer the
 *   guidance — while still not re-listing content already presented.
 *
 * The raw guidance text stays first (transcript stays readable), and the
 * tool-interrupt judge (shouldInterruptActiveToolForGuidance in index.ts)
 * keeps receiving the RAW text, never the wrapped one.
 */
export function wrapMidTurnGuidance(message: string): string {
  const trimmed = (message ?? '').trim();
  if (!trimmed) return message;
  const note =
    "User's mid-turn guidance: address this. Rules for your next reply — " +
    'follow them in this exact order: ' +
    '(1) FIRST complete the original request that started this turn: if you ' +
    'collected results (for example tool output) but have not presented ' +
    'them to the user yet, present them now, in full — as if no guidance ' +
    'had arrived. ' +
    '(2) THEN address the guidance above. ' +
    '(3) Do NOT repeat or re-list content you already presented in an ' +
    'earlier reply of this turn (those replies are already shown to the ' +
    'user).';
  return `${trimmed}\n\n${note}`;
}
