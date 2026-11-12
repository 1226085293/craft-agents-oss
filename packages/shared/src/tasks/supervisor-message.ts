/**
 * The header every message into a supervisor lane carries.
 *
 * One formatter for every entrance because the same intent written at each call site is how the
 * sources diverged: four prefixes (「【新任务 …已登记】」, 「【用户对任务 …的补充要求】」,
 * 「〔任务进展〕」, 「〔巡检〕」, 「〔任务 T-x 拍板答复〕」), each read differently by the model, and
 * a prompt rule that taught 「方括号开头 = 用户本人说的话」. A progress report then looked like a
 * person's words, and the lane read permission into a message that carried none.
 *
 * The header answers three questions no prefix did:
 *  - 来源 (source) — who spoke: the person, or the system (worker hand-off, watchdog).
 *  - 类型 (type) — what this is: 新任务 / 补充要求 / 拍板答复 / 任务进展 / 巡检.
 *  - 效力 (effect) — what this authorises. Every non-human message says outright that it
 *    authorises nothing, because a lane that only sees 「任务进展」 reads progress as permission.
 *
 * The model's rule becomes 「看报头，不看括号」: only messages with 消息来源：用户 are the
 * person's words, and only those (plus a machine-stamped `humanAuthAt` on the task record) can
 * ever unlock an authorisation gate.
 */
export interface SupervisorMessageHeader {
  /** Who the words come from — 「用户（…）」 or 「系统（…）」. */
  source: string;
  /** What kind of message this is: 新任务 / 补充要求 / 拍板答复 / 任务进展 / 巡检. */
  type: string;
  /** What this message authorises; non-human messages say it authorises nothing. */
  effect: string;
  /** The task the message belongs to, appended to the type line when present. */
  taskId?: string;
}

export function formatSupervisorMessage(header: SupervisorMessageHeader, body: string): string {
  return [
    `消息来源：${header.source}`,
    `消息类型：${header.type}${header.taskId ? ` · 任务 ${header.taskId}` : ''}`,
    `效力：${header.effect}`,
    '────────',
    body,
  ].join('\n');
}
