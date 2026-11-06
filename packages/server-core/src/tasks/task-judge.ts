/**
 * Handoff judge — the second acceptance layer.
 *
 * The rule gate checks things a computer can check (files exist, commands exit
 * zero). This layer answers the question those cannot: does the delivered work
 * actually satisfy what a human wrote in `verify.requirement`?
 *
 * It runs in its own read-only session, deliberately:
 *  - the worker that produced the handoff must not grade its own work;
 *  - the judge must not be able to "fix" anything, only read and verdict.
 *
 * Everything here is prompt construction + verdict parsing, so it is testable
 * without spending a model call.
 */

import type { Handoff, Task } from '@craft-agent/shared/tasks';

export const JUDGE_VERDICT_TIMEOUT_MS = 180_000;

/** Build the judge prompt. Kept byte-stable for prompt caching. */
export function buildJudgePrompt(task: Task, handoff: Handoff): string {
  const requirement = task.verify.requirement ?? '(未填写)';
  const findings = handoff.keyFindings?.length ? handoff.keyFindings.map((f) => `- ${f}`).join('\n') : '(无)';
  const artifacts = handoff.artifacts?.length
    ? handoff.artifacts.map((a) => `- ${a.path}${a.note ? `（${a.note}）` : ''}`).join('\n')
    : '(无)';
  const verify = handoff.verify
    ? `${handoff.verify.ran.join(', ') || '(无命令)'} → ${handoff.verify.passed ? '通过' : '未通过'}`
    : '(未提供)';

  return [
    '你是验收员。只读，不要修改任何文件，不要调用会写盘的工具。',
    '',
    `任务：${task.name}（${task.id}）`,
    `原始要求：${task.instruction}`,
    '',
    '验收标准：',
    requirement,
    '',
    '执行会话交上来的材料：',
    `- 结论：${handoff.summary}`,
    `- 关键发现：\n${findings}`,
    `- 交付物：\n${artifacts}`,
    `- 自检：${verify}`,
    '',
    '请按验收标准逐条核对。可以读文件确认内容，但不要修改。',
    '最后一行必须严格输出以下两种之一（不要加别的字符）：',
    'VERDICT: PASS',
    'VERDICT: FAIL',
    '',
    '如果 FAIL，在 VERDICT 行之前用一行一句话说明未通过的原因，以「REASON:」开头。',
  ].join('\n');
}

/**
 * Parse the judge's answer.
 *
 * Fail-closed: an answer without an explicit `VERDICT: PASS` is a failure.
 * A judge that rambles must never be read as approval.
 */
export function parseJudgeVerdict(text: string): { pass: boolean; reasons: string[] } {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const verdictLine = [...lines].reverse().find((line) => /^VERDICT\s*:/i.test(line));
  const pass = Boolean(verdictLine && /^VERDICT\s*:\s*PASS\b/i.test(verdictLine));

  const reasons = lines
    .filter((line) => /^REASON\s*[:：]/i.test(line))
    .map((line) => line.replace(/^REASON\s*[:：]\s*/i, '').trim())
    .filter(Boolean);

  if (!pass && reasons.length === 0) {
    reasons.push(verdictLine ? 'judge rejected the handoff' : 'judge did not return a verdict');
  }
  return { pass, reasons };
}
