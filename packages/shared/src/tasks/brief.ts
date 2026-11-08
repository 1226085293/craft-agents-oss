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
import { isAuthorizedStep, nextLeg, openSteps } from './plan.ts';
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
export function formatPlanRuleBlock(options: { planExists?: boolean } = {}): string {
  /**
   * The plan is a record, not a draft.
   *
   * Rule 1 used to read 「先用一次 task_plan 写下大纲：3–7 条」, unconditionally. So a worker
   * whose task already had an agreed plan was told to write a new one anyway — and a brief
   * that says 「当前执行计划」 while the rules below it say 「先写大纲」 is asking for two
   * different things. One real worker resolved the conflict by writing outline `2 读回确认`
   * and then `1.2 读回确认` in the same turn: the same action under two ids.
   *
   * Steps change for exactly two reasons — the plan was wrong, or something is missing.
   * Neither is "I just started". When a plan is already agreed the worker's job is to
   * advance it, and a rule that invites fresh outline-writing every turn guarantees drift.
   */
  const ruleOne = options.planExists
    ? '1. 计划已经约定好了，**不要重写**。步骤只在两种情况下改动：计划本身写错了（某一步实际不成立），或者漏了一步必须做的事。开工不是改计划的理由——正常情况下你只需要推进状态。'
    : '1. 计划还没有。先用 **一次** `task_plan({ steps: [...] })` 写下大纲：3–7 条，id 用 `1`、`2`、`3`。写下去之后它就是记录，不是草稿。它和 `report_result` 都在 `tools_agent` 分类下——分层模式下先展开它。';

  return [
    '## 怎么推进',
    '',
    ruleOne,
    '2. 大纲拆成小节（`1.1`、`1.2`）后逐条执行——小节开始前才写，不要预设没做过的部分的细节。',
    '2b. **开始一条大纲之前，先检查它**：对比前面几节实际做出来的东西，这条大纲还成立吗？它的小节对不对、缺不缺、多不多？大纲成立就改小节并开工（缺/多/错都用 `task_plan` 直接改）；大纲本身不成立就用 `task_plan` 的 `restructure` 重排这条及其之后还没开工的大纲，然后只拆这一条的小节。检查的结论要落在计划里，不要只在对话里说。',
    '3. 一条大纲的小节都完成后，才能把它标为 done；标 done 之前，下一条大纲的小节必须已经存在。',
    '4. 已完成的大纲和小节是记录，不能改回、不能改名——要返工就新开一条。',
    '5. 写新步骤之前，先对照当前计划里已有的步骤：**同一件事只能有一个 id**。已经有“读回确认”了，就不能再列一条“读回确认”；已经存在的动作（无论做完没做完）继续用它的 id 推进状态，而不是换个名字重开一条。',
    '',
  ].join('\n');
}

/**
 * What to do at the end of a slice — and which `report_result` outcome says it.
 *
 * 怎么推进 tells a worker how to keep the plan; it says nothing about how a turn ends.
 * So every worker invented its own ending, and the two failure modes both come from
 * that: one stops mid-plan without filing anything (the task sits 进行中 forever, and
 * the watchdog has to wake it), another files `delivered` on a slice it merely finished
 * and closes a task that still had three steps. The outcome enum has exactly three
 * values and the choice between them is not a judgement call, so it is written down.
 */
export function formatExecutionRuleBlock(): string {
  return [
    '## 执行规则',
    '',
    '- 每做完一个小节，**立刻**用 `task_plan` 把它标成 done。计划是记录：没标状态的步骤，读的人只能认为它没做。这两个工具都在 **`tools_agent`** 分类下：分层模式下先展开 `tools_agent`，再 `call_tool` 调 `task_plan` / `report_result`，不要去 `misc`、`workspace` 里找。',
    '- 分给你的部分做完了、计划里还剩没授权的步骤 → `report_result`，`outcome` 用 **handoff**。任务会交给后续会话继续，不会关闭；**不要**把剩下的步骤删掉，也不要替人决定它们是否还要做。',
    '- 整个计划都做完了 → 同样 `report_result`，`outcome` 用 **delivered**（这一版到此收尾）。别用 handoff，那会把一个已经完成的任务再挂到下一个会话头上。',
    '- 还没做完 → 继续做完，然后照样 `report_result` 交接。不要停在半路等人来问，也不要用沉默结束回合：没有交接记录的回合，对任务来说等于什么都没发生。',
    '- 只有真的需要人拍板时（删数据、停服、花钱、对外发消息、改方向、动密钥）才用 **needs_decision**，并在 `options` 里给出候选答案。能自己判断的不要往上交。',
    '',
  ].join('\n');
}

/**
 * The block a dispatch appends when it hands a task to a new session.
 *
 * The dispatch path never used the task brief, so the worker saw the rules but not the
 * plan the rules talk about. That is the same mismatch as a brief saying 「当前执行计划」
 * above rules that say 「先写大纲」 — solved differently: show the plan, then give rules
 * that match what it contains.
 */
export function formatDispatchTaskContext(task: Pick<Task, 'spec'>): string {
  const plan = task.spec?.plan;
  const hasPlan = Boolean(plan?.length);
  const sections: string[] = [];
  if (hasPlan) {
    sections.push(['## 当前执行计划', ...formatPlan(plan)].join('\n'));
  }
  sections.push(formatPlanRuleBlock({ planExists: hasPlan }));
  // Same reason the plan rules are here: dispatch is how a worker is actually
  // started, and a rule that lives only in the brief never reaches it.
  sections.push(formatExecutionRuleBlock());
  return sections.join('\n\n');
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
  if (spec?.authorizedSteps?.length) {
    /**
     * The boundary, in the form the tool actually enforces.
     *
     * 「完成 1.2 后暂停，不执行步骤 2」 was already in `scope` and the worker ran 1.2, 2 and
     * 2.1 anyway. A rule the worker only meets as a refusal arrives after it has spent the
     * turn, so the slice is stated up front as well — with the same ids the refusal uses.
     */
    const outside = (spec.plan ?? [])
      .filter((step) => !spec.authorizedSteps!.includes(step.id))
      .map((step) => step.id);
    contract.push(
      `本次授权步骤：${spec.authorizedSteps.join('、')}` +
        (outside.length ? `（不在授权内：${outside.join('、')}——不要开工、不要标完成、不要移除，留给后续）` : ''),
    );
  }
  if (contract.length) sections.push(`## 执行边界\n${bullet(contract)}`);

  //
  // The plan rule belongs wherever a session is told to start work — the brief,
  // and a dispatch that hands over a task — not only in the tool's error messages:
  // a worker that finds out by being refused has already spent the turn.
  //
  /**
   * The current plan is shown every time — including when it is empty.
   *
   * Two failures came from not doing this. A brief that said only 「计划进度：0/8」 told
   * the worker that *a* plan existed but not what was in it, so it wrote its own three
   * outlines and the board showed a plan nobody had asked for. And when the plan was
   * genuinely empty, "no plan field" and "an empty plan" read identically in the text,
   * so the worker had no way to tell "nothing has been agreed yet" from "something has"
   * — it just started writing, inventing a second 「读回确认」 beside the one that already
   * existed under `1.2`.
   *
   * Stating the empty case costs one line and makes the instruction actionable: whether
   * a plan exists is a fact the worker needs before it decides to write anything.
   */
  if (spec?.plan?.length) {
    sections.push(
      [
        '## 当前执行计划',
        ...formatPlan(spec.plan),
        '',
        '这就是已有的全部步骤。开工前先对照一遍：同一件事只能有一个 id，已经存在的动作（包括已完成、未完成、被跳过的）**继续用它的 id 推进状态**，不要换个名字再列一条。',
        ...(spec.planAgreed ? ['大纲的标题与顺序由用户约定，不要改动或插队；需要时可以在末尾追加。'] : []),
      ].join('\n'),
    );
  } else {
    sections.push(
      [
        '## 当前执行计划',
        '',
        '（空 —— 还没有任何步骤）',
        '',
        '写大纲之前先看任务要求：里面已经点明的阶段只能用一次，之后的会话也会看到同一份计划。',
      ].join('\n'),
    );
  }

  sections.push(formatPlanRuleBlock());
  sections.push(formatExecutionRuleBlock());

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
/**
 * Is any unfinished step outside the boundary?
 *
 * The brief needs this to decide whether a boundary sentence is informative or just noise. With
 * everything authorised there is no "stop here" to announce, and printing one anyway makes the
 * brief contradict the answer quoted two lines above it.
 */
function openBeyondBoundary(task: Task): boolean {
  const plan = task.spec?.plan;
  if (!plan?.length) return false;
  const scope = task.spec;
  if (!scope?.authorizedUpTo && !scope?.authorizedSteps?.length) return false;
  return openSteps(plan).some((step) => !isAuthorizedStep(step.id, scope));
}

/**
 * What to do next, read from the plan instead of described in advance.
 *
 * Both brief paths used to end with the same sentence — 「如果计划里没有可执行的小节，先按大纲展开
 * 下一条」 — a conditional the reader has to evaluate against a plan it may not have printed,
 * about a case it may not be in. The plan already knows which case this is, so it is computed.
 *
 * The expansion branch carries the check the worker is supposed to perform before starting a
 * section, written as the three outcomes it can have. "Check whether the sub-steps are right" on
 * its own produced no action at all: the worker had nothing to compare against and started the
 * first sub-step exactly as written.
 */
export function formatFrontierLine(task: Task): string {
  /**
   * A reply that ends the task outranks the plan.
   *
   * The line is computed from the plan alone, so on a task the person had just stopped it read
   * 「下一条大纲 2「收尾」还没有小节……先判断它，再拆」 — printed directly under
   * 「用户的答复是：停止剩下的任务」. The worker follows the longer, more specific instruction,
   * which is the only thing a model can do with contradictory input.
   */
  /**
   * Nothing here reads what the answer meant.
   *
   * The line used to be suppressed when the reply "looked like" a stop, decided by a keyword
   * table — and when the table missed 「停止剩下的任务」 the brief printed 「下一条大纲 2 还没有小节
   * ……先判断它，再拆」 directly under the reply that said to stop. Interpreting the sentence is
   * the supervisor's job; this function only states what the record allows.
   */
  const answeredAt = task.decision?.answer?.at ?? 0
  if (answeredAt > 0 && (task.spec?.authorizedAt ?? 0) < answeredAt) {
    return (
      '你已答复，但还没有人把这句话翻译成授权——所以这里不给下一步。' +
      '等督导写下授权（authorizedUpTo / authorizedSteps）或结束任务；' +
      '在那之前不要开工、不要标完成、不要移除步骤。'
    );
  }
  const leg = nextLeg(task.spec?.plan);
  if (!leg) {
    const anyOpen = openSteps(task.spec?.plan).length > 0;
    return anyOpen
      ? '计划里还有没完成的内容，但都缺小节、暂时执行不了：检查大纲和它的小节是否还成立。'
      : '计划已全部完成。用 `report_result`，outcome 用 **delivered**。';
  }
  if (leg.kind === 'step') {
    return `接着做 ${leg.step.id}「${leg.step.title}」（属于大纲 ${leg.outline.id}）。`;
  }
  const { outline } = leg;
  return [
    `下一条大纲 **${outline.id}「${outline.title}」还没有小节**，现在没有可执行的步骤——先判断它，再拆：`,
    `1. 大纲 ${outline.id} 成立、但小节缺/多/错 → 用 \`task_plan\` 把 ${outline.id}.1、${outline.id}.2 写成对的，然后开始第一个；`,
    `2. 大纲 ${outline.id} 本身已经不成立（前面做出来的东西让它没意义，或者漏了一条大纲）→ 用 \`task_plan\` 的 \`restructure\` 重排 ${outline.id} 及之后的大纲，再只拆 ${outline.id} 的小节；`,
    '3. 大纲和小节都对 → 直接开始第一个小节。',
    '只能重排还没拆过的大纲：已完成、正在做、已经拆出小节的都不能动。',
  ].join('\n');
}

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
    /**
     * Where to resume is the boundary, not the next unfinished step.
     *
     * This said 「从计划里没完成的那一条接着做」 with nothing about authorisation, so a
     * resumed worker read the whole remaining plan as its job. Observed: the person
     * answered 「完成 1.2 后暂停」, the pause lifted, the supervisor resumed, and the worker
     * ran 1.2, 2 and 2.1 and delivered — work that had been explicitly excluded.
     */
    /**
     * The person's own words, then where they said to stop.
     *
     * A resumed worker was told 「从计划里没完成的那一条接着做」 and nothing else, so
     * 「完成 1.2 后暂停」 — the reason it was resumed at all — never reached it. It read the
     * whole remaining plan as its job and finished the task.
     */
    /**
     * 「用户的答复是」, not 「你的答复是」.
     *
     * The reader of this brief is the worker; the person who answered is somebody else. 「你的」
     * addressed the worker as the one who replied, which reads as though it had answered its own
     * question — the exact confusion this whole feature exists to prevent.
     */
    ...(task.decision?.answer?.text ? [`用户的答复是：${task.decision.answer.text}`] : []),
    /**
     * Say "stop here" only when something is actually left beyond the boundary.
     *
     * The line was printed whenever `authorizedUpTo` existed, so a reply that released the whole
     * plan produced a brief reading 「本次只做到 2，到此为止」 directly beneath
     * 「用户的答复是：放行步骤 2（收尾），把任务做完」. The two sentences contradict, and the
     * worker follows the imperative one — so it stopped one step short of what was asked, or
     * spent the turn arguing with the plan writer about whether 2.1 existed.
     */
    ...(!openBeyondBoundary(task)
      ? [formatFrontierLine(task)]
      : task.spec?.authorizedUpTo
      ? [
          `本次只做到 ${task.spec.authorizedUpTo}，到此为止。` +
            '之后的小节不要开工、不要标完成、不要移除——用 `report_result`（outcome 用 handoff）交接。',
        ]
      : task.spec?.authorizedSteps?.length
        ? [
            `本次只授权到：${task.spec.authorizedSteps.join('、')}。` +
              '做到这里就停下，用 `report_result`（outcome 用 handoff）交接——' +
              '授权范围之外的步骤不要开工、不要标完成、不要移除。',
          ]
        : [formatFrontierLine(task)]),
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
  /**
   * `nextAction` is the previous session's plan, not this run's authority.
   *
   * Observed in a resume: the brief said 「上一轮结论：边界只有 1.1」 and then, straight from
   * the hand-off, 「下一步：从 1.2 读回确认继续」 — two statements about what to do next, the
   * second written before the person narrowed the boundary. The resumed worker followed the
   * second one and finished work that had just been excluded.
   */
  const ceiling = task.spec?.authorizedUpTo;
  const prior: string[] = [`上一轮结论：${last.summary}`];
  if (last.keyFindings?.length) prior.push(`已知事实：\n${bullet(last.keyFindings)}`);
  if (last.nextAction) {
    /**
     * With a boundary, the hand-off's next action is not passed on at all.
     *
     * Rephrasing it was not enough — 「下一步（本次只到 1.2，超出该范围的部分不要执行）：从 1.2
     * 读回确认继续」 still hands the worker an instruction and then asks it to police its own
     * scope. The scope is already enforced where it is checkable (`applyPlanPatch` refuses a
     * step above `authorizedUpTo`), so the brief does not need to repeat a plan that was
     * written before the boundary existed. It states the boundary instead, and the omission
     * is what stops two instructions competing.
     */
    if (!ceiling) prior.push(`下一步：${last.nextAction}`);
  }
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
  const remaining = openSteps(task.spec?.plan);
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
/**
 * The nudge for a worker that stopped without filing.
 *
 * It used to assume the plan was finished, because only that case reached it. A worker
 * that finished its assigned slice — the common case, since most legs are one step — wrote
 * a summary in the transcript, never called `report_result`, and the task sat on 进行中 with
 * zero hand-offs and a supervisor nobody had woken. The plan being open is not evidence
 * that work remains for THIS session.
 */
export function formatUnreportedBrief(task: Task): string {
  const plan = task.spec?.plan ?? [];
  const done = plan.filter((step) => step.status === 'done');
  const open = openSteps(plan);
  const planFinished = plan.length > 0 && open.length === 0;

  if (planFinished) {
    return [
      `任务 ${task.id}（${task.name}）的执行计划已经全部完成，但系统没有收到你的交付记录。`,
      '',
      `已完成 ${done.length} 个步骤。`,
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

  return [
    `任务 ${task.id}（${task.name}）的回合已经结束，但系统没有收到你的交接记录。`,
    '',
    `计划里还有 ${open.length} 步没完成：${open.map((step) => `${step.id} ${step.title}`).join('；')}。`,
    '',
    '## 你现在要做的',
    '',
    '判断你手上这一步：',
    '- 已经做完了 → 调用 `report_result`，outcome 用 handoff（任务会交给后续会话继续，不会关闭），不要移除剩下的步骤',
    '- 还没做完 → 继续做完，然后同样用 `report_result` 交接',
    '',
    '在对话里写总结不算交接——任务会一直停在「进行中」，督导收不到任何消息。',
    '',
    '`report_result` 需要：summary（做完了什么）、artifacts（真实路径，必须存在且非空）、verify（跑过的命令 + 是否通过）。',
  ].join('\n');
}
