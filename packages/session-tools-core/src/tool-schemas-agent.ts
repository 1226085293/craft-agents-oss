/**
 * Schemas for the multi-agent tool surface.
 *
 * Split out of `tool-defs.ts` because these are the first tools whose
 * availability depends on the session's *role*, not on the workspace: a
 * supervisor gets `dispatch` / `report_to_user` / `ask_user`, a worker gets
 * `report_result`. Keeping the schemas together makes that split readable.
 */

import { z } from 'zod';

/**
 * Worker → supervisor handoff.
 *
 * `outcome` defaults to `handoff` on purpose: a worker that forgets to report
 * must not push a half-finished result to the user. The summary is capped in
 * code (200 chars) so a chatty model cannot flood the supervisor's context.
 */
export const ReportResultSchema = z.object({
  outcome: z
    .enum(['delivered', 'handoff', 'needs_decision'])
    .optional()
    .describe(
      'delivered = this is the final answer for the user; handoff = pass to the next session; needs_decision = a human must choose. Defaults to handoff.',
    ),
  summary: z
    .string()
    .describe('What was done, in at most a few sentences. This is what the user or the next session reads first.'),
  keyFindings: z.array(z.string()).optional().describe('Facts the next session must know (max 5).'),
  nextAction: z.string().optional().describe('Where the next session should start, if more work is needed.'),
  artifacts: z
    .array(
      z.object({
        path: z.string().describe('Absolute path of a file produced or changed'),
        note: z.string().optional(),
      }),
    )
    .optional()
    .describe('Deliverables. The rule gate fails the handoff if these paths do not exist.'),
  verify: z
    .object({
      ran: z.array(z.string()).describe('Commands actually executed to verify the work'),
      passed: z.boolean(),
      note: z.string().optional(),
    })
    .optional()
    .describe('Verification evidence. Required by the rule gate (at least one command).'),
});

export type ReportResultInput = z.infer<typeof ReportResultSchema>;

/** Supervisor → worker (or → new session). */
export const DispatchSchema = z.object({
  target: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('session'), sessionId: z.string() }),
      z.object({ kind: z.literal('task'), taskId: z.string() }),
      z.object({
        kind: z.literal('new'),
        agentId: z
          .string()
          .optional()
          .describe('Role id for the new session, from the roster above. Omit for the workspace default.'),
      }),
    ])
    .describe('Where the work goes: an existing session, an existing task, or a brand new session.'),
  name: z.string().optional().describe('Name for a newly created session.'),
  scope: z
    .string()
    .describe('What this session is responsible for. Required for new sessions so later dispatches can be matched.'),
  instruction: z.string().describe('The work itself: goal, acceptance criteria, where the deliverable goes.'),
  attachTaskId: z.string().optional().describe('Attach the session to this task.'),
  parallel: z
    .boolean()
    .optional()
    .describe('Allow this to run alongside the other dispatches from the same turn (max 3 per turn).'),
});

export type DispatchInput = z.infer<typeof DispatchSchema>;

/** Supervisor → user, short by contract. */
export const ReportToUserSchema = z.object({
  text: z.string().describe('At most ~100 words. Conclusions only; link the session for detail.'),
  sessionId: z.string().optional().describe('Session the user can open for the full process.'),
});

export type ReportToUserInput = z.infer<typeof ReportToUserSchema>;

/** Supervisor → user, when a decision is genuinely needed. */
export const AskUserSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        options: z.array(z.string()).optional().describe('Up to 3 concrete choices.'),
      }),
    )
    .max(2)
    .describe('At most two questions. More than that means the supervisor should decide itself.'),
});

export type AskUserInput = z.infer<typeof AskUserSchema>;

/** Task tools (supervisor only). */
export const TaskCreateSchema = z.object({
  name: z.string(),
  instruction: z.string().describe('The original request. Immutable once created.'),
  /**
   * Responsibility, in one sentence.
   *
   * `TaskSpec` has had this field all along, but no tool could set it — so a
   * created task never said what it was for, and nothing downstream could answer
   * "which session is right for this". Required in spirit: a task without a
   * scope is a task nobody can hand off.
   */
  scope: z
    .string()
    .optional()
    .describe('One sentence: what this task is responsible for. Used to match later hand-offs.'),
  deliverables: z
    .array(
      z.object({
        kind: z.enum(['file', 'directory', 'pr', 'doc', 'message']),
        path: z.string().optional().describe('Workspace- or absolute path for file/directory kinds.'),
        note: z.string().optional().describe('What it must contain.'),
        required: z.boolean().optional(),
      }),
    )
    .optional()
    .describe('What this task owes. A task with no deliverable cannot be checked.'),
  acceptance: z
    .array(
      z.object({
        check: z.string().describe('What must be true, in words.'),
        command: z.string().optional().describe('Command the host runs; exit 0 = pass.'),
      }),
    )
    .optional()
    .describe('How completion is judged. Run by the host, never by the worker itself.'),
  cwd: z.string().optional().describe('Working directory for the worker.'),
  assigneeAgentId: z
    .string()
    .optional()
    .describe('Role id that will execute this task, from the roster above. Omit for the workspace default.'),
  parentTaskId: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  priority: z.number().int().min(0).max(4).optional(),
});

export const TaskUpdateSchema = z.object({
  identifier: z.string(),
  status: z.enum(['backlog', 'running', 'paused', 'completed', 'failed', 'canceled']).optional(),
  pauseReason: z
    .enum(['failures', 'budget', 'process_lost', 'waiting', 'needs_decision'])
    .optional(),
  assigneeAgentId: z
    .string()
    .optional()
    .describe('Reassign to this role id. An id that is not a real profile silently falls back to the workspace default, so use one from the roster.'),
  error: z.string().optional(),
});

export const TaskPlanSchema = z.object({
  identifier: z.string().describe('Task id (T-1) or name.'),
  id: z
    .string()
    .optional()
    .describe('Step id such as "1" (outline) or "1.2" (sub-step). A new id adds a step.'),
  title: z.string().optional().describe('Required when adding a step; omitted means "keep the current title".'),
  status: z.enum(['todo', 'doing', 'done', 'blocked']).optional(),
  agent: z
    .string()
    .optional()
    .describe(
      'Role id that owns this step. Only set one you were actually given a roster for — a worker cannot see the roster, and a guessed id is replaced by the section owner. Omitting it is safe: the section owner assigns a real role.',
    ),
  note: z.string().optional().describe('What proves it is done, or why it is blocked.'),
  remove: z.boolean().optional().describe('Drop an unfinished step (a finished step stays as record).'),
  /**
   * Several steps in one call.
   *
   * Writing the outline one call per item costs N round trips, and at that price
   * planning first loses to starting — which is exactly why plans came out thin.
   * One call makes "write the whole outline, then work" the cheap path.
   */
  steps: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        status: z.enum(['todo', 'doing', 'done', 'blocked']).optional(),
        agent: z.string().optional(),
        note: z.string().optional(),
        remove: z.boolean().optional(),
      }),
    )
    .optional()
    .describe('Apply several steps at once, in order. Use this to write the outline in a single call.'),
});

export const TaskGetSchema = z.object({
  identifier: z.string(),
  includeJournal: z.boolean().optional(),
});

export const TaskListSchema = z.object({
  status: z
    .enum(['backlog', 'running', 'paused', 'completed', 'failed', 'canceled'])
    .optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const TaskHandoffSchema = z.object({
  identifier: z.string(),
  handoff: ReportResultSchema,
  /** Attach the session that produced this handoff (defaults to the caller). */
  fromSessionId: z.string().optional(),
});

export const TaskVerifySchema = z.object({
  identifier: z.string(),
  requirement: z.string().optional(),
  enabled: z.boolean().optional(),
});

export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>;
export type TaskHandoffInput = z.infer<typeof TaskHandoffSchema>;
