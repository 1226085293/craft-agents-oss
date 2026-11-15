/**
 * Every tool a prompt names must exist in the table of the session that reads it.
 *
 * A prompt is the only place a model learns what it can do — and a name it cannot call costs a
 * whole turn: the model writes the call, the proxy answers `Unknown proxy tool: <name>`, and the
 * work stops where the sentence was. Two of these were live:
 *
 *   - `formatPauseBrief` told the *supervisor* to explain a pause with `report_to_user`, a tool
 *     that no longer exists (merged into `ask_user`). The brief is delivered by `wakeSession`
 *     with `reason === 'pause'`, so every paused task handed its supervisor an impossible
 *     instruction.
 *   - `TASK_LANE_DISPATCH_SECTION` named `task_create` in a sentence denying it. Denying a tool
 *     the model has never heard of does not prevent a call — it plants the name. Measured in
 *     261114-wild-fern: the sentence went into that session's long-term memory verbatim and came
 *     back on every later turn.
 *
 * The old supervisor test only checked one lane's prompt. `brief.ts` — the worker's whole
 * instruction set — was checked by nothing, which is why `report_to_user` survived there.
 */
import { describe, expect, it } from 'bun:test';

import { getSupervisorSystemPrompt } from '../supervisor-prompt.ts';
import { SESSION_TOOL_NAMES } from '../../../../session-tools-core/src/tool-defs.ts';
import {
  formatDispatchTaskContext,
  formatExecutionRuleBlock,
  formatPauseBrief,
  formatPlanRuleBlock,
  formatTaskBrief,
  formatUnreportedBrief,
} from '../../tasks/brief.ts';
import type { Task } from '../../tasks/types.ts';

/**
 * Names that look like tools but are not entries in `SESSION_TOOL_DEFS`.
 *
 * The layering constructs are dispatched by `pi-agent.ts` before the registry is consulted —
 * `tools_<category>` unfolds a category and `call_tool` invokes a folded tool — so they are
 * callable without appearing in the table. `call_llm` and `browser_tool` are backend tools
 * (`executionMode: 'backend'`), reachable the same way.
 */
const NOT_IN_TABLE_BUT_CALLABLE = new Set([
  'tools_workspace',
  'tools_agent',
  'tools_sources',
  'tools_compute',
  'tools_pages',
  'tools_validation',
  'tools_chrome-devtools',
  'tools_codegraph',
  'call_tool',
]);

const BACKTICKED = /`([a-z][a-z0-9_]{2,})`/g;

/**
 * Pull the names a prompt uses, and only the prompt.
 *
 * Each file interleaves code comments with the strings that reach a model, and the two need
 * different judgement: a comment may cite a deleted tool to explain why it went (that is the
 * record of a decision), while a string is read by the model as an instruction. So the sources
 * here are the *rendered* prompts, not the files.
 */
function namesIn(text: string): string[] {
  return [...new Set([...text.matchAll(BACKTICKED)].map((m) => m[1]!))].filter(
    (name) => name.includes('_') && !NOT_IN_TABLE_BUT_CALLABLE.has(name),
  );
}

const NOW = 1_800_000_000_000;

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'T-1',
  name: '状态图标验证',
  instruction: '创建 docs/a.md',
  status: 'running',
  pauseReason: null,
  supervisorSessionId: 'sup',
  sessionIds: ['s1'],
  currentWorkerSessionId: 's1',
  dependsOn: [],
  priority: 1,
  budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 120, deadline: null },
  handoffs: [],
  verify: { enabled: false, maxIterations: 2 },
  lifecycle: { errorCount: 0, consecutiveFailures: 0 },
  origin: { supervisorSessionId: 'sup', toolCallId: 'c1' },
  heartbeatIntervalMin: 10,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('every tool a prompt names exists in the table that reads it', () => {
  it('names only real tools in the task lane prompt', () => {
    const text = getSupervisorSystemPrompt({ workspacePath: '/tmp/ws', lane: 'task' } as never);
    const missing = namesIn(text).filter((name) => !SESSION_TOOL_NAMES.has(name));
    expect(missing).toEqual([]);
  });

  it('names only real tools in the user lane prompt', () => {
    const text = getSupervisorSystemPrompt({ workspacePath: '/tmp/ws', lane: 'user' } as never);
    const missing = namesIn(text).filter((name) => !SESSION_TOOL_NAMES.has(name));
    expect(missing).toEqual([]);
  });

  /**
   * The pause brief goes to a *supervisor*, and `ask_user` is the only tool that reaches a
   * person — so `report_to_user` here was both unknown and a dead end.
   */
  it('names only real tools in the pause brief handed to a supervisor', () => {
    const text = formatPauseBrief(task({ status: 'paused', pauseReason: 'needs_decision' }));
    const missing = namesIn(text).filter((name) => !SESSION_TOOL_NAMES.has(name));
    expect(missing).toEqual([]);
    expect(text).toContain('ask_user');
  });

  it('names only real tools in the worker brief', () => {
    const texts = [
      formatTaskBrief(task()),
      formatExecutionRuleBlock(),
      formatPlanRuleBlock(),
      formatPlanRuleBlock({ planExists: true }),
      formatUnreportedBrief(task()),
      formatDispatchTaskContext(task()),
    ];
    for (const text of texts) {
      const missing = namesIn(text).filter((name) => !SESSION_TOOL_NAMES.has(name));
      expect(missing).toEqual([]);
    }
  });

  /**
   * And the reverse direction, for the tool that started this: a worker cannot reach `ask_user`
   * either, so a brief must never spend its instructions on one.
   *
   * `report_result` is the worker's only exit — `task_plan` marks a step done, `report_result`
   * ends the turn with an outcome. A brief that says 「tell the person」 in the worker lane is
   * asking for a tool the lane does not have.
   */
  it('does not send a worker to a supervisor-only exit', () => {
    const SUPERVISOR_ONLY = ['ask_user', 'list_questions', 'dispatch', 'task_handoff', 'task_update'];
    const workerTexts = [
      formatTaskBrief(task()),
      formatExecutionRuleBlock(),
      formatPlanRuleBlock({ planExists: true }),
      formatUnreportedBrief(task()),
    ].join('\n');
    for (const name of SUPERVISOR_ONLY) {
      expect({ name, named: workerTexts.includes(`\`${name}\``) }).toEqual({ name, named: false });
    }
  });
});
