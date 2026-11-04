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
      z.object({ kind: z.literal('new'), agentId: z.string().optional() }),
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
  assigneeAgentId: z.string().optional(),
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
  assigneeAgentId: z.string().optional(),
  error: z.string().optional(),
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
