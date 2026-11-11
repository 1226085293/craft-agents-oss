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
  /**
   * The task this report is about, when it is about one.
   *
   * Without it the card's task was guessed from "which paused task has an open decision",
   * and the guess was wrong twice in one run: a card about T-1 for a task that was not yet
   * paused carried no id at all, and a later card about T-1 was stamped T-2 because that
   * was the most recent one waiting. The asker knows which task it means; saying so is what
   * makes the card answerable on the right task.
   */
  taskId: z.string().optional().describe('The task id this report concerns, e.g. "T-1". Required for kind=decision when you are answering about a task.'),
  options: z
    .array(z.string())
    .max(4)
    .optional()
    .describe(
      'Only with outcome=needs_decision: the answers a person can choose, at most 4, e.g. ["仅放行 1.2，其余之后再定", "放行 1.2 和 2，把任务做完", "到此为止，结束任务"]. Each is rendered as a button on the decision card and sent back verbatim. Do not also enumerate them inside summary.',
    ),
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
  /**
   * Which plan step this dispatch is for.
   *
   * The plan is the record of what is left, so a dispatch that names its step can be checked
   * against it. Observed live: the supervisor dispatched 1.2 thirty-four seconds after the worker
   * had marked 1.2 done, the worker re-read the same file and filed a second hand-off, and the
   * person was told 「交接通过」 twice for one step. Without the id there was nothing to check
   * against — an instruction is prose, and prose cannot be compared with a plan.
   */
  stepId: z
    .string()
    .optional()
    .describe(
      'The plan step this work is for, e.g. "1.2". Required when the task has a plan: a step that is already done is refused, so naming it is how you find out before spending a turn.',
    ),
  parallel: z
    .boolean()
    .optional()
    .describe('Allow this to run alongside the other dispatches from the same turn (max 3 per turn).'),
});

export type DispatchInput = z.infer<typeof DispatchSchema>;

/**
 * Supervisor → user: one list, three kinds of entry.
 *
 * There used to be two tools for this — `report_to_user` (one statement, delivered immediately) and
 * `ask_user` (a list of questions, delivered at turn end) — and the code called them 「two
 * spellings of one thing」 in a comment while both stayed in the table. A supervisor picked the one
 * whose shape read like 「汇报」, called it twice in one turn for one unresolved situation, and the
 * person got two cards for one question. Two doors to the same room is how that happens.
 *
 * So there is one door, and it takes a list: this turn's words for the person, in order. `decision`
 * entries become cards with buttons and are recorded on the task, because a task cannot start while
 * a person is still deciding. `completed` and `blocked` are statements and are only statements.
 */
export const AskUserSchema = z.object({
  /**
   * Everything this turn has to say to the person, in the order it should be read.
   *
   * The list is the unit, not the call: a supervisor that calls this twice appends to the same
   * turn's list, and the whole list goes out once when the turn ends. That is what makes 「this turn
   * asked one thing」 true no matter how many times the model reached for the tool.
   */
  entries: z
    .array(
      z.object({
        /**
         * Why the person is being told. Required, and the only three answers.
         *
         * Length was the only thing this used to constrain (「at most ~100 words」), which said
         * nothing about *when* to speak — so a supervisor narrated progress into the user's
         * transcript and pushed the next real decision off the screen.
         */
        kind: z
          .enum(['completed', 'decision', 'blocked'])
          .describe(
            'completed = the task is finished. decision = you cannot proceed without a choice only a person can make. blocked = a failure needing human hands. Work in progress is NOT reportable.',
          ),
        text: z
          .string()
          .describe('At most ~100 words. Conclusions only; link the session for detail.'),
        /**
         * The answers, as answers — not as prose.
         *
         * A decision reported as 「请拍板：(a) 放行，我继续派活…(b) 到此为止」 rendered as one
         * paragraph: the reader had to retype a choice the asker had already enumerated. Options
         * become buttons and are matched byte for byte when an answer comes back.
         */
        options: z
          .array(z.string())
          .max(4)
          .optional()
          .describe(
            'Only with kind=decision: the answers a person can choose, at most 4, e.g. ["放行剩余步骤，把任务做完", "到此为止，结束任务"]. Each is rendered as a button and sent back verbatim. Do not also enumerate them inside `text`.',
          ),
      }),
    )
    .min(1)
    /**
     * No cap — and now no cap anywhere.
     *
     * The schema dropped `.max(2)` and explained why, but the handler kept its own `> 2` refusal:
     * the refusal outlived the rule, so a supervisor asking three things got a tool error and
     * learned to avoid the tool rather than to trust it. A count is not a reason to decide on
     * someone's behalf; picking what genuinely needs a person is.
     */
    .describe(
      'Everything to tell the person this turn, in order — as many entries as there are. Do not drop one because of a count, and do not decide it yourself instead: ask it, or leave it out entirely and say why.',
    ),
  taskId: z
    .string()
    .optional()
    .describe('The task these entries concern, e.g. "T-1". Give it for kind=decision when the question is about a task.'),
  sessionId: z.string().optional().describe('Session the person can open for the full process.'),
});

export const ListQuestionsSchema = z.object({
  taskId: z
    .string()
    .optional()
    .describe('Limit to one task. Omit to see every question still open in this workspace.'),
});

export type AskUserInput = z.infer<typeof AskUserSchema>;
export type ListQuestionsInput = z.infer<typeof ListQuestionsSchema>;

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
        check: z
          .string()
          .describe(
            'What must be true of the finished result, e.g. "docs/a.md 存在且内容非空". Never what this run is allowed to touch.',
          ),
        command: z.string().optional().describe('Command the host runs; exit 0 = pass.'),
      }),
    )
    .optional()
    .describe(
      'How completion is judged. Run by the host, never by the worker itself. Each item outlives a run, so write a fact about the deliverable — 「本轮未执行 1.2」 is not acceptance but a directive, and as acceptance it became permanently false the moment the next run did 1.2.',
    ),
  /**
   * The plan, as agreed with the user.
   *
   * Without this the supervisor could promise 「执行计划写两条大纲：1 写文件 2 收尾」
   * and then have no way to record it — the worker invented its own three-outline
   * plan instead (确认位置 / 创建 / 回报), and the board showed something nobody
   * asked for. A plan the user stated is part of the request, not a detail the
   * executor should re-derive.
   */
  plan: z
    .array(
      z.object({
        id: z.string().describe('Outline id ("1", "2") or sub-step id ("1.1").'),
        title: z.string(),
        agent: z.string().optional().describe('Role id that owns this step, from the roster.'),
      }),
    )
    .optional()
    .describe('Outlines and sub-steps exactly as agreed with the user. The worker may only fill in under these, not replace them.'),
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
  /**
   * Replace the task's scope, i.e. widen or move the boundary.
   *
   * The user's 「完成 1.2」 is an authorisation, but only `spec.scope` can unlock the
   * dispatch gate — and until now no tool could write it after creation. A real run
   * showed the consequence: the supervisor read the answer correctly, could not record
   * it, was refused by the gate, and asked the user the same question three times.
   */
  scope: z
    .string()
    .optional()
    .describe('New scope sentence. Use when the user authorises work beyond the current boundary.'),
  /**
   * What the person's last reply means, written by the model that read it.
   *
   * This is the only record of a reply's meaning, and nothing parses it. Writing it stamps `at`,
   * and `resumeDecisionFor` refuses to restart a task whose reply is newer than its directive — so
   * the fact being enforced is 「somebody read this and decided」, not 「the words contained 停止」.
   *
   * Say it as an instruction, in the person's own terms: 「只做登录修复，其余不动」. Step ids are
   * allowed but are not what makes it work: the sub-steps a boundary would name are invented later,
   * while the work is being done.
   */
  directive: z
    .string()
    .optional()
    .describe('One sentence saying what the reply authorises, e.g. "只做登录修复，其余不动". Required before a task whose question was answered can run again.'),
  /**
   * Replace the acceptance list.
   *
   * Acceptance items are about the RESULT (a file exists, a test passes), so they outlive a run.
   * They used to be writable only at creation, which made a mis-worded one permanent: a real task
   * carried 「本轮未执行 1.2」, the user then released 1.2, and from that moment every hand-off
   * contradicted the item — three rejections, the failure fuse, and a task that could never close.
   * The supervisor's only way out was to abandon the task and start another.
   *
   * A check that says what THIS run may do is a directive, not acceptance: write it with
   * `directive`, which the next run reads as its authorisation.
   */
  acceptance: z
    .array(
      z.object({
        id: z.string().optional().describe('Keep the existing id to edit that item; omit to add.'),
        check: z.string().describe('One sentence about the finished result, e.g. "docs/a.md 存在且内容非空".'),
        command: z.string().optional().describe('A command that exits 0 when the check holds.'),
      }),
    )
    .optional()
    .describe('Replace the acceptance list. Write what must be true of the RESULT, never what this run is allowed to touch — that belongs in directive.'),
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
  /**
   * Rewrite the not-yet-started tail of the outline list.
   *
   * A plan written up front is a guess about work that has not happened. When the first sections
   * show the guess was wrong, the only repair was one step at a time, so nobody repaired it and
   * the plan kept being executed as written. This is the bulk form, limited to sections that
   * have not started: a section with sub-steps is already begun, and done/doing is history.
   */
  restructure: z
    .object({
      fromId: z.string().describe('First outline to replace, e.g. "2". It and everything after it must be untouched.'),
      outlines: z
        .array(
          z.object({
            id: z.string().optional().describe('Outline id; defaults to consecutive numbers from fromId.'),
            title: z.string(),
          }),
        )
        .describe('The replacement outlines, in order. Titles only — sub-steps are expanded one section at a time.'),
    })
    .optional()
    .describe(
      'Rewrite the outlines that have not started yet (no sub-steps, not doing, not done). Use when a section turned out to be wrong and the rest of the plan has to follow.',
    ),
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

export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>;
export type TaskHandoffInput = z.infer<typeof TaskHandoffSchema>;
