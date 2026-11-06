/**
 * Validation for the structured contract.
 *
 * The supervisor's tool payload is `Record<string, unknown>` on purpose: the
 * model writes JSON, and a malformed field must degrade to "not specified"
 * rather than corrupting the task file. Everything that survives here is
 * already the shape the rest of the system assumes.
 */

import type {
  TaskAcceptanceItem,
  TaskDeliverable,
  TaskSpec,
  TaskTrigger,
} from './types.ts';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return items.length ? items : undefined;
}

function normalizeDeliverable(raw: unknown): TaskDeliverable | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const kind = v.kind;
  if (kind !== 'file' && kind !== 'directory' && kind !== 'pr' && kind !== 'doc' && kind !== 'message') {
    return null;
  }
  return {
    kind,
    ...(asString(v.path) ? { path: asString(v.path)! } : {}),
    ...(asString(v.note) ? { note: asString(v.note)! } : {}),
    ...(typeof v.required === 'boolean' ? { required: v.required } : {}),
  };
}

function normalizeAcceptance(raw: unknown, index: number): TaskAcceptanceItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const check = asString(v.check);
  if (!check) return null;
  return {
    id: asString(v.id) ?? `a${index + 1}`,
    check,
    ...(asString(v.command) ? { command: asString(v.command)! } : {}),
  };
}

/** Coerce an untrusted spec; returns undefined when nothing usable survived. */
export function normalizeSpec(raw: unknown): TaskSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;

  const deliverables = Array.isArray(v.deliverables)
    ? v.deliverables.map(normalizeDeliverable).filter((d): d is TaskDeliverable => d !== null)
    : [];
  const acceptance = Array.isArray(v.acceptance)
    ? v.acceptance
        .map((item, index) => normalizeAcceptance(item, index))
        .filter((a): a is TaskAcceptanceItem => a !== null)
    : [];

  const permissionsRaw = v.permissions;
  const permissions =
    permissionsRaw && typeof permissionsRaw === 'object'
      ? {
          ...(asStringArray((permissionsRaw as Record<string, unknown>).writePaths)
            ? { writePaths: asStringArray((permissionsRaw as Record<string, unknown>).writePaths)! }
            : {}),
          ...(typeof (permissionsRaw as Record<string, unknown>).allowExternal === 'boolean'
            ? { allowExternal: (permissionsRaw as Record<string, unknown>).allowExternal as boolean }
            : {}),
        }
      : undefined;

  const spec: TaskSpec = {
    ...(asString(v.cwd) ? { cwd: asString(v.cwd)! } : {}),
    ...(asStringArray(v.sources) ? { sources: asStringArray(v.sources)! } : {}),
    ...(asStringArray(v.skills) ? { skills: asStringArray(v.skills)! } : {}),
    ...(asString(v.model) ? { model: asString(v.model)! } : {}),
    ...(asString(v.strategy) ? { strategy: asString(v.strategy)! } : {}),
    ...(deliverables.length ? { deliverables } : {}),
    ...(acceptance.length ? { acceptance } : {}),
    ...(permissions && Object.keys(permissions).length ? { permissions } : {}),
  };

  return Object.keys(spec).length ? spec : undefined;
}

/** Coerce an untrusted trigger; unknown kinds fall back to manual. */
export function normalizeTrigger(raw: unknown): TaskTrigger {
  if (!raw || typeof raw !== 'object') return { kind: 'manual' };
  const v = raw as Record<string, unknown>;

  if (v.kind === 'cron') {
    const expr = asString(v.expr);
    if (!expr) return { kind: 'manual' };
    return {
      kind: 'cron',
      expr,
      ...(asString(v.timezone) ? { timezone: asString(v.timezone)! } : {}),
      enabled: v.enabled !== false,
      ...(asString(v.sourceId) ? { sourceId: asString(v.sourceId)! } : {}),
    };
  }

  if (v.kind === 'event') {
    const source = asString(v.source);
    if (!source) return { kind: 'manual' };
    return {
      kind: 'event',
      source,
      ...(asStringArray(v.types) ? { types: asStringArray(v.types)! } : {}),
      ...(asString(v.textMatch) ? { textMatch: asString(v.textMatch)! } : {}),
      enabled: v.enabled !== false,
      ...(asString(v.sourceId) ? { sourceId: asString(v.sourceId)! } : {}),
    };
  }

  return { kind: 'manual' };
}
