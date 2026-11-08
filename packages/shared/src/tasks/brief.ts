/**
 * Task brief — what a worker is told when a run starts.
 *
 * This is the whole point of a structured task: a fresh session can start from
 * the task alone (instruction + spec + acceptance + last handoff) instead of
 * inheriting a supervisor's half-remembered context. Pure string building, so
 * it can be asserted in tests and shown verbatim in the UI.
 */

import type { Task } from './types.ts';
import { formatPlan } from './plan.ts';
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

/**
 * How to keep the plan, told to whoever is about to start work.
 *
 * One block, used by the task brief and by a dispatch that hands a task to a new
 * session. It lived only in the brief, and a dispatched worker therefore never saw
 * it: in a real run the worker spent ten shell calls exploring the disk and never
 * wrote a plan at all. The rule has to travel with the work, not with one of the
 * ways work is handed out.
 */
export function formatPlanRuleBlock(): string {
  return [
    '## 怎么推进',
    '',
    '1. 先用 **一次** `task_plan({ steps: [...] })` 写下大纲：3–7 条，id 用 `1`、`2`、`3`。',
    '2. 开工前把当前大纲拆成小节（`1.1`、`1.2`），然后逐条执行——小节开始前才写，不要预设没做过的部分的细节。',
    '3. 一条大纲的小节都完成后，才能把它标为 done；标 done 之前，下一条大纲的小节必须已经存在。',
    '4. 已完成的大纲和小节是记录，不能改回、不能改名——要返工就新开一条。',
    '',
  ].join('\n');
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
  // The plan rule belongs wherever a session is told to start work — the brief,
  // and a dispatch that hands over a task — not only in the tool's error messages:
  // a worker that finds out by being refused has already spent the turn.
  //
  /**
   * The agreed plan is shown, not summarised.
   *
   * A brief that said only 「计划进度：0/8」 told the worker that *a* plan existed but
   * not what was in it, so it wrote its own three outlines. The board then showed a
   * plan nobody had asked for, and the user's 「1 写文件 / 2 收尾」 was nowhere. Reading
   * the plan is free; re-deriving it is not.
   */
  if (spec?.plan?.length) {
    sections.push(
      [
        '## 已约定的执行计划（不要重写）',
        ...formatPlan(spec.plan),
        '',
        '只在这些大纲下补小节、推进状态。不要新增大纲，也不要改动已有大纲的标题。',
      ].join('\n'),
    );
  }

  sections.push(formatPlanRuleBlock());

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

  const handoffBlock = formatHandoffContext(task);
  if (handoffBlock) sections.push(handoffBlock);

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

  // The hand-off goes in even though this session has its own transcript: after a
  // long pause the transcript may have been compacted, and the hand-off is the
  // condensed statement of where the work actually stands.
  const handoffBlock = formatHandoffContext(task);

  return [
    `继续任务 ${task.id}（${task.name}）。`,
    '',
    `任务刚刚被暂停，现在恢复（原因：${reason}）。`,
    `当前状态：${state}。`,
    ...(handoffBlock ? ['', handoffBlock] : []),
    '',
    '不要从头再来，也不要重新规划已经完成的部分——那些已经冻结。',
    '从计划里没完成的那一条接着做；如果计划里没有可执行的小节，先按大纲展开下一条。',
  ].join('\n');
}

/**
 * The previous hand-off, as a block that can be handed to whoever takes over.
 *
 * One function rather than a copy per caller, because this text has to reach
 * every path that gives someone this task: a new worker's brief, a dispatch into
 * an existing session, and a resume. It used to live only inside the brief — so a
 * supervisor dispatching the next step into a running session sent its own
 * instruction and nothing else, and the recorded findings, next action and
 * artifacts stayed in the task file where nobody read them.
 *
 * Returns undefined when there is nothing to say: no hand-off yet, or the last one
 * is an open question rather than a result.
 */
export function formatHandoffContext(task: Task): string | undefined {
  const last = [...task.handoffs].reverse().find((h) => h.outcome !== 'needs_decision');
  if (!last) return undefined;
  const prior: string[] = [`上一轮结论：${last.summary}`];
  if (last.keyFindings?.length) prior.push(`已知事实：\n${bullet(last.keyFindings)}`);
  if (last.nextAction) prior.push(`下一步：${last.nextAction}`);
  if (last.artifacts?.length) prior.push(`已有产物：\n${bullet(last.artifacts.map((a) => a.path))}`);
  return `## 交接上下文\n${prior.join('\n\n')}`;
}

/**
 * What the agent taking over the next section is told.
 *
 * Short on purpose. This session is not inheriting the whole task — it is
 * inheriting one step, and it needs three things: which step, where the previous
 * one left off, and what its own section has to end with. The full brief would
 * make it re-read work it is not responsible for and invite it to re-plan a task
 * that already has a plan.
 */
export function formatNextLegBrief(task: Task, step: { id: string; title: string; note?: string }): string {
  const owner = step.note ? `验收要点：${step.note}` : undefined;
  return [
    `接手任务 ${task.id}（${task.name}）的下一步：**${step.id} ${step.title}**。`,
    '',
    `任务整体：${task.instruction}`,
    ...(task.spec?.scope ? [`分工范围：${task.spec.scope}`] : []),
    ...(owner ? [owner] : []),
    '',
    formatHandoffContext(task) ?? '',
    '',
    '## 你现在要做的',
    '',
    `只做 ${step.id}：${step.title}。完成后用 task_plan 把这一步标成 done 并在 note 里写清凭什么算完成，再用 report_result 交接。`,
    '计划里其它小节不归你，不要改它们。',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * What an idle worker is told when the watchdog wakes it.
 *
 * The task is still `running` and the session ended its turn without finishing.
 * The message has to say three things or the worker will re-do work: the task is
 * unfinished, this is a continuation rather than a new instruction, and the plan
 * is the source of truth for what is left.
 */
export function formatIdleWakeBrief(task: Task): string {
  const remaining = (task.spec?.plan ?? []).filter((step) => step.status !== 'done');
  const lines = [
    `继续任务 ${task.id}（${task.name}）：上个回合结束了，但任务还没完成。`,
    '',
    `任务目标：${task.instruction}`,
  ];
  if (remaining.length > 0) {
    lines.push(
      '',
      '执行计划里还没完成的步骤：',
      ...remaining.slice(0, 12).map((step) => `- ${step.id} ${step.title}（${step.status}）`),
    );
  } else if (task.spec?.plan?.length) {
    lines.push('', '执行计划看起来已经全部完成 —— 如果是，请直接用 report_result 交接，不要重做。');
  }
  lines.push(
    '',
    '## 你现在要做的',
    '',
    '从上一次中断的地方继续，不要从头重做已经完成的部分。',
    '如果任务其实已经完成，直接 report_result 交接；如果需要人拍板，用 report_result 报 needs_decision。',
  );
  return lines.join('\n');
}


/**
 * What a worker is told when its plan is finished but nothing was filed.
 *
 * The generic idle brief says 「从上一次中断的地方继续」, which is exactly wrong here:
 * nothing is left to do. Telling it to keep working invites it to invent step 1.3 to
 * have something to report — which is what happened when the plan was complete and
 * the worker had not called report_result.
 */
export function formatUnreportedBrief(task: Task): string {
  const steps = (task.spec?.plan ?? []).filter((step) => step.status === 'done');
  return [
    `任务 ${task.id}（${task.name}）的执行计划已经全部完成，但系统没有收到你的交付记录。`,
    '',
    `已完成 ${steps.length} 个步骤。`,
    '',
    '## 你现在要做的',
    '',
    '不要再做新步骤，也不要改计划。直接调用 `report_result` 交付：',
    '- outcome：任务目标达成就用 delivered；还需要别人接手才用 handoff；确实需要人拍板才用 needs_decision',
    '- summary：说清做完了什么',
    '- artifacts：交付物真实路径（必须存在且非空）',
    '- verify：跑过的命令 + 是否通过',
    '',
    '规则门会检查这些内容；没有产物或没跑过验证会被拒绝，那就补上再交，而不是继续加步骤。',
  ].join('\n');
}
