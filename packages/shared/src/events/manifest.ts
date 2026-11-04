/**
 * Listener manifest — the npm-ish contract a listener package declares.
 *
 * A listener lives at `<workspace>/events/<listenerId>/manifest.json`. Craft
 * reads it to decide whether the listener can start (runtime present, packages
 * installed), what to spawn, which config the user fills in, and what to show
 * as setup instructions.
 */

export const LISTENER_SPEC = 'craft-listener/1' as const;

export interface ListenerRestartPolicy {
  /** Only `on-failure` is honoured today. */
  policy?: 'on-failure' | 'always' | 'never';
  maxAttempts?: number;
  backoffMs?: number[];
}

export interface ListenerRuntime {
  /**
   * argv array. `shell:false` is mandatory at spawn time, so this must never
   * be a single command string.
   */
  program: string[];
  /** Defaults to the listener directory. Supports `${dir}`. */
  cwd?: string;
  /** How long the listener gets to answer /health before it is marked degraded. */
  readyTimeoutMs?: number;
  restart?: ListenerRestartPolicy;
}

export interface ListenerPackageDep {
  manager: 'pip' | 'npm';
  name: string;
  range: string;
}

export interface ListenerDependencies {
  /** Runtime versions, e.g. `{ python: ">=3.9 <4" }`. */
  runtime?: Record<string, string>;
  packages?: ListenerPackageDep[];
  /** Human-only notes for things Craft cannot install. */
  system?: string[];
}

export interface ListenerConfigProperty {
  type?: 'string' | 'number' | 'boolean';
  title?: string;
  description?: string;
  default?: string | number | boolean;
  /** Render as a password field and keep the value out of logs. */
  secret?: boolean;
  enum?: Array<string | number>;
}

export interface ListenerConfigSchema {
  type?: 'object';
  properties: Record<string, ListenerConfigProperty>;
  required?: string[];
}

export interface ListenerManifest {
  spec: typeof LISTENER_SPEC;
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  author?: string;
  homepage?: string;
  runtime?: ListenerRuntime;
  dependencies?: ListenerDependencies;
  config?: ListenerConfigSchema;
  permissions?: { network?: string[]; filesystem?: string[] };
  setup?: Array<{ text: string; link?: string }>;
}

export interface ManifestParseResult {
  ok: boolean;
  manifest?: ListenerManifest;
  errors: string[];
  warnings: string[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

export function parseVersion(version: string): [number, number, number] | null {
  const match = SEMVER.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Range comparators accept partial versions, like npm: `<4` means `<4.0.0`.
 * The manifest's own `version` field stays strict (three segments).
 */
function parseLooseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** One comparator such as `>=3.9`, `^1.2.3`, `2.*`, `1.2.3`. */
function matchesComparator(version: string, comparator: string): boolean {
  const raw = comparator.trim();
  if (!raw || raw === '*' || raw === 'x' || raw === 'X') return true;

  const current = parseLooseVersion(version);
  if (!current) return false;

  // Wildcards: `2.*` / `2.x` / `2` — major only.
  const wildcard = /^(\d+)(?:\.(\d+))?\.[*xX]$/.exec(raw);
  if (wildcard) {
    if (current[0] !== Number(wildcard[1])) return false;
    if (wildcard[2] !== undefined && current[1] !== Number(wildcard[2])) return false;
    return true;
  }

  const operator = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(raw);
  if (!operator) return false;
  const op = operator[1] ?? '=';
  const target = parseLooseVersion(operator[2]!);
  if (!target) return false;

  switch (op) {
    case '=':
      return compare(current, target) === 0;
    case '>':
      return compare(current, target) > 0;
    case '>=':
      return compare(current, target) >= 0;
    case '<':
      return compare(current, target) < 0;
    case '<=':
      return compare(current, target) <= 0;
    case '^': {
      // >=1.2.3 <2.0.0 (for 0.x, `^0.2.3` is >=0.2.3 <0.3.0)
      if (compare(current, target) < 0) return false;
      const upper: [number, number, number] =
        target[0] > 0 ? [target[0] + 1, 0, 0] : [0, target[1] + 1, 0];
      return compare(current, upper) < 0;
    }
    case '~': {
      // >=1.2.3 <1.3.0
      if (compare(current, target) < 0) return false;
      return compare(current, [target[0], target[1] + 1, 0]) < 0;
    }
    default:
      return false;
  }
}

/**
 * npm-style subset: space-separated comparators are AND, `||` is OR.
 * Deliberately small — the whole grammar is covered by the tests.
 */
export function satisfiesRange(version: string, range: string): boolean {
  if (!range?.trim()) return true;
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return true;
    return comparators.every((comparator) => matchesComparator(version, comparator));
  });
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Validate an unknown JSON value into a manifest. */
export function parseManifest(raw: unknown, expectedId?: string): ManifestParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'], warnings };
  }
  const input = raw as Record<string, unknown>;
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

  if (input.spec !== LISTENER_SPEC) {
    errors.push(`spec must be "${LISTENER_SPEC}"`);
  }

  const id = str(input.id);
  if (!id) errors.push('id is required');
  else if (!ID_PATTERN.test(id)) errors.push('id must be lowercase [a-z0-9._-], at most 64 chars');
  else if (expectedId && id !== expectedId) {
    errors.push(`id "${id}" does not match directory name "${expectedId}"`);
  }

  const name = str(input.name);
  if (!name) errors.push('name is required');

  const version = str(input.version);
  if (!version) errors.push('version is required');
  else if (!parseVersion(version)) errors.push('version must be semver (e.g. 1.2.0)');

  let runtime: ListenerRuntime | undefined;
  if (input.runtime !== undefined) {
    if (typeof input.runtime !== 'object' || input.runtime === null) {
      errors.push('runtime must be an object');
    } else {
      const rt = input.runtime as Record<string, unknown>;
      const program = rt.program;
      if (!Array.isArray(program) || program.length === 0 || program.some((p) => typeof p !== 'string')) {
        errors.push('runtime.program must be a non-empty array of strings (argv form)');
      } else if (program.length === 1 && /\s/.test(program[0] as string)) {
        errors.push('runtime.program must not be a single command string — use an argv array');
      } else {
        const restartRaw = rt.restart as Record<string, unknown> | undefined;
        runtime = {
          program: program as string[],
          ...(str(rt.cwd) ? { cwd: str(rt.cwd)! } : {}),
          ...(typeof rt.readyTimeoutMs === 'number' ? { readyTimeoutMs: rt.readyTimeoutMs } : {}),
          ...(restartRaw
            ? {
                restart: {
                  ...(restartRaw.policy === 'always' || restartRaw.policy === 'never' || restartRaw.policy === 'on-failure'
                    ? { policy: restartRaw.policy }
                    : {}),
                  ...(typeof restartRaw.maxAttempts === 'number' ? { maxAttempts: restartRaw.maxAttempts } : {}),
                  ...(Array.isArray(restartRaw.backoffMs)
                    ? { backoffMs: restartRaw.backoffMs.filter((n): n is number => typeof n === 'number') }
                    : {}),
                },
              }
            : {}),
        };
      }
    }
  }

  let dependencies: ListenerDependencies | undefined;
  if (input.dependencies !== undefined) {
    if (typeof input.dependencies !== 'object' || input.dependencies === null) {
      errors.push('dependencies must be an object');
    } else {
      const deps = input.dependencies as Record<string, unknown>;
      const runtimeDeps: Record<string, string> = {};
      if (deps.runtime !== undefined) {
        if (typeof deps.runtime !== 'object' || deps.runtime === null) {
          errors.push('dependencies.runtime must be an object');
        } else {
          for (const [key, value] of Object.entries(deps.runtime as Record<string, unknown>)) {
            if (typeof value !== 'string') errors.push(`dependencies.runtime.${key} must be a string range`);
            else runtimeDeps[key] = value;
          }
        }
      }

      const packages: ListenerPackageDep[] = [];
      if (deps.packages !== undefined) {
        if (!Array.isArray(deps.packages)) {
          errors.push('dependencies.packages must be an array');
        } else {
          for (const [index, entry] of deps.packages.entries()) {
            const pkg = entry as Record<string, unknown>;
            const manager = pkg?.manager;
            const pkgName = typeof pkg?.name === 'string' ? pkg.name : undefined;
            const range = typeof pkg?.range === 'string' ? pkg.range : undefined;
            if (manager !== 'pip' && manager !== 'npm') {
              errors.push(`dependencies.packages[${index}].manager must be "pip" or "npm"`);
            } else if (!pkgName) {
              errors.push(`dependencies.packages[${index}].name is required`);
            } else {
              packages.push({ manager, name: pkgName, range: range ?? '*' });
            }
          }
        }
      }

      const system: string[] = [];
      if (deps.system !== undefined) {
        if (!Array.isArray(deps.system)) errors.push('dependencies.system must be an array');
        else for (const entry of deps.system) if (typeof entry === 'string') system.push(entry);
      }

      dependencies = {
        ...(Object.keys(runtimeDeps).length ? { runtime: runtimeDeps } : {}),
        ...(packages.length ? { packages } : {}),
        ...(system.length ? { system } : {}),
      };
    }
  }

  let config: ListenerConfigSchema | undefined;
  if (input.config !== undefined) {
    if (typeof input.config !== 'object' || input.config === null) {
      errors.push('config must be an object');
    } else {
      const cfg = input.config as Record<string, unknown>;
      if (typeof cfg.properties !== 'object' || cfg.properties === null) {
        errors.push('config.properties must be an object');
      } else {
        config = {
          type: 'object',
          properties: cfg.properties as ListenerConfigSchema['properties'],
          ...(Array.isArray(cfg.required)
            ? { required: cfg.required.filter((v): v is string => typeof v === 'string') }
            : {}),
        };
      }
    }
  }

  const setup: Array<{ text: string; link?: string }> = [];
  if (input.setup !== undefined) {
    if (!Array.isArray(input.setup)) errors.push('setup must be an array');
    else {
      for (const entry of input.setup) {
        const step = entry as Record<string, unknown>;
        if (typeof step?.text !== 'string') continue;
        setup.push({ text: step.text, ...(typeof step.link === 'string' ? { link: step.link } : {}) });
      }
    }
  }

  // A listener without a runtime is display-only (the user runs it by hand).
  if (!runtime) warnings.push('no runtime.program — Craft will not start this listener');

  if (errors.length) return { ok: false, errors, warnings };

  const manifest: ListenerManifest = {
    spec: LISTENER_SPEC,
    id: id!,
    name: name!,
    version: version!,
    ...(str(input.description) ? { description: str(input.description)! } : {}),
    ...(str(input.icon) ? { icon: str(input.icon)! } : {}),
    ...(str(input.author) ? { author: str(input.author)! } : {}),
    ...(str(input.homepage) ? { homepage: str(input.homepage)! } : {}),
    ...(runtime ? { runtime } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(config ? { config } : {}),
    ...(setup.length ? { setup } : {}),
    ...(input.permissions && typeof input.permissions === 'object'
      ? { permissions: input.permissions as ListenerManifest['permissions'] }
      : {}),
  };

  return { ok: true, manifest, errors, warnings };
}
