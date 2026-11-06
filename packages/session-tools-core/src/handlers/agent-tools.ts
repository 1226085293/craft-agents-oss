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

  try {
    const result = await ctx.agentTools.dispatch({
      target,
      name: args.name,
      scope: args.scope.trim(),
      instruction: args.instruction.trim(),
      attachTaskId: args.attachTaskId,
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

  try {
    await ctx.agentTools.reportToUser({ text: clip(text, 600) ?? text, sessionId: args.sessionId });
    return successResponse('Reported to the user.');
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
  args: { name: string; instruction: string; assigneeAgentId?: string; parentTaskId?: string; dependsOn?: string[]; priority?: number },
): Promise<ToolResult> {
  if (!ctx.taskTools?.create) return errorResponse('task_create is only available to a supervisor session.');
  if (!args.name?.trim()) return errorResponse('name is required.');
  if (!args.instruction?.trim()) return errorResponse('instruction is required — it is immutable once created.');
  try {
    const { id } = await ctx.taskTools.create({
      name: args.name.trim(),
      instruction: args.instruction.trim(),
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
  args: { identifier: string; status?: string; pauseReason?: string; assigneeAgentId?: string; error?: string },
): Promise<ToolResult> {
  if (!ctx.taskTools?.update) return errorResponse('task_update is only available to a supervisor session.');
  if (!args.identifier?.trim()) return errorResponse('identifier is required.');
  try {
    const result = await ctx.taskTools.update(args.identifier, {
      status: args.status,
      pauseReason: args.pauseReason,
      assigneeAgentId: args.assigneeAgentId,
      error: args.error,
    });
    return successResponse(`Task ${args.identifier} → ${result.status}.`);
  } catch (error) {
    return errorResponse(`Failed to update the task: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
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
    id: string;
    title?: string;
    status?: string;
    note?: string;
    remove?: boolean;
  },
): Promise<ToolResult> {
  if (!ctx.taskTools?.updatePlan) {
    return errorResponse('task_plan is only available to a session working on a task.');
  }
  if (!args.identifier?.trim()) return errorResponse('identifier is required.');
  if (!args.id?.trim()) return errorResponse('id is required.');
  try {
    const result = await ctx.taskTools.updatePlan(args.identifier, {
      id: args.id.trim(),
      ...(args.title ? { title: args.title } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.remove !== undefined ? { remove: args.remove } : {}),
    });
    if (!result.ok) return errorResponse(result.error ?? 'the plan was not updated.');
    return successResponse(`Plan step ${args.id} updated.`);
  } catch (error) {
    return errorResponse(
      `Failed to update the plan: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
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
