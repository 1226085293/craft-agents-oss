/**
 * Multi-agent tool handlers.
 *
 * These are thin adapters: validation and wording live here, the actual
 * side-effects live in SessionManager-side callbacks (`ctx.agentTools`). That
 * split keeps the rules testable without a running app, and keeps the callbacks
 * the only place that touches session state.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
import { describeCron } from '@craft-agent/shared/tasks/cron';
import type {
  AskUserInput,
  CreateTaskInput,
  DispatchInput,
  ListQuestionsInput,
  ReportResultInput,
} from '../tool-schemas-agent.ts';

/** Line separator for the human-readable list; kept out of a template literal. */
const NEWLINE = String.fromCharCode(10);

/** Same cap as `normalizeHandoff`, applied before it ever leaves the worker. */
const MAX_SUMMARY = 200;

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Worker → supervisor.
 *
 * The outcome defaults to `handoff`: a worker that forgets to think about it
 * must not push a half-finished answer to the user.
 */
export async function handleReportResult(
  ctx: SessionToolContext,
  args: ReportResultInput,
): Promise<ToolResult> {
  if (!ctx.agentTools?.reportResult) {
    return errorResponse('report_result is not available in this context.');
  }
  if (!args.summary?.trim()) {
    return errorResponse('summary is required — say what was done in a couple of sentences.');
  }

  const payload = {
    outcome: args.outcome ?? 'handoff',
    ...(args.stepId?.trim() ? { stepId: args.stepId.trim() } : {}),
    summary: clip(args.summary, MAX_SUMMARY) ?? '',
    keyFindings: args.keyFindings?.slice(0, 5),
    nextAction: args.nextAction,
    artifacts: args.artifacts,
    verify: args.verify,
    // The payload the next round reads back through `task_get`. Optional, and deliberately opaque:
    // the shape belongs to the work, not to this schema.
    ...(args.roundResult !== undefined ? { roundResult: args.roundResult } : {}),
  };

  try {
    const result = await ctx.agentTools.reportResult(payload);
    return successResponse(result.message);
  } catch (error) {
    return errorResponse(
      `Failed to report the result: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/**
 * Supervisor → session / task / new session.
 *
 * The supervisor never executes work itself; this is the only way work leaves
 * the supervisor's context.
 */
export async function handleDispatch(
  ctx: SessionToolContext,
  args: DispatchInput,
): Promise<ToolResult> {
  if (!ctx.agentTools?.dispatch) {
    return errorResponse('dispatch is only available to a supervisor session.');
  }
  if (!args.instruction?.trim()) {
    return errorResponse('instruction is required — say what the session should do.');
  }
  if (!args.scope?.trim()) {
    return errorResponse(
      'scope is required — one sentence describing what this session is responsible for, so later dispatches can be matched to it.',
    );
  }

  const target = args.target;
  if (target.kind === 'session' && !target.sessionId?.trim()) {
    return errorResponse('target.sessionId is required when dispatching to an existing session.');
  }
  if (target.kind === 'task' && !target.taskId?.trim()) {
    return errorResponse('target.taskId is required when dispatching into a task.');
  }
  // Every unit of work must belong to a task. The runtime enforces this too —
  // this check exists so the model gets an actionable message in the same turn
  // instead of an exception from deeper down. `target.kind === 'session'` is
  // allowed to omit it because that session may already be working on a task.
  if (target.kind === 'new' && !args.attachTaskId?.trim()) {
    return errorResponse(
      'attachTaskId is required when dispatching to a new session. Tasks come from a person’s words through the user lane, not from this one — find the task with task_get, then dispatch with its id. Work with no task leaves no acceptance, no board entry, and nothing to point at afterwards.',
    );
  }

  try {
    const result = await ctx.agentTools.dispatch({
      target,
      name: args.name,
      scope: args.scope.trim(),
      instruction: args.instruction.trim(),
      attachTaskId: args.attachTaskId,
      ...(args.stepId ? { stepId: args.stepId.trim() } : {}),
      parallel: args.parallel === true,
    });
    return successResponse(result.message);
  } catch (error) {
    return errorResponse(
      `Dispatch failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/**
 * Everything this turn has to say to the person, in one list.
 *
 * This replaced two handlers — `handleReportToUser` for one statement, `handleAskUser` for a list
 * of questions — writing to two paths that delivered at two different moments. The code called them
 * 「two spellings of one thing」 in a comment while both stayed in the table. One real turn used the
 * statement path twice for one unresolved situation and drew two cards; the model had no reason to
 * prefer the other door, and the list that exists to prevent exactly that sat behind it.
 *
 * The count refusal went with the second door. It outlived the schema's own `.max(2)` by accident,
 * and a supervisor that hit it learned to stop trusting the tool — observed as 「第 3 个因为工具单次
 * 最多承载 2 个，我默认按不加处理」: a decision taken on the person's behalf because of our limit.
 */
export async function handleAskUser(
  ctx: SessionToolContext,
  args: AskUserInput,
): Promise<ToolResult> {
  if (!ctx.agentTools?.askUser) {
    return errorResponse('ask_user is only available to a supervisor session.');
  }
  const entries = args.entries ?? [];
  if (!entries.length) return errorResponse('entries must contain at least one entry.');

  const cleaned = entries.map((entry) => ({
    kind: entry.kind,
    text: entry.text?.trim() ?? '',
    options: entry.options?.map((option) => option.trim()).filter(Boolean) ?? [],
  }));
  if (cleaned.some((entry) => !entry.text)) {
    return errorResponse('Every entry needs a non-empty `text`.');
  }

  for (const entry of cleaned) {
    /**
     * A decision with no buttons is a question waiting to be misread.
     *
     * Observed on a real run: the first call passed `kind: 'decision'` with prose and no options,
     * the second passed the same situation with three buttons six seconds later, and the person
     * got two cards for one question — the first with nothing to click. Saying it without answers
     * is what makes the model reach for the tool again, so the refusal happens before a card is
     * drawn.
     */
    if (entry.kind === 'decision' && !entry.options.length) {
      return errorResponse(
        'A decision needs `options` — the answers the person can choose, at most 4. To report a conclusion use kind: completed; if work cannot continue without a person acting, use kind: blocked.',
      );
    }
    if (entry.kind !== 'decision' && entry.options.length) {
      return errorResponse(`${entry.kind} entries take no options; they are statements, not questions.`);
    }
    if (entry.options.length && entry.text.includes(entry.options[0] as string)) {
      // The same sentence twice: once as a paragraph, once as a button. The card then
      // shows the choice in two shapes and the reader cannot tell which one answers.
      return errorResponse(
        'Do not repeat the options inside `text`. Describe the situation in `text`; put the answers in `options`.',
      );
    }
  }

  try {
    await ctx.agentTools.askUser({
      entries: cleaned.map((entry) => ({
        kind: entry.kind,
        text: clip(entry.text, 600) ?? entry.text,
        ...(entry.options.length ? { options: entry.options } : {}),
      })),
      ...(args.taskId?.trim() ? { taskId: args.taskId.trim() } : {}),
    });
    /**
     * The reply says what is now waiting, not just what was written.
     *
     * The old tool answered 「Reported to the user.」 and nothing else, so a supervisor that had
     * already queued a question could not tell from the result that it was about to ask twice. The
     * list is the fact it can check — `list_questions` shows the same thing at any time.
     */
    const decisions = cleaned.filter((entry) => entry.kind === 'decision').length;
    const statements = cleaned.length - decisions;
    const parts: string[] = [];
    if (decisions) parts.push(`${decisions} 条问题（对方可点选项）`);
    if (statements) parts.push(`${statements} 条汇报`);
    return successResponse(
      `已记下${parts.join('、')}，本轮结束时一并发出。重复提交前请先用 list_questions 查看已排队的内容。`,
    );
  } catch (error) {
    return errorResponse(
      `Failed to reach the user: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/**
 * What has already been asked, and what is still waiting for an answer.
 *
 * This is the reader for the question queue, and it replaces a string comparison that could not
 * work: deciding whether two phrasings are one question is interpretation, so the asker is given
 * the list instead of the code guessing. `ask_user` returns the same list for the same reason —
 * one round trip, and no need to remember what was said two tool calls ago.
 *
 * The list is cleared when the turn ends and the questions go out. An empty list therefore means
 * 「nothing new to ask」, not 「nothing was ever asked」 — what is already with the person lives on
 * the task record, where `task_get` shows it and where the pause it justifies is decided.
 */
export async function handleListQuestions(
  ctx: SessionToolContext,
  args: ListQuestionsInput,
): Promise<ToolResult> {
  if (!ctx.agentTools?.listQuestions) {
    return errorResponse('list_questions is only available to a supervisor session.');
  }
  try {
    const rows = await ctx.agentTools.listQuestions({ ...(args.taskId?.trim() ? { taskId: args.taskId.trim() } : {}) });
    if (!rows.length) return successResponse('The question list is empty — nothing is waiting to be sent.');
    return successResponse(
      rows
        .map((row, index) => {
          const head = `${index + 1}. [${row.taskId}] ${row.question}`;
          const options = row.options?.length ? ` 选项：${row.options.join(' / ')}` : '';
          // Everything listed here is still waiting to be sent: the turn-end flush clears it.
          return `${head}${options} ${row.label ?? ''}（本轮结束时发出）`;
        })
        .join(NEWLINE),
    );
  } catch (error) {
    return errorResponse(
      `Failed to read the question list: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

// ------------------------------------------------------------
// Task tools (supervisor only)
// ------------------------------------------------------------

/**
 * User-lane supervisor: the person's words, verbatim, handed to the working lane.
 *
 * `task_create` is deliberately not in the user lane's table — it cannot dispatch, and a
 * half-created task no lane can move is the shape that got stuck before. So the user lane
 * gets this instead: it does not write the record, it only says what the person said.
 */
export async function handleCreateTask(
  ctx: SessionToolContext,
  args: CreateTaskInput,
): Promise<ToolResult> {
  if (!ctx.agentTools?.createTaskFromUser) {
    return errorResponse('create_task is only available to the user-facing supervisor.');
  }
  if (!args.request?.trim()) {
    return errorResponse('request is required — copy the user\'s words verbatim.');
  }
  try {
    const { taskId, message } = await ctx.agentTools.createTaskFromUser({
      request: args.request.trim(),
      ...(args.taskId?.trim() ? { taskId: args.taskId.trim() } : {}),
      ...(args.triggers?.length ? { triggers: args.triggers } : {}),
    });
    return successResponse(taskId ? `Task ${taskId} registered. ${message}` : message);
  } catch (error) {
    return errorResponse(`Failed to hand the request over: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/** List the workspace's tasks, newest activity first. */
export async function handleTaskList(
  ctx: SessionToolContext,
  args: { status?: string; limit?: number },
): Promise<ToolResult> {
  if (!ctx.taskTools?.list) return errorResponse('task_list is only available to a supervisor session.');
  try {
    const tasks = await ctx.taskTools.list({ status: args.status, limit: args.limit ?? 20 });
    if (tasks.length === 0) return successResponse('No tasks.');
    const lines = tasks.map(
      (t) => `- ${t.id} [${t.status}] ${t.name}${t.pauseReason ? ` (paused: ${t.pauseReason})` : ''}`,
    );
    return successResponse(lines.join('\n'));
  } catch (error) {
    return errorResponse(`Failed to list tasks: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/** One task, with its handoff trail. */
export async function handleTaskGet(
  ctx: SessionToolContext,
  args: { identifier: string; includeJournal?: boolean },
): Promise<ToolResult> {
  if (!ctx.taskTools?.get) return errorResponse('task_get is only available to a supervisor session.');
  if (!args.identifier?.trim()) return errorResponse('identifier is required.');
  try {
    const task = await ctx.taskTools.get(args.identifier, args.includeJournal === true);
    if (!task) return errorResponse(`Task not found: ${args.identifier}`);
    /**
     * The record keeps `expr` — it is what `matchesCron` runs — and gains `schedule` beside it.
     *
     * `* * * * *` is a complete expression, but read bare it looks like a template nobody filled in;
     * the supervisor quoted it back as 「cron:* * * * *」. The words say the same thing without asking
     * the reader to know cron syntax, and the expression stays for anything that needs it exactly.
     */
    const withSchedule = (source: unknown): unknown => {
      if (!source || typeof source !== 'object') return source;
      const record = source as Record<string, unknown>;
      const expr = typeof record.expr === 'string' ? record.expr : undefined;
      return expr ? { ...record, schedule: describeCron(expr) } : source;
    };
    const readable = (() => {
      const record = task as Record<string, unknown>;
      const triggers = record.triggers;
      if (Array.isArray(triggers)) return { ...record, triggers: triggers.map(withSchedule) };
      if (record.trigger) return { ...record, trigger: withSchedule(record.trigger) };
      return record;
    })();
    return successResponse(JSON.stringify(readable, null, 2));
  } catch (error) {
    return errorResponse(`Failed to read the task: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/** Advance or annotate a task. Illegal transitions are refused by the service. */
export async function handleTaskUpdate(
  ctx: SessionToolContext,
  args: {
    identifier: string;
    status?: string;
    pauseReason?: string;
    assigneeAgentId?: string;
    error?: string;
    scope?: string;
    name?: string;
    directive?: string;
    agents?: string[];
    acceptance?: Array<{ id?: string; check: string; command?: string }>;
    triggers?: unknown[];
  },
): Promise<ToolResult> {
  if (!ctx.taskTools?.update) return errorResponse('task_update is only available to a supervisor session.');
  if (!args.identifier?.trim()) return errorResponse('identifier is required.');
  try {
    const result = await ctx.taskTools.update(args.identifier, {
      status: args.status,
      pauseReason: args.pauseReason,
      assigneeAgentId: args.assigneeAgentId,
      error: args.error,
      ...(args.scope?.trim() ? { scope: args.scope.trim() } : {}),
      ...(args.name?.trim() ? { name: args.name.trim() } : {}),
      ...(args.directive?.trim() ? { directive: args.directive.trim() } : {}),
      ...(args.acceptance?.length ? { acceptance: args.acceptance } : {}),
      ...(args.triggers ? { triggers: args.triggers } : {}),
    });
    /**
     * Say what was written AND whether the status moved.
     *
     * `Task T-1 → paused.` was the whole answer, and it reads as 「you just paused it」. A
     * supervisor that had only written a directive concluded it had stopped the task itself and
     * told the user so. The two facts are separate and both cheap to state.
     */
    const wrote: string[] = []
    if (args.status) wrote.push(`状态 ${result.previousStatus} → ${result.status}`)
    if (args.directive?.trim()) wrote.push('授权指令')
    if (args.scope?.trim()) wrote.push('范围')
    if (args.name?.trim()) wrote.push('任务名')
    if (args.pauseReason) wrote.push(`暂停原因 ${args.pauseReason}`)
    if (args.acceptance?.length) wrote.push('验收项')
    if (args.assigneeAgentId) wrote.push('执行 Agent')
    if (args.error) wrote.push('错误记录')

    const changed = result.previousStatus !== result.status
    const what = wrote.length ? `已写入${wrote.join('、')}` : '没有可写入的字段'
    const state = changed
      ? `状态 ${result.previousStatus} → ${result.status}。`
      : `状态未变，仍是 ${result.status}。`
    return successResponse(
      `${args.identifier}：${what}。${state}` +
        (!args.status && result.status === 'paused'
          ? '要让它开工必须用 dispatch 派活——改状态不能启动任务。'
          : ''),
    );
  } catch (error) {
    return errorResponse(`Failed to update the task: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Render the plan as the worker should read it back.
 *
 * A write used to answer `Plan updated: 3 step(s).` — which confirms the call landed and
 * tells the reader nothing about the result. Observed consequence: a worker wrote outline
 * `2 读回确认` and, seconds later in the same turn, wrote `1.2 读回确认` as well, because
 * nothing in front of it said the first one existed. It had to remember, and it did not.
 *
 * The fix is the same one that made rejected hand-offs readable: return the fact, not a
 * receipt. Every successful write now repeats the whole plan, so a duplicate is visible
 * at the moment it is created rather than at delivery when it blocks.
 */
function renderPlan(plan: Array<{ id: string; title?: string; status?: string }> | undefined): string {
  if (!plan?.length) return '';
  const mark = (status?: string): string =>
    status === 'done' ? '[x]' : status === 'doing' ? '[>]' : status === 'blocked' ? '[!]' : '[ ]';
  const lines = plan.map((step) => {
    const depth = step.id.split('.').length - 1;
    return `${'  '.repeat(depth)}- ${mark(step.status)} ${step.id} ${step.title ?? ''}`.trimEnd();
  });
  return [
    '',
    '当前计划（同一件事只能有一个 id；已有的动作继续用它的 id 推进，不要换个名字重开一条）：',
    ...lines,
  ].join('\n');
}

/**
 * Update one step of the task's plan.
 *
 * The plan is how the watchdog tells "still working" from "went quiet" without
 * reading a transcript, so keeping it current is not bookkeeping — it is the
 * signal that keeps a live worker from being paused.
 */
export async function handleTaskPlan(
  ctx: SessionToolContext,
  args: {
    identifier: string;
    id?: string;
    title?: string;
    status?: string;
    agent?: string;
    note?: string;
    remove?: boolean;
    restructure?: { fromId: string; outlines: Array<{ id?: string; title: string }> };
    steps?: Array<{
      id: string;
      title?: string;
      status?: string;
      agent?: string;
      note?: string;
      remove?: boolean;
    }>;
  },
): Promise<ToolResult> {
  if (!ctx.taskTools?.updatePlan) {
    return errorResponse('task_plan is only available to a session working on a task.');
  }
  if (!args.identifier?.trim()) return errorResponse('identifier is required.');

  /**
   * Restructuring is its own intent, so it gets its own branch.
   *
   * Mixing it with `steps[]` would let one call report progress and rewrite the future at once,
   * and the answer to "what did this call change" would stop being readable.
   */
  if (args.restructure) {
    if (!ctx.taskTools.restructurePlan) {
      return errorResponse('restructuring is not available in this context.');
    }
    if (!args.restructure.fromId?.trim()) return errorResponse('restructure.fromId is required.');
    if (!args.restructure.outlines?.length) return errorResponse('restructure.outlines cannot be empty.');
    const result = await ctx.taskTools.restructurePlan(args.identifier, args.restructure);
    if (!result.ok) return errorResponse(result.error ?? 'restructure was refused.');
    return successResponse(
      `大纲已重排，从 ${args.restructure.fromId} 起的未开工大纲已换成：` +
        result.plan?.filter((step) => /^[0-9]+$/.test(step.id)).map((step) => `${step.id} ${step.title}`).join('；') +
        '。现在只拆这一条的小节。',
    );
  }

  // Batch form. Written in order, stopping at the first refusal: a plan that is
  // half-applied is worse than one that is unchanged, and the error names the
  // step that stopped it.
  if (args.steps?.length) {
    let applied = 0;
    let handedOffTo: string | undefined;
    let legStarted = false;
    let lastPlan: Array<{ id: string; title?: string; status?: string }> | undefined;
    for (const step of args.steps) {
      if (!step.id?.trim()) return errorResponse(`steps[${applied}].id is required.`);
      const result = await ctx.taskTools.updatePlan(args.identifier, {
        id: step.id.trim(),
        ...(step.title ? { title: step.title } : {}),
        ...(step.status ? { status: step.status } : {}),
        ...(step.agent ? { agent: step.agent } : {}),
        ...(step.note !== undefined ? { note: step.note } : {}),
        ...(step.remove !== undefined ? { remove: step.remove } : {}),
      });
      if (!result.ok) {
        return errorResponse(
          `Plan not updated at ${step.id}: ${result.error ?? 'refused'}${applied ? ` (${applied} earlier step(s) were applied)` : ''}`,
        );
      }
      applied += 1;
      lastPlan = result.plan;
      // An ownership boundary ends this worker's authority over the plan; writing
      // more steps after it would edit work that now belongs to someone else.
      if (result.handedOffTo) {
        handedOffTo = result.handedOffTo;
        legStarted = result.legStarted === true;
        break;
      }
    }
    return successResponse(
      handedOffTo
        ? boundaryNotice(applied, handedOffTo, legStarted)
        : `Plan updated: ${applied} step(s).${renderPlan(lastPlan)}`,
    );
  }

  if (!args.id?.trim() && !args.steps?.length) {
    /**
     * Reading the plan is a legitimate call, not a missing argument.
     *
     * Observed: a worker trying to look at the plan called `task_plan({identifier})`
     * and got `id is required`, then tried `task_plan({identifier, id:'2'})` and got
     * `a new step needs a title`. Two failed writes to answer one read. The brief shows
     * the plan at turn start, but a worker several tool calls deep has no way to ask.
     *
     * A read is free and cannot corrupt anything — the alternative is a model guessing
     * at what it already wrote.
     */
    const task = (await ctx.taskTools.get(args.identifier, false)) as
      | { spec?: { plan?: Array<{ id: string; title?: string; status?: string }> } }
      | null;
    if (!task) return errorResponse(`Task ${args.identifier} was not found.`);
    const plan = task.spec?.plan;
    return successResponse(
      plan?.length
        ? `当前计划：${renderPlan(plan)}`
        : '当前计划为空 —— 还没有任何步骤。',
    );
  }

  if (!args.id?.trim()) return errorResponse('id is required (or pass steps[] to write several).');
  try {
    const result = await ctx.taskTools.updatePlan(args.identifier, {
      id: args.id.trim(),
      ...(args.title ? { title: args.title } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.agent ? { agent: args.agent } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.remove !== undefined ? { remove: args.remove } : {}),
    });
    if (!result.ok) return errorResponse(result.error ?? 'the plan was not updated.');
    if (result.handedOffTo) {
      return successResponse(boundaryNotice(1, result.handedOffTo, result.legStarted === true));
    }
    return successResponse(`Plan step ${args.id} updated.${renderPlan(result.plan)}`);
  } catch (error) {
    return errorResponse(
      `Failed to update the plan: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/**
 * What the worker is told when its step closed an ownership boundary.
 *
 * Written as an instruction, not a status line, because the failure mode is a
 * worker that reads "step updated" and keeps going into someone else's section.
 *
 * Whether a session was opened is the caller's answer, not an assumption: this used
 * to say 「已经为它开了一个新会话」 unconditionally, and when the start was refused the
 * worker repeated it in its hand-off, the supervisor repeated it to the user, and a
 * session that never existed was described as the one continuing the work.
 */
function boundaryNotice(applied: number, agent: string, started: boolean): string {
  return [
    `Plan updated: ${applied} step(s).`,
    '',
    started
      ? `本节已完成，下一节归 ${agent}。已经为它开了一个新会话并交代了上下文。`
      : `本节已完成，下一节归 ${agent}。**新会话还没开起来**（这一轮仍持有任务，或启动被拒绝），交接后由督导安排。`,
    '**到此为止：不要继续做下一节，也不要再改这份计划。** 用 report_result 交接你这一段的工作即可。',
  ].join(String.fromCharCode(10));
}

/** Record a handoff produced by another session (the rule gate still applies). */
export async function handleTaskHandoff(
  ctx: SessionToolContext,
  args: { identifier: string; handoff: Record<string, unknown>; fromSessionId?: string },
): Promise<ToolResult> {
  if (!ctx.taskTools?.handoff) return errorResponse('task_handoff is only available to a supervisor session.');
  if (!args.identifier?.trim()) return errorResponse('identifier is required.');
  try {
    const result = await ctx.taskTools.handoff(
      args.identifier,
      args.handoff,
      args.fromSessionId ?? ctx.sessionId,
    );
    return successResponse(
      result.passed
        ? `Handoff accepted; task is now ${result.status}.`
        : `Handoff rejected: ${result.reasons.join('; ')}`,
    );
  } catch (error) {
    return errorResponse(`Failed to record the handoff: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
