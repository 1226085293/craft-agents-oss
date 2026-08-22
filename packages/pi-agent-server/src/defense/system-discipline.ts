/**
 * Layer 1 — System Discipline
 *
 * Execution-discipline block appended to the effective system prompt.
 *
 * Rationale (see issue #1 discussion):
 * - Layer 3 idle-word regex is removed: regex matches word surfaces, not
 *   semantics — it false-positives on ordinary transition sentences like
 *   "现在修改现有的集成点：" and is therefore unreliable in production.
 * - The empty-turn detection responsibility is absorbed here as *discipline*
 *   (a hard, verifiable instruction), not *detection* (a brittle matcher).
 * - This layer is zero-cost and cannot misjudge: it constrains the model
 *   rather than inspecting its output.
 */

/** English execution-discipline block (bilingual variants share identical semantics). */
export const EXECUTION_DISCIPLINE = `
【执行纪律 —— 硬性要求，违反即视为任务失败】
1. 完成度自检：输出 finish 前，必须逐条对照初始需求清单（goal checklist）给出状态：
   - 每一条：✅ 已完成 / 🟡 部分完成(说明原因) / ❌ 未完成(说明原因)
   - 存在 ❌ 或 🟡 时，禁止输出 finish，必须继续执行。
2. 行动优先：禁止用"接下来我将……""我打算……"等计划式表述代替实际工具调用；
   计划内容不计入进度，只有工具执行结果才计入。
3. 失败兜底：某步骤失败时，必须先尝试修复或给出替代方案，禁止静默跳过。
4. 产物校验：对 write/edit 类任务，输出 finish 前必须重新 read 回读确认内容已正确写入。
5. 及时收工（平衡句）：在确认全部 ✅ 的前提下，及时输出 finish，不要无意义地重复或追加步骤。
`;

/** English mirror of {@link EXECUTION_DISCIPLINE} for English-first prompts. */
export const EXECUTION_DISCIPLINE_EN = `
[EXECUTION DISCIPLINE — Hard requirement. Violating any rule means task failure]
1. Before outputting finish, walk through the original goal checklist item by item and report status:
   - Each item: ✅ done / 🟡 partial (reason) / ❌ not done (reason)
   - If any item is ❌ or 🟡, you MUST NOT output finish — continue working.
2. Actions before words: never replace an actual tool call with planning language
   ("Next I will…", "I plan to…"). Plans do not count as progress; tool results do.
3. Failure fallback: when a step fails, you must attempt a fix or a workaround
   before ending. Never silently skip a failed step.
4. Artifact verification: for write/edit tasks, re-read the written file before
   finish to confirm the content is correct.
5. Balanced wrap-up: once every checklist item is truly ✅, finish promptly.
   Do not repeat or append pointless steps.
`;

/** Sentinel marker used to make concatenation idempotent. */
export const DISCIPLINE_MARKER = '[EXECUTION_DISCIPLINE]';

/**
 * Detect whether the base prompt is predominantly Chinese and pick the
 * matching discipline block. The EN mirror exists for English-first prompts;
 * appending the Chinese block to an English prompt wastes context tokens and
 * dilutes instruction-following.
 */
function isChinesePrompt(basePrompt: string): boolean {
  const cjk = (basePrompt.match(/[\u4e00-\u9fff]/g) ?? []).length;
  // >5% CJK chars among letter-ish content → treat as Chinese-context prompt.
  return cjk > Math.max(20, basePrompt.length * 0.02);
}

/**
 * Append the execution-discipline block to a system prompt, idempotently.
 * Returns the input unchanged if the marker is already present.
 * The discipline language follows the base prompt (Chinese default kept for
 * backward compatibility with existing deployments).
 */
export function withExecutionDiscipline(basePrompt: string): string {
  if (basePrompt.includes(DISCIPLINE_MARKER)) {
    return basePrompt;
  }
  const block = isChinesePrompt(basePrompt) ? EXECUTION_DISCIPLINE : EXECUTION_DISCIPLINE_EN;
  return `${basePrompt}\n\n${DISCIPLINE_MARKER}\n${block}`.trim();
}

/** Remove the execution-discipline block if present (used by tests / disable path). */
export function stripExecutionDiscipline(prompt: string): string {
  const markerIndex = prompt.indexOf(DISCIPLINE_MARKER);
  if (markerIndex === -1) return prompt;
  return prompt.slice(0, markerIndex).trimEnd();
}
