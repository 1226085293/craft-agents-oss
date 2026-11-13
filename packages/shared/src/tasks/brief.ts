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
    return `- ${who}${hint ? ` — ${hint.slice(0, 160)}` : ''}${entry.isDefault ? '(unassigned work defaults here)' : ''}`;
  });
  return [
    '## Available owners',
    ...lines,
    '',
    'Pick the owner when you write a sub-step: put the id from the brackets above into `agent`. Choose by what this sub-step actually needs, against what each entry says it takes on; do not invent names, and do not default everything to the workspace default.',
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
    ? '1. The plan is already agreed — **do not rewrite it**. Steps change for exactly two reasons: the plan was wrong (a step does not actually hold), or something that must be done is missing. Starting is not a reason to change the plan; normally all you do is advance status.'
    : '1. There is no plan yet. Write the outline in **one** `task_plan({ steps: [...] })`: 3-7 items, ids `1`, `2`, `3`. Once written it is a record, not a draft. It and `report_result` live under the **`tools_agent`** category — in layered mode unfold it first.';

  return [
    '## How to keep it moving',
    '',
    ruleOne,
    '2. **An outline item says what this stage achieves; it is not something you can do.** The real work is its sub-steps (`1.1`, `1.2`): read the code against what the item sets out to achieve, split it into sub-steps that can be executed and accepted, then do them one by one. Write sub-steps just before starting them; do not pre-decide details of work you have not done.',
    '2b. **Check an outline item before starting it**: given what the earlier sections actually produced, does it still hold? Are its sub-steps right, missing, too many? If it holds, fix the sub-steps and start (missing, extra or wrong are all edits through `task_plan`); if the item itself no longer holds, use `task_plan` with `restructure` to re-lay this item and the unstarted ones after it, then split only this one. The conclusion of that check belongs in the plan, not only in the conversation.',
    "3. **You do not write an outline item's status**; it is derived from its sub-steps: in progress once one starts, done when all are done. To move forward, mark sub-steps — writing a section status is refused, because there is nothing to write it to.",
    '3b. No sub-step may start before its outline item is split: split the item into sub-steps first.',
    '4. Finished and **started** sub-steps are records: they cannot be deleted, reverted or renamed. If a started one cannot continue, set it to `blocked` and say why (where it is stuck, why it was abandoned, what would unblock it) — whoever picks this up has to know what happened here. To change direction, add an outline item after it.',
    '5. Before writing a new step, compare it against the steps the plan already has: **one thing, one id**. If 「read back and confirm」 already exists, do not list a second one; an existing action (done or not) keeps its id and its status is advanced, instead of being reopened under a new name.',
    '6. **Read 「Available owners」 before writing sub-steps, and name an `agent` on every one**. This step cannot be skipped: a sub-step is the unit of dispatch, and one without an owner was never dispatched. Look at what this sub-step actually needs, compare it against what each owner takes on, and put that id in `agent`; do not invent names, and do not create it first and fill it in later — a sub-step without `agent` is refused outright.',
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
    '## Execution rules',
    '',
    '- The moment a sub-step is finished, mark it done with `task_plan`. The plan is a record: a step with no status reads as not done. Both tools live under **`tools_agent`** — in layered mode unfold `tools_agent` first, then `call_tool` `task_plan` / `report_result`; do not look under `misc` or `workspace`.',
    '- A hand-off must carry `stepId` (e.g. `"1.2"`), naming the sub-step this report covers. When the next sub-step runs in another session, the system only accepts a report that covers the previous one — a report without stepId cannot be matched, and the next step waits for you to file it.',
    "- Your part is finished and the plan still has steps you were not authorised for → `report_result` with `outcome: **handoff**`. The task continues in a later session and does not close; **do not** delete the remaining steps, and do not decide on the person's behalf whether they are still wanted.",
    '- The whole plan is finished → also `report_result`, with `outcome: **delivered**` (this version ends here). Do not use handoff: that hangs a completed task on yet another session.',
    '- **Cannot do it as instructed** (missing tool, no permission, needs the supervisor to send something on your behalf) → use `handoff`, and say in `summary` what is missing and who has to do it. This step is not done — the supervisor either does it or sends someone else.\n  **Do not use `delivered`** — `delivered` means the step really is done, and the supervisor reads it as 「no further action needed」.',
    '- Not finished yet → finish it, then file `report_result` as usual. Do not stop halfway and wait to be asked, and do not end a turn in silence: a turn with no hand-off record did not happen as far as the task is concerned.',
    '- Use **needs_decision** only when a person really must decide (deleting data, stopping a service, spending money, sending something outwards, changing direction, touching credentials), and give the candidate answers in `options`. Anything you can judge yourself stays with you.',
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
    sections.push(['## Current plan', ...formatPlan(plan)].join('\n'));
  }
  sections.push(formatPlanRuleBlock({ planExists: hasPlan }));
  // Same reason the plan rules are here: dispatch is how a worker is actually
  // started, and a rule that lives only in the brief never reaches it.
  sections.push(formatExecutionRuleBlock());
  return sections.join('\n\n');
}


/**
 * What the last round delivered, for the round that has to continue from it.
 *
 * A recurring task repeats the same work, and the work usually carries state — the simplest case is
 * 「你好+N」 with N incrementing. That number used to live only in the supervisor's context: one
 * lost turn and the count restarted, because nothing on the record said what the previous round
 * produced. The record says it now (`stats.lastRound`), written when the round closed.
 */
export function formatLastRoundBlock(task: Pick<Task, 'stats'>): string {
  const last = task.stats?.lastRound;
  if (!last) return '';
  const lines: string[] = [`## Previous round (#${last.round})`, ''];
  lines.push(`Delivered: ${last.summary}`);
  const artifacts = last.result?.artifacts ?? [];
  if (artifacts.length) lines.push('', `Artefacts:\n${bullet(artifacts)}`);
  const verify = last.result?.verify;
  if (verify) {
    lines.push('', `Verification: ${verify.passed ? 'passed' : 'failed'} (${verify.ran.join('; ')})`);
  }
  /**
   * The payload, not just the prose.
   *
   * 「Collect non-duplicate items」 only works if this round can see what the previous one already
   * found; the summary cannot express that. Small enough to print, and `task_get` returns the same
   * value under `stats.lastRound.result.data` when the worker needs it structured.
   */
  if (last.result?.data !== undefined) {
    lines.push('', `Result data:
\`\`\`json
${JSON.stringify(last.result.data, null, 2)}
\`\`\``);
  }
  lines.push(
    '',
    'This task repeats. Continue from what that round produced — carry its numbers and state forward — instead of starting over from the request.',
  );
  return lines.join('\n');
}

export function formatTaskBrief(task: Task, options: TaskBriefOptions = {}): string {
  const sections: string[] = [];
  const id = task.id;

  sections.push(`# Task ${id}: ${task.name}`);

  if (options.reason) sections.push(`Triggered by: ${options.reason}`);

  sections.push(`## Request\n${task.instruction}`);

  // A repeating task's next round starts from the last round's delivery, not from the request again.
  const lastRound = formatLastRoundBlock(task);
  if (lastRound) sections.push(lastRound);

  const spec = task.spec;
  const contract: string[] = [];
  if (spec?.cwd) contract.push(`Working directory: ${spec.cwd}`);
  if (spec?.sources?.length) contract.push(`Sources available: ${spec.sources.join(', ')}`);
  if (spec?.skills?.length) contract.push(`Skills attached: ${spec.skills.join(', ')}`);
  if (spec?.baseline) contract.push(`Compare against: ${spec.baseline}`);
  if (spec?.plan?.length) {
    const progress = spec.plan.filter((step) => step.status === 'done').length;
    contract.push(`Plan progress: ${progress}/${spec.plan.length}`);
  }
  /**
   * `scope` says what this task covers — nothing more.
   *
   * It used to be printed as 「检查范围」 while the pause logic read the same string as the
   * authorisation boundary, so one sentence answered two questions and the brief named it after
   * the wrong one. The boundary is `directive` now, and this is what it always was: the extent of
   * the work, for whoever has to divide it up.
   */
  if (spec?.scope) contract.push(`Scope: ${spec.scope}`);
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
    contract.push(`This instruction (what the person's latest answer meant; it governs): ${spec.directive.text}`);
  }
  if (contract.length) sections.push(`## Boundary\n${bullet(contract)}`);

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
        '## Current plan',
        ...formatPlan(spec.plan),
        '',
        'These are all the steps there are. Compare against them before starting: one thing, one id — an existing action (done, open, or skipped) **keeps its id and its status is advanced**, never reopened under a new name.',
        ...(spec.planAgreed ? ["The outline's titles and order were agreed with the person: do not change them or insert in between; append at the end if needed."] : []),
      ].join('\n'),
    );
  } else {
    sections.push(
      [
        '## Current plan',
        '',
        '(empty — no steps yet)',
        '',
        'Read the task requirements before writing the outline: a stage the requirements already name may appear only once, and later sessions see this same plan.',
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
      return `${d.kind}${where}${note}${d.required === false ? '(optional)' : ''}`;
    });
    sections.push(`## Deliverables\n${bullet(lines)}`);
  }

  const acceptance = spec?.acceptance ?? [];
  if (acceptance.length) {
    const lines = acceptance.map((item) =>
      item.command ? `${item.id}: ${item.check} (check command: ${item.command})` : `${item.id}: ${item.check}`,
    );
    sections.push(`## Acceptance list\n${bullet(lines)}\n\nEach one must actually be verified; put the commands you ran into verify.ran when you deliver.`);
  }

  const handoffBlock = formatHandoffContext(task);
  if (handoffBlock) sections.push(handoffBlock);

  sections.push(
    [
      '## Handing in',
      'When you are done, call report_result:',
      '- outcome: delivered (final answer to the person) / handoff (someone else must continue) / needs_decision (a person must decide)',
      '- summary: ≤200 words, what you did and what the conclusion is',
      '- artifacts: the real paths of what you produced (must exist and be non-empty)',
      '- verify: the commands you ran, and whether they passed',
      'Do not report delivered without artefacts or without having run any verification — the rule gate refuses it.',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/** One-line description of a trigger, for the UI and the journal. */
export function describeTrigger(task: Task): string {
  const trigger = task.trigger;
  if (!trigger || trigger.kind === 'manual') return 'manual';
  if (trigger.kind === 'cron') return `cron ${trigger.expr}${trigger.timezone ? ` (${trigger.timezone})` : ''}`;
  return `event ${trigger.source}${trigger.types?.length ? `/${trigger.types.join(',')}` : ''}`;
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
      'You answered, but nobody has turned that answer into a directive yet — so there is no next step here. ' +
      'Wait for the supervisor to write a `directive` (the answer expressed as one sentence) or to end the task; ' +
      'until then do not start, do not mark done, do not remove steps.'
    );
  }
  const leg = nextLeg(task.spec?.plan);
  if (!leg) {
    const anyOpen = openSteps(task.spec?.plan).length > 0;
    return anyOpen
      ? 'The plan still has unfinished work, but it has no sub-steps and cannot be executed yet: check whether the outline items and their sub-steps still hold.'
      : 'The plan is finished. Use `report_result` with `outcome: **delivered**`.';
  }
  if (leg.kind === 'step') {
    return `Continue with ${leg.step.id}「${leg.step.title}」 (part of outline item ${leg.outline.id}).`;
  }
  const { outline } = leg;
  return [
    `The next outline item **${outline.id}「${outline.title}」 has no sub-steps**, so nothing is executable right now — judge it, then split it:`,
    `1. Item ${outline.id} holds but its sub-steps are missing, extra or wrong → use \`task_plan\` to write ${outline.id}.1, ${outline.id}.2 correctly, then start the first;`,
    `2. Item ${outline.id} itself no longer holds (what earlier sections produced made it pointless, or an outline item is missing) → use \`task_plan\` with \`restructure\` to re-lay ${outline.id} and the items after it, then split only ${outline.id};`,
    '3. Item and sub-steps are both right → just start the first sub-step.',
    'Only re-lay items that have not been split: done ones, ones in progress, and ones with sub-steps cannot be touched.',
  ].join('\n');
}

export function formatResumeBrief(task: Task, reason = 'manual'): string {
  const progress = task.spec?.plan?.length
    ? planProgress(task.spec.plan)
    : undefined;
  const state = progress
    ? `Plan progress ${progress.done}/${progress.total}, ${progress.doing > 0 ? 'one sub-step is in progress' : 'nothing is in progress right now'}`
    : 'this task has no plan yet';

  // The hand-off goes in even though this session has its own transcript: after a
  // long pause the transcript may have been compacted, and the hand-off is the
  // condensed statement of where the work actually stands.
  const handoffBlock = formatHandoffContext(task);

  return [
    `Continuing task ${task.id} (${task.name}).`,
    '',
    `The task was paused and is now resumed (reason: ${reason}).`,
    `Current state: ${state}.`,
    ...(handoffBlock ? ['', handoffBlock] : []),
    '',
    'Do not start over, and do not replan what is already finished — that part is frozen.',
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
    ...(task.decision?.answer?.text ? [`The person answered: ${task.decision.answer.text}`] : []),
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
  const prior: string[] = [`Previous round: ${last.summary}`];
  if (last.keyFindings?.length) prior.push(`Known facts:\n${bullet(last.keyFindings)}`);
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
        ? `Next step (left by the previous round; if it conflicts with this instruction, the instruction wins): ${last.nextAction}`
        : `Next step: ${last.nextAction}`,
    );
  }
  if (last.artifacts?.length) prior.push(`Artefacts so far:\n${bullet(last.artifacts.map((a) => a.path))}`);
  return `## Hand-off context\n${prior.join('\n\n')}`;
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
  const owner = step.note ? `Acceptance point: ${step.note}` : undefined;
  return [
    `Next step for task ${task.id} (${task.name}): **${step.id} ${step.title}**.`,
    '',
    `Task as a whole: ${task.instruction}`,
    ...(task.spec?.scope ? [`Scope: ${task.spec.scope}`] : []),
    ...(owner ? [owner] : []),
    '',
    formatHandoffContext(task) ?? '',
    '',
    '## What you do now',
    '',
    `Only ${step.id}: ${step.title}. When it is done, mark it done with task_plan and write in note why that counts as done, then hand off with report_result.`,
    'The other sub-steps are not yours; do not change them.',
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
    `Task ${task.id} (${task.name}) is paused and waiting for you to tell the person the conclusion.`,
    '',
    `Task goal: ${task.instruction}`,
  ];
  const directive = task.spec?.directive?.text?.trim();
  if (directive) lines.push('', `The boundary the person gave: ${directive}`);
  if (remaining.length > 0) {
    lines.push(
      '',
      'Steps still open in the plan (do not do them now):',
      ...remaining.slice(0, 12).map((step) => `- ${step.id} ${step.title}（${step.status}）`),
    );
  }
  lines.push(
    '',
    '## What you do now',
    '',
    'Use `report_to_user` to tell the person: this slice is finished, you stopped here on their instruction, what is still missing, and whether to release it.',
    '**Do not dispatch, do not keep executing, and do not use ask_user to re-ask what was already asked** — this turn only explains.',
  );
  return lines.join('\n');
}

export function formatIdleWakeBrief(task: Task): string {
  const remaining = openSteps(task.spec?.plan);
  const lines = [
    `Continuing task ${task.id} (${task.name}): the last turn ended but the task is not finished.`,
    '',
    `Task goal: ${task.instruction}`,
  ];
  if (remaining.length > 0) {
    lines.push(
      '',
      'Steps still open in the plan:',
      ...remaining.slice(0, 12).map((step) => `- ${step.id} ${step.title}（${step.status}）`),
    );
  } else if (task.spec?.plan?.length) {
    lines.push('', 'The plan looks finished — if it is, hand off with report_result directly, do not redo it.');
  }
  lines.push(
    '',
    '## What you do now',
    '',
    'Continue from where it stopped; do not redo what is finished.',
    'If the task is actually finished, hand off with report_result; if a person must decide, report needs_decision with report_result.',
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
      `Task ${task.id} (${task.name}) has its whole plan finished, but no delivery record arrived.`,
      '',
      `${done.length} steps are done.`,
      '',
      '## What you do now',
      '',
      'Do not do new steps and do not change the plan. Call `report_result` to deliver:',
      '- outcome: delivered when the task goal is met; handoff only when someone else must continue; needs_decision only when a person really must decide',
      '- summary: what you finished',
      '- artifacts: real paths of what you produced (must exist and be non-empty)',
      '- verify: the commands you ran, and whether they passed',
      '',
      'The rule gate checks all of this; no artefacts or no verification is refused — fill that in and hand in again, rather than adding more steps.',
    ].join('\n');
  }

  return [
    `The turn for task ${task.id} (${task.name}) ended, but no hand-off record arrived.`,
    '',
    `${open.length} steps in the plan are still open: ${open.map((step) => `${step.id} ${step.title}`).join('; ')}.`,
    '',
    '## What you do now',
    '',
    'Judge the step in your hands:',
    '- Already finished → call `report_result` with outcome handoff (the task continues in a later session and does not close); do not remove the remaining steps',
    '- Not finished → finish it, then hand off with `report_result` as well',
    '',
    'A summary written in the conversation is not a hand-off — the task sits in progress and the supervisor receives nothing.',
    '',
    '`report_result` needs: summary (what you finished), artifacts (real paths, must exist and be non-empty), verify (the commands you ran, and whether they passed).',
  ].join('\n');
}
