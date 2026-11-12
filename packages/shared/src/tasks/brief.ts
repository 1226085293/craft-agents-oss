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
import { nextLeg, openSteps } from './plan.ts';
import { planProgress } from './plan.ts';

export interface TaskBriefOptions {
  /** Why this run started (cron expression, event, manual). */
  reason?: string;
  /** Absolute workspace root, when the spec paths are relative to it. */
  workspaceRoot?: string;
  /**
   * The profiles this task may be divided between.
   *
   * Passed in rather than read here because the roster lives in the workspace config, and this
   * module is pure. A sub-step names its owner at creation, so the list has to be in front of the
   * plan writer — not behind a tool call it may never make.
   */
  roster?: Array<{ id: string; name?: string; gist?: string; dispatchHint?: string; persona?: string; isDefault?: boolean }>;
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
/**
 * Who can do the work, as the plan writer needs to see it.
 *
 * A sub-step names its owner when it is created, so the worker making that decision needs the
 * roster at that moment. It used not to have one: owners were either copied from the outline or
 * invented, and a name that matches no profile is dispatched as an agent that does not exist. The
 * hidden per-section chooser in `section-owner.ts` still runs as a backstop, but a decision made
 * with the roster in hand is better than one corrected afterwards.
 *
 * `gist` comes first because that is what a roster entry actually carries.
 *
 * The roster comes from `readAgentRoster`, whose entries are `{ id, name, gist, isDefault }` —
 * `gist` being the profile's own line about what work belongs to it (from `dispatchHint`, else the
 * persona's first line). This section read `dispatchHint`/`persona`, which those entries do not
 * have, so every line printed as a bare id with no description at all. The rules above then asked
 * the reader to choose 「按这一小节实际要做的事」 with nothing to compare it against.
 *
 * The fallbacks keep older callers working, and `name` is shown because an id is a storage key.
 */
export function formatAgentRosterSection(
  roster:
    | Array<{
        id: string;
        name?: string;
        gist?: string;
        dispatchHint?: string;
        persona?: string;
        isDefault?: boolean;
      }>
    | undefined,
): string {
  if (!roster?.length) return '';
  const lines = roster.map((entry) => {
    const hint = (entry.gist ?? entry.dispatchHint ?? entry.persona ?? '').split('\n')[0]!.trim();
    const name = entry.name?.trim();
    const who = name && name !== entry.id ? `${name}（\`${entry.id}\`）` : `\`${entry.id}\``;
    return `- ${who}${hint ? ` — ${hint.slice(0, 160)}` : ''}${entry.isDefault ? '（未指派的活默认走这里）' : ''}`;
  });
  return [
    '## 可用分工',
    ...lines,
    '',
    '写小节时从这里选人：把 `agent` 填成上面括号里的 id。按这一小节实际要做的事，对照每个人后面的说明来选；不要自己编名字，也不要把什么都填成默认。',
  ].join('\n');
}

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
    '2. **大纲只说这一阶段要达到什么，不是一件可做的事**。真正的任务是它下面的小节（`1.1`、`1.2`）：按大纲的目标去读代码，把这一节拆成能执行、能验收的小节，然后逐条做。小节在开工前才写，不要预设没做过的部分的细节。',
    '2b. **开始一条大纲之前，先检查它**：对比前面几节实际做出来的东西，这条大纲还成立吗？它的小节对不对、缺不缺、多不多？大纲成立就改小节并开工（缺/多/错都用 `task_plan` 直接改）；大纲本身不成立就用 `task_plan` 的 `restructure` 重排这条及其之后还没开工的大纲，然后只拆这一条的小节。检查的结论要落在计划里，不要只在对话里说。',
    '3. **大纲的状态不用你写**，它由小节派生：有小节开工就是进行中，小节全完成就是完成。想推进就标小节——标大纲的状态会被拒绝，因为没有东西可以标。',
    '3b. 一条小节都不许在大纲还没拆开时开工：先把大纲拆成小节。',
    '4. 已完成的和**开工过的**小节是记录：不能删、不能改回、不能改名。开工过却做不下去，就把状态改成 `blocked` 并写明原因（卡在哪、为什么放弃、下一步靠什么接上）——后面接手的人得知道这里发生过什么。要换方向就在后面加大纲。',
    '5. 写新步骤之前，先对照当前计划里已有的步骤：**同一件事只能有一个 id**。已经有“读回确认”了，就不能再列一条“读回确认”；已经存在的动作（无论做完没做完）继续用它的 id 推进状态，而不是换个名字重开一条。',
    '6. **写小节之前先读「可用分工」，每条小节都要带 `agent`**。这一步不能跳：小节是派活的单位，没有负责人的小节等于没有派出去。先看这一小节实际要做什么，再对照分工里每个人适合做什么，把 id 填进 `agent`；不要自己编名字，也不要先建好再补——缺 `agent` 的小节会被直接拒绝。',
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
    '- 交接时必须带 `stepId`（例如 `"1.2"`），写明这份报告覆盖的是哪一个小节。下一个小节要换会话执行时，系统只认「覆盖上一节的报告」——不带 stepId 的报告无法被对上，下一节会被拦下等你补交。',
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
export function formatDispatchTaskContext(
  task: Pick<Task, 'spec'>,
  options: { roster?: Array<{ id: string; name?: string; gist?: string; dispatchHint?: string; persona?: string; isDefault?: boolean }> } = {},
): string {
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
  /**
   * `scope` says what this task covers — nothing more.
   *
   * It used to be printed as 「检查范围」 while the pause logic read the same string as the
   * authorisation boundary, so one sentence answered two questions and the brief named it after
   * the wrong one. The boundary is `directive` now, and this is what it always was: the extent of
   * the work, for whoever has to divide it up.
   */
  if (spec?.scope) contract.push(`任务范围：${spec.scope}`);
  /**
   * What the person's last reply meant, in the words of whoever read it.
   *
   * This used to be a list of step ids and a numeric ceiling, printed so the worker would meet
   * the boundary before being refused by it. The ids are gone: sub-steps are invented while the
   * work happens, so a boundary naming them was a promise about a namespace that did not exist
   * yet, and 「把那个登录问题修完」 cannot be written as an id at all when the work spans two
   * outlines. The instruction says what to do; the plan says where the work currently is; the
   * reader decides how they meet.
   */
  if (spec?.directive?.text) {
    contract.push(`本次指令（用户最近一次答复的意思，以此为准）：${spec.directive.text}`);
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
  const rosterSection = formatAgentRosterSection(options.roster);
  if (rosterSection) sections.push(rosterSection);

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
  if (answeredAt > 0 && (task.spec?.directive?.at ?? 0) <= answeredAt) {
    return (
      '你已答复，但还没有人把这句话翻译成指令——所以这里不给下一步。' +
      '等督导写下 `directive`（把答复的意思写成一句话）或结束任务；' +
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
     * One line: what to do next, read from the plan.
     *
     * A separate 「本次只做到 X，到此为止」 sentence used to sit here, chosen when a boundary existed
     * and something was left outside it. It contradicted the sentence two lines above — a reply
     * that released the whole plan still produced 「到此为止」 — and the worker followed the
     * imperative branch, stopping a step short or spending the turn arguing with the plan. The
     * instruction is already stated verbatim above; restating it as a plan-shaped rule is how the
     * two drift apart.
     */
    [formatFrontierLine(task)],
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
  const directive = task.spec?.directive?.text;
  const prior: string[] = [`上一轮结论：${last.summary}`];
  if (last.keyFindings?.length) prior.push(`已知事实：\n${bullet(last.keyFindings)}`);
  if (last.nextAction) {
    /**
     * The hand-off's next action is still passed on, marked as subordinate.
     *
     * It used to be dropped whenever a boundary existed, because two competing instructions left
     * the worker to guess which won — observed: 「上一轮结论：边界只有 1.1」 next to 「下一步：从 1.2
     * 读回确认继续」, and it followed the second into work that had just been excluded. Dropping it
     * is not right either: the last worker's next action is real knowledge. One line saying which
     * of the two wins is enough, and it is the line a person would say.
     */
    prior.push(
      directive
        ? `下一步（上一轮留下的，若与本次指令冲突以指令为准）：${last.nextAction}`
        : `下一步：${last.nextAction}`,
    );
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
    ...(task.spec?.scope ? [`任务范围：${task.spec.scope}`] : []),
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
/**
 * Tell the supervisor that a pause is waiting to be explained.
 *
 * Deliberately not `formatIdleWakeBrief`: that one says 「继续任务」 and is addressed to a worker.
 * This pause is a stop the person has to release, and the only thing missing is the sentence — so
 * the brief names the state, what is left, and that speaking to the user is the whole job. Waking
 * the supervisor without saying this makes it guess, and a supervisor that guesses resumes work
 * the person had frozen.
 */
export function formatPauseBrief(task: Task): string {
  const remaining = openSteps(task.spec?.plan);
  const lines = [
    `任务 ${task.id}（${task.name}）已经暂停，等你把结论告诉用户。`,
    '',
    `任务目标：${task.instruction}`,
  ];
  const directive = task.spec?.directive?.text?.trim();
  if (directive) lines.push('', `用户当时给的授权边界：${directive}`);
  if (remaining.length > 0) {
    lines.push(
      '',
      '计划里还没做的步骤（现在不要做）：',
      ...remaining.slice(0, 12).map((step) => `- ${step.id} ${step.title}（${step.status}）`),
    );
  }
  lines.push(
    '',
    '## 你现在要做的',
    '',
    '用 `report_to_user` 告诉用户：这一段做完了、按他的指示停在这里、还差哪些步骤、要不要放行。',
    '**不要派活，不要继续执行，也不要用 ask_user 再问一遍已经问过的事** —— 这一轮只负责说明。',
  );
  return lines.join('\n');
}

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
