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
      return Boolean(
        rule &&
          typeof rule === 'object' &&
          typeof (rule as RouteRule).name === 'string' &&
          (rule as RouteRule).when &&
          typeof (rule as RouteRule).when.source === 'string' &&
          (rule as RouteRule).to &&
          (typeof (rule as RouteRule).to.agentId === 'string' ||
            typeof (rule as RouteRule).to.sessionId === 'string'),
      );
    });
  } catch {
    return [];
  }
}

/** The line prepended to a delivered event, so the worker knows its instruction. */
export function formatRouteInstruction(rule: RouteRule): string {
  return rule.ask?.trim() ? rule.ask.trim() : `按「${rule.name}」这条规则处理。`;
}
