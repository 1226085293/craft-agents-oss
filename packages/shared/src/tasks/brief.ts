/**
 * Task brief — what a worker is told when a run starts.
 *
 * This is the whole point of a structured task: a fresh session can start from
 * the task alone (instruction + spec + acceptance + last handoff) instead of
 * inheriting a supervisor's half-remembered context. Pure string building, so
 * it can be asserted in tests and shown verbatim in the UI.
 */

import type { Task } from './types.ts';
import { planProgress } from './plan.ts';

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

  //
  // The plan rule belongs in the brief, not only in the tool's error messages:
  // a worker that finds out by being refused has already spent the turn.
  //
  sections.push(
    [
      '## 怎么推进',
      '',
      '1. 先用 **一次** `task_plan({ steps: [...] })` 写下大纲：3–7 条，id 用 `1`、`2`、`3`。',
      '2. 开工前把当前大纲拆成小节（`1.1`、`1.2`），然后逐条执行——小节开始前才写，不要预设没做过的部分的细节。',
      '3. 一条大纲的小节都完成后，才能把它标为 done；标 done 之前，下一条大纲的小节必须已经存在。',
      '4. 已完成的大纲和小节是记录，不能改回、不能改名——要返工就新开一条。',
      '',
    ].join('\n'),
  );

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

/**
 * What a resumed session is told.
 *
 * Deliberately short and in the second person: this session already has the
 * instruction, the contract and the transcript. Re-sending the whole brief would
 * make it re-read work it did, and re-plan work it already finished. All it needs
 * is "you were stopped, here is why, pick up from the plan".
 */
export function formatResumeBrief(task: Task, reason = 'manual'): string {
  const progress = task.spec?.plan?.length
    ? planProgress(task.spec.plan)
    : undefined;
  const state = progress
    ? `计划进度 ${progress.done}/${progress.total}，${progress.doing > 0 ? '有一条正在进行' : '当前没有进行中的小节'}`
    : '这条任务还没有计划';

  return [
    `继续任务 ${task.id}（${task.name}）。`,
    '',
    `任务刚刚被暂停，现在恢复（原因：${reason}）。`,
    `当前状态：${state}。`,
    '',
    '不要从头再来，也不要重新规划已经完成的部分——那些已经冻结。',
    '从计划里没完成的那一条接着做；如果计划里没有可执行的小节，先按大纲展开下一条。',
  ].join('\n');
}
