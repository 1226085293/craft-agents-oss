/**
 * Who should own a section of a task?
 *
 * The plan names an owner per step, and until now that name came from whoever
 * wrote the step — the worker running it. A worker cannot see the roster, so the
 * name was a guess: it either repeated itself or invented an id that matched
 * nothing, and the auto-dispatch that trusts the field would then hand work to a
 * role nobody meant.
 *
 * Assignment is a routing decision, so it is made the way routing is made: a
 * short read-only completion against the roster, in a hidden session of its own.
 * Not in the supervisor's conversation — that one belongs to the user, and
 * queueing a planning question there makes the human wait behind bookkeeping. Not
 * in the worker either, which has neither the roster nor the standing to divide
 * work.
 *
 * Kept as a pure prompt-builder plus a parser so it can be tested without a model:
 * the model call itself is injected.
 */

import { formatAgentRosterBlock, readAgentRoster } from '@craft-agent/shared/agents';
import type { AgentPromptEntry } from '@craft-agent/shared/agents';
import type { PlanStep, Task } from '@craft-agent/shared/tasks';

/** The roster, as the chooser sees it. */
export function buildSectionOwnerPrompt(params: {
  task: Pick<Task, 'name' | 'instruction'> & { spec?: { scope?: string } };
  outline: Pick<PlanStep, 'id' | 'title'>;
  steps: Array<Pick<PlanStep, 'id' | 'title'>>;
  roster: AgentPromptEntry[];
}): string {
  const rosterBlock = formatAgentRosterBlock(params.roster);
  const stepLines = params.steps.map((step) => `- ${step.id} ${step.title}`).join('\n');

  return [
    '你要为一条任务里的**一个章节**指定负责人。只输出负责人 id，不要解释。',
    '',
    `任务：${params.task.name}`,
    `任务说明：${params.task.instruction}`,
    ...(params.task.spec?.scope ? [`分工范围：${params.task.spec.scope}`] : []),
    '',
    `章节：${params.outline.id} ${params.outline.title}`,
    '这一节包含：',
    stepLines,
    rosterBlock,
    '',
    '规则：',
    '- 只从上面列出的 id 里选一个，原样输出，不要加引号或其它文字。',
    '- 按这一节实际要做的事选：要改界面的、要查资料的、要写测试的，不该是同一个人。',
    '- 拿不准就输出 `default`。',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Read the answer, refusing anything that is not a real profile.
 *
 * An unknown id is worse than no id: it would be dispatched as an agent that does
 * not exist, and the failure would surface later as a session with the wrong
 * persona rather than as "the chooser got it wrong".
 */
export function parseSectionOwner(answer: string, roster: AgentPromptEntry[]): string | undefined {
  const text = answer.trim();
  if (!text) return undefined;
  const ids = new Set(roster.map((entry) => entry.id));
  // Models wrap ids in punctuation, backticks or a sentence; look for a known id
  // rather than requiring the whole reply to be one.
  for (const entry of roster) {
    if (!ids.has(entry.id)) continue;
    const pattern = new RegExp(`(^|[^\\w-])${entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`);
    if (pattern.test(text)) return entry.id;
  }
  return undefined;
}

/**
 * Whether a step should take the chooser's answer.
 *
 * A step already naming a **real** profile keeps it: that decision was deliberate,
 * and the chooser has no business overruling somebody who knew what they meant.
 *
 * A step naming anything else does take the answer. The planner is usually a worker
 * that cannot see the roster (`task_plan` says so), which makes the name a guess —
 * and an unresolvable id does not fail loudly: `resolveAgentProfile` falls back to
 * the workspace default, so the section quietly runs as some other role. The
 * chooser is the only participant holding the roster, so it overrules the guess.
 */
export function shouldReassignOwner(
  step: Pick<PlanStep, 'agent'>,
  roster: AgentPromptEntry[],
): boolean {
  if (!step.agent) return true;
  return !roster.some((entry) => entry.id === step.agent);
}

/** Convenience for callers that have a workspace root on hand. */
export function readRoster(workspaceRootPath: string | undefined): AgentPromptEntry[] {
  return readAgentRoster(workspaceRootPath);
}
