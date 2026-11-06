/**
 * Task brief — what a worker is told when a run starts.
 *
 * This is the whole point of a structured task: a fresh session can start from
 * the task alone (instruction + spec + acceptance + last handoff) instead of
 * inheriting a supervisor's half-remembered context. Pure string building, so
 * it can be asserted in tests and shown verbatim in the UI.
 */

import type { Task } from './types.ts';

export interface TaskBriefOptions {
  /** Why this run started (cron expression, event, manual). */
  reason?: string;
  /** Absolute workspace root, when the spec paths are relative to it. */
  workspaceRoot?: string;
}

function bullet(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

export function formatTaskBrief(task: Task, options: TaskBriefOptions = {}): string {
  const sections: string[] = [];
  const id = task.id;

  sections.push(`# 任务 ${id}：${task.name}`);

  if (options.reason) sections.push(`触发方式：${options.reason}`);

  sections.push(`## 要求\n${task.instruction}`);

  const spec = task.spec;
  const contract: string[] = [];
  if (spec?.cwd) contract.push(`工作目录：${spec.cwd}`);
  if (spec?.sources?.length) contract.push(`可用数据源：${spec.sources.join('、')}`);
  if (spec?.skills?.length) contract.push(`绑定技能：${spec.skills.join('、')}`);
  if (spec?.baseline) contract.push(`对照对象：${spec.baseline}`);
  if (spec?.plan?.length) {
    const progress = spec.plan.filter((step) => step.status === 'done').length;
    contract.push(`计划进度：${progress}/${spec.plan.length}`);
  }
  if (spec?.scope) contract.push(`检查范围：${spec.scope}`);
  if (contract.length) sections.push(`## 执行边界\n${bullet(contract)}`);

  if (spec?.deliverables?.length) {
    const lines = spec.deliverables.map((d) => {
      const where = d.path ? ` → ${d.path}` : '';
      const note = d.note ? `（${d.note}）` : '';
      return `${d.kind}${where}${note}${d.required === false ? '（可选）' : ''}`;
    });
    sections.push(`## 交付物\n${bullet(lines)}`);
  }

  const acceptance = spec?.acceptance ?? [];
  if (acceptance.length) {
    const lines = acceptance.map((item) =>
      item.command ? `${item.id}：${item.check}（自检命令：${item.command}）` : `${item.id}：${item.check}`,
    );
    sections.push(`## 验收清单\n${bullet(lines)}\n\n每条都要真正验证过；交付时把跑过的命令写进 verify.ran。`);
  }

  const last = [...task.handoffs].reverse().find((h) => h.outcome !== 'needs_decision');
  if (last) {
    const prior: string[] = [`上一轮结论：${last.summary}`];
    if (last.keyFindings?.length) prior.push(`已知事实：\n${bullet(last.keyFindings)}`);
    if (last.nextAction) prior.push(`下一步：${last.nextAction}`);
    if (last.artifacts?.length) prior.push(`已有产物：\n${bullet(last.artifacts.map((a) => a.path))}`);
    sections.push(`## 交接上下文\n${prior.join('\n\n')}`);
  }

  sections.push(
    [
      '## 交作业',
      '做完后调用 report_result：',
      '- outcome：delivered（最终答案给用户）/ handoff（还要别人接着做）/ needs_decision（必须人拍板）',
      '- summary：≤200 字，说清做了什么、结论是什么',
      '- artifacts：交付物的真实路径（必须存在且非空）',
      '- verify：跑过的命令列表 + 是否通过',
      '不要在没有产物或没跑过验证的情况下报 delivered —— 规则门会拒绝。',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/** One-line description of a trigger, for the UI and the journal. */
export function describeTrigger(task: Task): string {
  const trigger = task.trigger;
  if (!trigger || trigger.kind === 'manual') return '手动';
  if (trigger.kind === 'cron') return `定时 ${trigger.expr}${trigger.timezone ? ` (${trigger.timezone})` : ''}`;
  return `事件 ${trigger.source}${trigger.types?.length ? `/${trigger.types.join(',')}` : ''}`;
}
