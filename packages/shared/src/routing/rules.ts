/**
 * Event routing rules — the deterministic fast path.
 *
 * Borrowed from the two-stage filtering idea: a rule that can be evaluated in
 * code must never cost a model call. `match` returning `unknown` is a first
 * class outcome: it means "the rule cannot tell", and only then does the event
 * reach the supervisor.
 *
 * File: `<workspace>/routes.json`
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface RouteRule {
  name: string;
  when: {
    source: string;
    /** Event types; omitted = any type from that source. */
    types?: string[];
    /** Case-insensitive substring/regex-ish match against title + summary. */
    textMatch?: string;
  };
  to: {
    /** Preferred: route by role, so the rule survives agent renames. */
    agentId?: string;
    /** Explicit session, for a fixed pipeline. */
    sessionId?: string;
    /** Start a task instead of waking a session — the task owns execution. */
    taskId?: string;
    /**
     * Working directory for a worker this rule spawns.
     * A rule that names an agent with no live session starts one; that worker
     * must not inherit whatever directory the supervisor happens to sit in.
     */
    cwd?: string;
    /** Skills the spawned worker must follow (the SOP for this kind of event). */
    skills?: string[];
    /**
     * How many workers this rule may keep running at once. Default 1: a second
     * event of the same kind queues instead of fanning out, which is what keeps
     * "three colleagues commented" from becoming three parallel agents.
     */
    parallel?: number;
  };
  /** One-line instruction prepended to the event when it is delivered. */
  ask?: string;
}

export type RouteDecision =
  | { kind: 'match'; rule: RouteRule }
  | { kind: 'unknown' }
  | { kind: 'ignore' };

export interface RoutableEvent {
  source: string;
  type: string;
  title?: string;
  summary?: string;
}

function textMatches(needle: string, haystack: string): boolean {
  if (!needle.trim()) return true;
  // Accept a simple `a|b` alternation without pulling in a regex engine: rules
  // are user-authored and a stray `(` must never throw at dispatch time.
  return needle
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => haystack.toLowerCase().includes(part.toLowerCase()));
}

/**
 * Evaluate rules in order; the first match wins.
 *
 * `unknown` is returned when a rule's `source` matches but nothing else is
 * decidable (e.g. the rule declares types and the event has one of them, but no
 * text filter can confirm intent). That is the signal to hand over to the
 * supervisor rather than guessing.
 */
export function matchRoute(event: RoutableEvent, rules: RouteRule[]): RouteDecision {
  let sawCandidate = false;
  const haystack = `${event.title ?? ''} ${event.summary ?? ''}`;

  for (const rule of rules) {
    if (rule.when.source !== event.source) continue;

    if (rule.when.types?.length && !rule.when.types.includes(event.type)) {
      continue;
    }

    sawCandidate = true;

    if (rule.when.textMatch) {
      if (textMatches(rule.when.textMatch, haystack)) {
        return { kind: 'match', rule };
      }
      continue;
    }

    // No text filter: the source/type match is conclusive.
    return { kind: 'match', rule };
  }

  return sawCandidate ? { kind: 'unknown' } : { kind: 'ignore' };
}

export function getRoutesPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'routes.json');
}

/** Tolerant read: a broken rules file disables rules, it never blocks events. */
export function loadRoutes(workspaceRoot: string): RouteRule[] {
  const path = getRoutesPath(workspaceRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((rule): rule is RouteRule => {
      if (!rule || typeof rule !== 'object') return false;
      const candidate = rule as RouteRule;
      if (typeof candidate.name !== 'string') return false;
      if (!candidate.when || typeof candidate.when.source !== 'string') return false;
      const to = candidate.to;
      if (!to) return false;
      const hasTarget =
        typeof to.agentId === 'string' ||
        typeof to.sessionId === 'string' ||
        typeof to.taskId === 'string';
      if (!hasTarget) return false;
      if (to.cwd !== undefined && typeof to.cwd !== 'string') return false;
      if (to.skills !== undefined && !Array.isArray(to.skills)) return false;
      if (to.parallel !== undefined && typeof to.parallel !== 'number') return false;
      return true;
    });
  } catch {
    return [];
  }
}

/**
 * A rule whose `to.agentId` names a role the workspace does not have.
 */
export interface RouteRuleIssue {
  rule: string;
  agentId: string;
}

/**
 * Find rules that point at a role that does not exist.
 *
 * `loadRoutes` is tolerant about *shape* on purpose — one malformed entry must
 * not take the file down and disable every other rule. It must not be tolerant
 * about *identity*. An unknown id does not fail at spawn: `getAgentById` falls
 * back to the workspace default and the session is created anyway, so the event
 * is handled by a persona the rule never asked for and nothing anywhere says a
 * rule is broken. That is worse than not routing at all — the user believes a
 * role is on it, and finds out by reading the transcript.
 */
export function findUnknownRuleAgents(
  rules: RouteRule[],
  knownAgentIds: ReadonlySet<string>,
): RouteRuleIssue[] {
  const issues: RouteRuleIssue[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const agentId = rule.to.agentId?.trim();
    if (!agentId || knownAgentIds.has(agentId)) continue;
    // The same broken rule listed twice is one mistake, not two.
    const key = `${rule.name}\u0000${agentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ rule: rule.name, agentId });
  }
  return issues;
}

/** One line a human can act on. Says what happened, not just what is wrong. */
export function formatRouteRuleIssue(issue: RouteRuleIssue): string {
  return (
    `规则「${issue.rule}」的 to.agentId 指向不存在的角色 \`${issue.agentId}\`，` +
    '已停止按该规则路由——继续下去会静默换成默认角色，等于让错的人接活。请修正 routes.json。'
  );
}

/**
 * The text prepended to a delivered event, so the worker knows its instruction.
 *
 * cwd and skills travel with the instruction because a worker started from a
 * rule has no other way to learn them: the rule is the only place the user
 * wrote "where" and "per which SOP".
 */
export function formatRouteInstruction(rule: RouteRule): string {
  const lines = [rule.ask?.trim() ? rule.ask.trim() : `按「${rule.name}」这条规则处理。`];
  if (rule.to.cwd) lines.push(`工作目录：${rule.to.cwd}`);
  if (rule.to.skills?.length) lines.push(`必须遵循的技能：${rule.to.skills.join('、')}`);
  return lines.join('\n');
}

/** Concurrency cap for a rule; 1 when unspecified (never unbounded by accident). */
export function ruleParallelism(rule: RouteRule): number {
  const raw = rule.to.parallel;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}
