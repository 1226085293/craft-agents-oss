/**
 * Usage Store — Persistent record of source & skill usage.
 *
 * Writes one JSONL line per tool invocation that targets a source or a skill,
 * keyed by slug. Aggregation (use count + last-used timestamp) is computed by
 * a full scan on read — the append-only design mirrors `api-errors.jsonl` /
 * `execution_journal.jsonl`, so concurrent appends from multiple sessions are
 * safe and a torn write can never corrupt prior records.
 *
 * Data lives at `~/.craft-agent/usage/usage.jsonl` (respects `CRAFT_CONFIG_DIR`).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from '../config/paths.ts';

// ============================================================================
// Types
// ============================================================================

export type UsageKind = 'source' | 'skill';

/** One persisted usage event. */
export interface UsageRecord {
  /** Unique record ID (UUID) */
  id: string;
  /** What was used */
  kind: UsageKind;
  /** Source or skill slug */
  slug: string;
  /** The (proxy) tool name that produced this usage, for traceability */
  toolName: string;
  /** Workspace the usage happened in (empty when unknown) */
  workspaceId?: string;
  /** Session that performed the usage (empty when unknown) */
  sessionId?: string;
  /** Epoch milliseconds */
  timestamp: number;
}

/** Input for {@link appendUsage}. */
export type UsageRecordInput = Omit<UsageRecord, 'id' | 'timestamp'>;

/** Resolved usage target for a single tool invocation. */
export interface UsageTarget {
  kind: UsageKind;
  slug: string;
}

export interface SkillReadUsageContext {
  workspaceRootPath: string;
  workingDirectory?: string;
  /** Optional override for deterministic tests; defaults to ~/.agents/skills. */
  globalSkillsPath?: string;
}

/** Aggregated per-slug stats. */
export interface UsageStats {
  sources: Record<string, { useCount: number; lastUsedAt: number }>;
  skills: Record<string, { useCount: number; lastUsedAt: number }>;
}

// ============================================================================
// Tool-name resolution
// ============================================================================

/** Internal MCP server slugs whose tools must NOT be counted as source usage. */
const INTERNAL_SERVER_SLUGS = new Set(['session']);

/**
 * Resolve a tool invocation to a source/skill slug, or `null` when it is not
 * attributable to a tracked entity (native tools, internal session tools, …).
 *
 * Naming conventions (kept in sync with `SessionManager.resolveToolDisplayMeta`):
 *   - MCP source:   `mcp__{slug}__{tool}`          (slug sanitized by proxyToolName)
 *   - API source:   `mcp__api-bridge__api_{slug}__{tool}` → slug = `{slug}`
 *   - Skill:        `Skill` with `input.skill` = `"slug"` or `"workspaceId:slug"`
 */
export function resolveUsageTarget(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): UsageTarget | null {
  // Skill tool
  if (toolName === 'Skill' && toolInput) {
    const skillParam = toolInput.skill as string | undefined;
    if (skillParam) {
      const skillSlug = skillParam.includes(':') ? skillParam.split(':').pop() : skillParam;
      if (skillSlug) return { kind: 'skill', slug: skillSlug };
    }
    return null;
  }

  // Layered dispatch (tool-layering): the model calls mcp__session__call_tool
  // with { name: <real proxy tool>, args }. Count the REAL target so source
  // usage still tracks folded MCP/API tool calls.
  if (toolName === 'mcp__session__call_tool' && toolInput) {
    const args = (toolInput.args ?? {}) as Record<string, unknown>;
    const raw = typeof toolInput.name === 'string'
      ? toolInput.name
      : typeof args.name === 'string'
        ? args.name
        : undefined;
    if (raw && (raw.startsWith('mcp__') || raw.startsWith('api_'))) {
      return resolveUsageTarget(raw, args);
    }
    return null;
  }

  // MCP tools: mcp__<serverSlug>__<toolSlug...>
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    if (parts.length >= 3) {
      const serverSlug = parts[1] ?? '';
      const toolSlug = parts.slice(2).join('__');

      // Internal MCP servers (session) are not tracked entities.
      if (INTERNAL_SERVER_SLUGS.has(serverSlug)) return null;

      // API bridge embeds the source slug in the tool name as "api_{slug}".
      if (serverSlug === 'api-bridge' && toolSlug.startsWith('api_')) {
        const sourceSlug = toolSlug.slice(4);
        if (sourceSlug) return { kind: 'source', slug: sourceSlug };
      }

      if (serverSlug) return { kind: 'source', slug: serverSlug };
    }
    return null;
  }

  return null;
}

const PROJECT_AGENT_SKILLS_DIR = '.agents/skills';

/** Native shell tool names that carry a `command` input. */
const SHELL_TOOL_NAMES = new Set(['Bash', 'Terminal', 'Shell']);

/**
 * Read verbs whose file arguments count as skill usage when the argument
 * resolves under one of the supported skill roots. Deliberately small:
 * search/copy/delete verbs (ls, grep, find, rm, cp, …) never count.
 */
const SKILL_READ_VERBS = new Set([
  'cat', 'type', 'more', 'less', 'head', 'tail', 'diff',
  'get-content', 'open-file',
]);
const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+)/;

function normalizeUsagePath(path: string): string {
  const expanded = path === '~' || path.startsWith('~/') || path.startsWith('~\\')
    ? `${homedir()}${path.slice(1)}`
    : path;
  return expanded.replace(/\\/g, '/');
}

function getPathApi(...paths: string[]) {
  return paths.some(path => WINDOWS_ABSOLUTE_PATH.test(path.replace(/\\/g, '/'))) ? win32 : posix;
}

function joinUsagePath(base: string, relative: string): string {
  const normalizedBase = normalizeUsagePath(base);
  const pathApi = getPathApi(normalizedBase);
  return pathApi.join(normalizedBase, relative);
}

/**
 * Resolve a successful native Read path to a skill slug when it is below one
 * of the supported skill roots. Both Windows and POSIX separators are accepted
 * regardless of the host OS; containment is checked on path segments, not a
 * textual prefix.
 */
function buildSkillRoots(context: SkillReadUsageContext): string[] {
  const roots = [
    context.globalSkillsPath ?? join(homedir(), '.agents', 'skills'),
    joinUsagePath(context.workspaceRootPath, 'skills'),
    ...(context.workingDirectory ? [joinUsagePath(context.workingDirectory, PROJECT_AGENT_SKILLS_DIR)] : []),
  ];
  return roots.map(normalizeUsagePath);
}

/**
 * Check whether `fileLike` resolves under one of the skill roots and return
 * the best (most specific root) match, or `null`. Both Windows and POSIX
 * separators are accepted regardless of the host OS; containment is checked
 * on path segments, not a textual prefix.
 */
function matchSkillSlugForPath(
  fileLike: string,
  workingDirectory: string,
  roots: string[],
): { slug: string; rootLength: number } | null {
  const normalizedReadPath = normalizeUsagePath(fileLike);
  const normalizedWorkingDirectory = normalizeUsagePath(workingDirectory);

  const matches: Array<{ slug: string; rootLength: number }> = [];
  for (const root of roots) {
    const pathApi = getPathApi(normalizedReadPath, normalizedWorkingDirectory, root);
    const absoluteReadPath = pathApi.resolve(normalizedWorkingDirectory, normalizedReadPath);
    const absoluteRoot = pathApi.resolve(root);
    const relativePath = pathApi.relative(absoluteRoot, absoluteReadPath).replace(/\\/g, '/');
    const segments = relativePath.split('/').filter(Boolean);
    const normalizedRelativePath = process.platform === 'win32' || WINDOWS_ABSOLUTE_PATH.test(root)
      ? relativePath.toLowerCase()
      : relativePath;

    if (pathApi.isAbsolute(relativePath) || normalizedRelativePath === '..' || normalizedRelativePath.startsWith('../')) {
      continue;
    }
    // A skill file must be inside a skill directory, not the skills root or
    // the slug directory itself.
    if (segments.length < 2) continue;

    matches.push({ slug: segments[0]!, rootLength: absoluteRoot.length });
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.rootLength - a.rootLength);
  return matches[0]!;
}

export function resolveSkillReadUsageTarget(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  isError: boolean,
  context: SkillReadUsageContext,
): UsageTarget | null {
  if (toolName !== 'Read' || isError || !toolInput) return null;

  const readPath = toolInput.file_path ?? toolInput.path;
  if (typeof readPath !== 'string' || !readPath.trim()) return null;

  const workingDirectory = context.workingDirectory ?? context.workspaceRootPath;
  const hit = matchSkillSlugForPath(readPath.trim(), workingDirectory, buildSkillRoots(context));
  return hit ? { kind: 'skill', slug: hit.slug } : null;
}

function commandHasReadVerb(segment: string): boolean {
  // Strip quoted literals so a verb inside a string literal never counts;
  // the verb must be an actual command word of this segment.
  const stripped = segment.replace(/"([^"]*)"|'([^']*)'/g, ' ');
  return stripped.split(/\s+/).some(token => SKILL_READ_VERBS.has(token.toLowerCase()));
}

function looksLikeFilePath(token: string): boolean {
  const cleaned = token.replace(/^["']+|["']+$/g, '');
  if (!cleaned || cleaned.length < 2 || cleaned.startsWith('-')) return false;
  return cleaned.includes('/') || cleaned.includes('\\')
    || cleaned.startsWith('~') || /^[a-zA-Z]:/.test(cleaned);
}

/**
 * Extract file-path candidates from one shell command segment: quoted
 * literals and bare tokens that look like paths. Quoted literals are
 * returned without their quotes so they can be resolved directly.
 */
function extractPathTokens(segment: string): string[] {
  const tokens: string[] = [];
  const quoted = /"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(segment)) !== null) {
    const literal = (match[1] ?? match[2] ?? '').trim();
    if (looksLikeFilePath(literal)) tokens.push(literal);
  }
  for (const raw of segment.split(/\s+/)) {
    const token = raw.trim();
    if (token && looksLikeFilePath(token)) {
      tokens.push(token.replace(/^["']+|["']+$/g, ''));
    }
  }
  return tokens;
}

/**
 * Resolve a successful shell invocation to a skill slug when the command
 * READS a skill file via a read verb (cat, type, Get-Content, ...).
 *
 * The verb and the path must sit in the same command segment (the command
 * is split on `&&`/`||`/`;`/`|`/newlines), so `grep`-ing or `ls`-ing a
 * skill file never counts, and a verb in one segment never attributes a
 * path that belongs to another segment. Failed invocations are rejected
 * up front (`isError`), mirroring the Read resolver: a `cat` of a missing
 * skill file is a shell error, not a usage.
 */
export function resolveSkillCommandUsageTarget(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  isError: boolean,
  context: SkillReadUsageContext,
): UsageTarget | null {
  if (!SHELL_TOOL_NAMES.has(toolName) || isError || !toolInput) return null;
  const command = (toolInput.command ?? toolInput.cmd) as string | undefined;
  if (typeof command !== 'string' || !command.trim()) return null;

  const workingDirectory = context.workingDirectory ?? context.workspaceRootPath;
  const roots = buildSkillRoots(context);

  const matches: Array<{ slug: string; rootLength: number }> = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    if (!commandHasReadVerb(segment)) continue;
    for (const token of extractPathTokens(segment)) {
      const hit = matchSkillSlugForPath(token, workingDirectory, roots);
      if (hit) matches.push(hit);
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.rootLength - a.rootLength);
  return { kind: 'skill', slug: matches[0]!.slug };
}

// ============================================================================
// Storage
// ============================================================================

function getUsageDir(): string {
  return join(CONFIG_DIR, 'usage');
}

function getUsageFilePath(): string {
  return join(getUsageDir(), 'usage.jsonl');
}

/**
 * Append one usage record. Best-effort by design — usage tracking must never
 * break the tool invocation that produced it.
 */
export function appendUsage(record: UsageRecordInput): void {
  try {
    const entry: UsageRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      ...record,
    };
    const dir = getUsageDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(getUsageFilePath(), `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (error) {
    console.warn('[UsageStore] Failed to append usage record:', error);
  }
}

/**
 * Read all usage records, oldest first. Returns an empty array when the file
 * does not exist or contains only malformed lines (each bad line is skipped).
 */
export function readUsageRecords(opts?: { workspaceId?: string }): UsageRecord[] {
  const file = getUsageFilePath();
  if (!existsSync(file)) return [];
  const workspaceId = opts?.workspaceId;

  try {
    const raw = readFileSync(file, 'utf-8');
    const out: UsageRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as UsageRecord;
        if (workspaceId && record.workspaceId && record.workspaceId !== workspaceId) continue;
        out.push(record);
      } catch {
        // Skip a torn line rather than losing the whole trail.
      }
    }
    return out;
  } catch (error) {
    console.warn('[UsageStore] Failed to read usage records:', error);
    return [];
  }
}

/**
 * Aggregate usage records into per-slug counts + last-used timestamps.
 */
export function getUsageStats(opts?: { workspaceId?: string }): UsageStats {
  const stats: UsageStats = { sources: {}, skills: {} };

  for (const record of readUsageRecords(opts)) {
    const bucket = record.kind === 'source' ? stats.sources : stats.skills;
    const existing = bucket[record.slug];
    if (existing) {
      existing.useCount += 1;
      if (record.timestamp > existing.lastUsedAt) existing.lastUsedAt = record.timestamp;
    } else {
      bucket[record.slug] = { useCount: 1, lastUsedAt: record.timestamp };
    }
  }

  return stats;
}
