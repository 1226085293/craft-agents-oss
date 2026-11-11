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
import type {
  AskUserInput,
  DispatchInput,
  ReportResultInput,
  ReportToUserInput,
} from '../tool-schemas-agent.ts';

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
    summary: clip(args.summary, MAX_SUMMARY) ?? '',
    keyFindings: args.keyFindings?.slice(0, 5),
    nextAction: args.nextAction,
    artifacts: args.artifacts,
    verify: args.verify,
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
      'attachTaskId is required when dispatching to a new session. Call task_create first, then dispatch to that task id — work with no task leaves no acceptance, no board entry, and nothing to point at afterwards.',
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

/** Supervisor → user. Short by contract, not by convention. */
export async function handleReportToUser(
  ctx: SessionToolContext,
  args: ReportToUserInput,
): Promise<ToolResult> {
  if (!ctx.agentTools?.reportToUser) {
    return errorResponse('report_to_user is only available to a supervisor session.');
  }
  const text = args.text?.trim();
  if (!text) return errorResponse('text is required.');
  if (!args.kind) {
    return errorResponse(
      'kind is required: completed (the task is finished), decision (only a person can decide), or blocked (needs human hands). Progress updates are not reportable — the task lane already records them.',
    );
  }

  try {
    const options = args.kind === 'decision' ? args.options?.filter((o) => o.trim()) : undefined;
    if (options?.length && text.includes(options[0] as string)) {
      // The same sentence twice: once as a paragraph, once as a button. The card then
      // shows the choice in two shapes and the reader cannot tell which one answers.
      return errorResponse(
        'Do not repeat the options inside `text`. Describe the situation in `text`; put the answers in `options`.',
      );
    }
    await ctx.agentTools.reportToUser({
      text: clip(text, 600) ?? text,
      kind: args.kind,
      sessionId: args.sessionId,
      ...(args.taskId?.trim() ? { taskId: args.taskId.trim() } : {}),
      ...(options?.length ? { options } : {}),
    });
    return successResponse(
      options?.length
        ? `Reported to the user with ${options.length} button(s): ${options.join(' / ')}`
        : 'Reported to the user.',
    );
  } catch (error) {
    return errorResponse(
      `Failed to report to the user: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/** Supervisor → user, only when a decision genuinely cannot be made. */
export async function handleAskUser(
  ctx: SessionToolContext,
  args: AskUserInput,
): Promise<ToolResult> {
  if (!ctx.agentTools?.askUser) {
    return errorResponse('ask_user is only available to a supervisor session.');
  }
  if (!args.questions?.length) return errorResponse('questions must contain at least one question.');
  if (args.questions.length > 2) {
    return errorResponse('Ask at most two questions; decide the rest yourself.');
  }

  try {
    await ctx.agentTools.askUser({ questions: args.questions });
    return successResponse('Question sent to the user.');
  } catch (error) {
    return errorResponse(
      `Failed to ask the user: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

// ------------------------------------------------------------
// Task tools (supervisor only)
// ------------------------------------------------------------

/** Create a task and return its human-facing id. */
export async function handleTaskCreate(
  ctx: SessionToolContext,
  args: {
    name: string;
    instruction: string;
    scope?: string;
    deliverables?: Array<{ kind: 'file' | 'directory' | 'pr' | 'doc' | 'message'; path?: string; note?: string; required?: boolean }>;
    acceptance?: Array<{ check: string; command?: string }>;
    plan?: Array<{ id: string; title: string; agent?: string }>;
    cwd?: string;
    assigneeAgentId?: string;
    parentTaskId?: string;
    dependsOn?: string[];
    priority?: number;
  },
): Promise<ToolResult> {
  if (!ctx.taskTools?.create) return errorResponse('task_create is only available to a supervisor session.');
  if (!args.name?.trim()) return errorResponse('name is required.');
  if (!args.instruction?.trim()) return errorResponse('instruction is required — it is immutable once created.');
  try {
    const { id } = await ctx.taskTools.create({
      name: args.name.trim(),
      instruction: args.instruction.trim(),
      // The execution contract goes through `spec`, which already exists, rather
      // than adding four parallel fields to the tool payload. A task created
      // without any of these has no scope and no way to be judged — the shape
      // that let tasks be created but never verifiable.
      spec: {
        ...(args.scope?.trim() ? { scope: args.scope.trim() } : {}),
        ...(args.deliverables?.length ? { deliverables: args.deliverables } : {}),
        // Acceptance items carry an id in the spec; derive one so the caller
        // does not have to invent stable identifiers for a checklist.
        ...(args.acceptance?.length
          ? {
              acceptance: args.acceptance.map((item, index) => ({
                id: `a${index + 1}`,
                check: item.check,
                ...(item.command ? { command: item.command } : {}),
              })),
            }
          : {}),
        ...(args.plan?.length
          ? {
              plan: args.plan.map((step) => ({
                id: step.id.trim(),
                title: step.title.trim(),
                status: 'todo' as const,
                ...(step.agent ? { agent: step.agent } : {}),
              })),
              // Written from what the user asked for, so it is the agreement — append-only
              // from here on. A plan the worker shapes itself never gets this flag.
              planAgreed: true,
            }
          : {}),
        ...(args.cwd ? { cwd: args.cwd } : {}),
      },
      assigneeAgentId: args.assigneeAgentId,
      parentTaskId: args.parentTaskId,
      dependsOn: args.dependsOn,
      priority: args.priority,
    });
    return successResponse(`Task ${id} created.`);
  } catch (error) {
    return errorResponse(`Failed to create the task: ${error instanceof Error ? error.message : 'unknown error'}`);
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
    return successResponse(JSON.stringify(task, null, 2));
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
    directive?: string;
    agents?: string[];
    acceptance?: Array<{ id?: string; check: string; command?: string }>;
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
      ...(args.directive?.trim() ? { directive: args.directive.trim() } : {}),
      ...(args.acceptance?.length ? { acceptance: args.acceptance } : {}),
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
