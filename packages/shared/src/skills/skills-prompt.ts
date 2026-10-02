/**
 * Skills Prompt Injection
 *
 * Renders the available-skills inventory (`<skills>` block) into the system
 * prompt so the model can auto-trigger a skill by matching the user's task
 * against each skill's `description` (L1 progressive disclosure — same pattern
 * as Claude Code / Codex / agentskills.io).
 *
 * Budget: the block is capped at a fraction of the context window (2% by
 * default, same policy as OpenAI Codex). When the raw inventory exceeds the
 * budget we first truncate descriptions, then drop low-priority skills
 * (global first, project last — reverse of the precedence order).
 *
 * The rendered block must be byte-stable within a session (skills change
 * rarely; loadAllSkills has its own 5-minute TTL cache) so the system prompt
 * stays prompt-cache friendly.
 */

import type { LoadedSkill } from './types.ts';
import { loadAllSkills } from './storage.ts';
import { ESTIMATOR_DIVISOR } from '../tool-layering/types.ts';

/** Description length kept when truncating (characters). */
const TRUNCATED_DESC_CHARS = 120;
/** Default budget: 2% of a 200k context window (same policy as Codex). */
export const DEFAULT_SKILLS_BUDGET_TOKENS = 4000;

const SOURCE_PRIORITY: Record<LoadedSkill['source'], number> = {
  project: 3,
  workspace: 2,
  global: 1,
};

/**
 * Render a `<skills>` inventory block from loaded skills.
 * Pure function — deterministic order: higher-precedence source first,
 * then creation order (folder order) as stable tiebreaker.
 *
 * @param skills - Loaded skills (already deduplicated by loader)
 * @param budgetTokens - Token budget for the whole block; 0 = no cap
 */
export function renderSkillsBlock(
  skills: LoadedSkill[],
  budgetTokens = DEFAULT_SKILLS_BUDGET_TOKENS,
): string {
  if (skills.length === 0) {
    return '';
  }

  // Stable order: project > workspace > global, then slug for determinism
  const ordered = [...skills].sort((a, b) => {
    const p = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
    return p !== 0 ? p : a.slug.localeCompare(b.slug);
  });

  const formatLines = (list: LoadedSkill[], truncate: boolean) =>
    list.map((s) => {
      // Collapse newlines inside descriptions so every skill stays on one line
      const flat = s.metadata.description.replace(/\s+/g, ' ').trim();
      const desc = truncate && flat.length > TRUNCATED_DESC_CHARS
        ? flat.slice(0, TRUNCATED_DESC_CHARS).trimEnd() + '…'
        : flat;
      return `- ${s.slug}: ${desc}`;
    });

  const estimateTokens = (lines: string[]) =>
    lines.join('\n').length / ESTIMATOR_DIVISOR;

  // Pass 1: full descriptions
  const fullLines = formatLines(ordered, false);
  if (budgetTokens <= 0 || estimateTokens(fullLines) <= budgetTokens) {
    return `<skills>\n${fullLines.join('\n')}\n</skills>`;
  }

  // Pass 2: truncate long descriptions
  const truncatedLines = formatLines(ordered, true);
  if (estimateTokens(truncatedLines) <= budgetTokens) {
    return `<skills>\n${truncatedLines.join('\n')}\n</skills>`;
  }

  // Pass 3: drop lowest-priority skills until within budget
  const kept: LoadedSkill[] = [];
  for (const skill of ordered) {
    const candidate = [...kept, skill];
    const lines = formatLines(candidate, true);
    if (estimateTokens(lines) <= budgetTokens) {
      kept.push(skill);
    } else {
      break; // further skills are lower priority — we already sorted highest first
    }
  }
  // Guarantee at least one entry so the block isn't empty
  if (kept.length === 0 && ordered.length > 0) {
    kept.push(ordered[0]!);
  }

  return `<skills>\n${formatLines(kept, true).join('\n')}\n</skills>`;
}

/**
 * Build the `<skills>` block for a session: load all skills for the
 * (workspace, project) pair, deduplicated by precedence, then render with
 * budget capping. Returns an empty string when there are no skills.
 */
export function formatSkillsBlock(
  workspaceRoot?: string,
  projectRoot?: string,
  budgetTokens = DEFAULT_SKILLS_BUDGET_TOKENS,
): string {
  if (!workspaceRoot) {
    return '';
  }
  const skills = loadAllSkills(workspaceRoot, projectRoot);
  return renderSkillsBlock(skills, budgetTokens);
}