/**
 * Listener manifest — the npm-ish contract a listener package declares.
 *
 * A listener lives at `<workspace>/events/<listenerId>/manifest.json`. Craft
 * reads it to decide whether the listener can start (runtime present, packages
 * installed), what to spawn, which config the user fills in, and what to show
 * as setup instructions.
 */

export const LISTENER_SPEC = 'craft-listener/1' as const;

/**
 * Plugin manifests: `craft-listener/1` was receive-only, `craft-plugin/1` adds
 * `actions`. Both are accepted — an installed listener from before the rename
 * must keep working, it simply declares no actions.
 */
export const PLUGIN_SPEC = 'craft-plugin/1' as const;
export const ACCEPTED_SPECS: ReadonlyArray<string> = [PLUGIN_SPEC, LISTENER_SPEC];

/**
 * One thing Craft may ask a plugin to do.
 *
 * This is what makes "the supervisor knows what it can send" possible without
 * a hand-written prompt: `input` is a JSON Schema, the same shape an MCP tool
 * uses, so the existing tool table can carry it and the model reads the
 * parameter meanings straight from the schema descriptions.
 */
export interface PluginAction {
  /** Tool-name segment: lowercase, `send_message`, `reply`, … */
  name: string;
  /** What it does. Shown to the model verbatim — write it for the model. */
  description: string;
  /** JSON Schema for the arguments. */
  input: {
    type?: 'object';
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  /**
   * True when the action answers whoever caused the current turn rather than
   * addressing an arbitrary channel. `reply` is the obvious case: the target is
   * the event's origin, which the model should not have to invent.
   */
  repliesToOrigin?: boolean;
  /**
   * Expose this action as a model tool, not just a host capability.
   *
   * The distinction matters for prompt stability: a tool is assembled into the
   * session's tool table **once, at session creation**, and never re-evaluated
   * mid-session. Toggling a plugin therefore affects the next session, not the
   * current turn — changing a running session's tool table would invalidate the
   * prompt cache and leave the model describing tools it no longer has.
   */
  asTool?: boolean;
}

export interface ListenerRestartPolicy {
  /** Only `on-failure` is honoured today. */
  policy?: 'on-failure' | 'always' | 'never';
  maxAttempts?: number;
  backoffMs?: number[];
}


/**
 * A slash command the plugin answers.
 *
 * Declared, not implemented here: the host only knows that `/foo` belongs to
 * this plugin and forwards the rest. That is what keeps a platform's vocabulary
 * out of Craft — adding `/dice` to a plugin must not require touching the host.
 */
export interface PluginCommand {
  /** Without the slash: `status`, `bind`, `wallet`. */
  name: string;
  /** One line shown by /help, written for a human on a phone. */
  description: string;
  /** Optional argument hint, e.g. `<name>`. */
  usage?: string;
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

/** MCP server dependency. Managed installs are owned by Craft, never the listener. */
export interface ListenerMcpDep {
  /** Stable identifier; also the managed install directory name. */
  id: string;
  mode: 'managed' | 'remote';
  /** managed: where the server comes from. `manual` = user installs, Craft only probes. */
  source?: 'npm' | 'pypi' | 'manual';
  package?: string;
  /** npm-style range for the managed install. */
  version?: string;
  /** remote: connect-only endpoint — nothing to install. */
  url?: string;
  /** remote auth hint, e.g. `oauth` or `bearer`. Display-only. */
  auth?: string;
}

export interface ListenerDependencies {
  packages?: ListenerPackageDep[];
  /** MCP servers the listener talks to. Managed ones Craft installs into `<workspace>/mcp/<id>/`. */
  mcp?: ListenerMcpDep[];
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
  /**
   * Numeric bounds and granularity, for `type: 'number'`.
   *
   * Declared so a plugin can say "this is a TCP port" without a host release:
   * the renderer reads them defensively (a missing key just means no bound),
   * and the host rebuilds an honest `number` input instead of a free-text box.
   * They are advisory UI facts — the host does not police them, because the
   * plugin is the only thing that knows what the value is for.
   */
  min?: number;
  max?: number;
  step?: number;
}

export interface ListenerConfigSchema {
  type?: 'object';
  properties: Record<string, ListenerConfigProperty>;
  required?: string[];
}

export interface ListenerManifest {
  spec: typeof LISTENER_SPEC | typeof PLUGIN_SPEC;
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
  /** Outbound actions Craft may invoke. Absent = receive-only plugin. */
  actions?: PluginAction[];
  /** Slash commands this plugin answers; the host only routes them. */
  commands?: PluginCommand[];
  /**
   * Directory with this plugin's own translations, relative to the plugin
   * directory (`i18n/<locale>.json`). Absent means the plugin ships none and
   * its UI strings come from the manifest verbatim.
   */
  locales?: string;
  setup?: Array<{ text: string; link?: string }>;
  /**
   * Plugin-provided HTML page, rendered in a sandboxed iframe under the
   * detail page's 内容 section. Either a file inside the plugin directory
   * (`page`) or an inline document (`pageInline`) — never both. The page is
   * the plugin's own surface: it may read the current config (handed over on
   * init) and call back through the bridge to trigger one of the plugin's
   * manifest-declared actions. Craft only relays — no platform vocabulary.
   */
  ui?: ListenerUi;
}

/**
 * A messaging listener can receive platform messages AND answer the one
 * that produced the current event — the manifest's `reply` action carries
 * `repliesToOrigin: true`, and that flag only makes sense on a chat
 * platform (收件人由事件本身决定). Every platform plugin (telegram /
 * wechat / whatsapp / lark / qq) already declares it, so the host gets
 * one shared predicate for everything pairing-related — no per-plugin
 * flag, and any future platform that declares a reply action the same way
 * is recognized without adapter code.
 */
export function isMessagingListener(manifest: ListenerManifest): boolean {
  return (manifest.actions ?? []).some((action) => action.repliesToOrigin === true)
}

/**
 * Path budget for a plugin page file. The host resolves it against the
 * plugin directory and refuses to read outside it, so the manifest is the
 * first line of that confinement — relative segments only.
 */
export const LISTENER_UI_PATH_MAX = 200;
/** Inline documents are manifest payload, not code: cap them the same way. */
export const LISTENER_UI_INLINE_MAX = 512 * 1024;

export interface ListenerUi {
  /** Relative path to the HTML file, inside the plugin directory. */
  page?: string;
  /** Inline HTML document (mutually exclusive with `page`). */
  pageInline?: string;
}

export interface ManifestParseResult {
  ok: boolean;
  manifest?: ListenerManifest;
  errors: string[];
  warnings: string[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Keep the fields the renderer understands, and make the numeric ones honest.
 *
 * `config.properties` used to be passed through with a bare type assertion, so
 * anything a manifest wrote arrived at the renderer as-is — including
 * `min: "abc"`. The numeric bounds are advisory UI facts, so a wrong value is
 * dropped rather than turned into a parse error: a plugin must not fail to load
 * because it mistyped a hint. Non-finite values (`NaN`, `Infinity`) are dropped
 * for the same reason — they would become `min="NaN"` on a real input.
 */
function normalizeConfigProperties(
  raw: Record<string, unknown>,
): ListenerConfigSchema['properties'] {
  const out: ListenerConfigSchema['properties'] = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) {
      out[key] = value as ListenerConfigProperty;
      continue;
    }
    const prop = { ...(value as Record<string, unknown>) };
    for (const field of ['min', 'max', 'step'] as const) {
      const candidate = prop[field];
      if (candidate === undefined) continue;
      if (typeof candidate === 'number' && Number.isFinite(candidate)) continue;
      delete prop[field];
    }
    out[key] = prop as ListenerConfigProperty;
  }
  return out;
}

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
/** Action names reach the tool table as `plugin__<id>__<name>`, so no dots or dashes. */
const ACTION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** Package names: pip is plain; npm additionally allows `@scope/name`. */
const PIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NPM_NAME = /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** npm-style range charset. Anything that could smuggle CLI options is rejected. */
const RANGE_PATTERN = /^[0-9A-Za-z.^~<>=|*,\s-]+$/;

/** Names land inside one argv element of a fixed install command — keep them inert. */
export function isValidPackageName(manager: 'pip' | 'npm' | 'pypi', name: string): boolean {
  return (manager === 'npm' ? NPM_NAME : PIP_NAME).test(name);
}

export function isValidRange(range: string): boolean {
  if (typeof range !== 'string') return false;
  if (range.includes('--')) return false;
  return range.trim() === '' || RANGE_PATTERN.test(range);
}

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

  if (!ACCEPTED_SPECS.includes(String(input.spec))) {
    errors.push(`spec must be one of: ${ACCEPTED_SPECS.join(', ')}`);
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
      // Runtime probing moved to the listener itself (control service) — the
      // field is dropped with a warning so old manifests keep loading.
      if (deps.runtime !== undefined) {
        warnings.push(
          'dependencies.runtime is deprecated — verify dependencies in the listener itself (control service), or declare packages/mcp',
        );
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
              continue;
            }
            if (!pkgName) {
              errors.push(`dependencies.packages[${index}].name is required`);
              continue;
            }
            if (!isValidPackageName(manager, pkgName)) {
              errors.push(`dependencies.packages[${index}].name has forbidden characters`);
              continue;
            }
            const finalRange = range ?? '*';
            if (!isValidRange(finalRange)) {
              errors.push(`dependencies.packages[${index}].range has forbidden characters`);
              continue;
            }
            packages.push({ manager, name: pkgName, range: finalRange });
          }
        }
      }

      const mcp: ListenerMcpDep[] = [];
      if (deps.mcp !== undefined) {
        if (!Array.isArray(deps.mcp)) {
          errors.push('dependencies.mcp must be an array');
        } else {
          const seenIds = new Set<string>();
          for (const [index, entry] of deps.mcp.entries()) {
            const raw = entry as Record<string, unknown>;
            const mcpId = typeof raw?.id === 'string' ? raw.id.trim() : '';
            const mode = raw?.mode;
            if (!mcpId || !ID_PATTERN.test(mcpId)) {
              errors.push(`dependencies.mcp[${index}].id must be lowercase [a-z0-9._-], at most 64 chars`);
              continue;
            }
            if (seenIds.has(mcpId)) {
              errors.push(`dependencies.mcp[${index}].id "${mcpId}" is duplicated`);
              continue;
            }
            seenIds.add(mcpId);

            if (mode === 'remote') {
              const url = typeof raw?.url === 'string' ? raw.url.trim() : '';
              let urlOk = false;
              if (url) {
                try {
                  const parsed = new URL(url);
                  urlOk = parsed.protocol === 'https:' || parsed.protocol === 'http:';
                } catch {
                  urlOk = false;
                }
              }
              if (!urlOk) {
                errors.push(`dependencies.mcp[${index}].url must be an http(s) URL`);
                continue;
              }
              mcp.push({
                id: mcpId,
                mode: 'remote',
                url,
                ...(typeof raw?.auth === 'string' && raw.auth.trim()
                  ? { auth: raw.auth.trim().slice(0, 64) }
                  : {}),
              });
              continue;
            }

            if (mode !== 'managed') {
              errors.push(`dependencies.mcp[${index}].mode must be "managed" or "remote"`);
              continue;
            }
            const source = raw?.source;
            if (source !== 'npm' && source !== 'pypi' && source !== 'manual') {
              errors.push(`dependencies.mcp[${index}].source must be "npm", "pypi" or "manual"`);
              continue;
            }
            let pkgName: string | undefined;
            if (source !== 'manual') {
              pkgName = typeof raw?.package === 'string' ? raw.package.trim() : '';
              if (!pkgName || !isValidPackageName(source, pkgName)) {
                errors.push(`dependencies.mcp[${index}].package is required and must be a plain package name`);
                continue;
              }
            }
            const version = typeof raw?.version === 'string' ? raw.version : undefined;
            if (version !== undefined && !isValidRange(version)) {
              errors.push(`dependencies.mcp[${index}].version has forbidden characters`);
              continue;
            }
            mcp.push({
              id: mcpId,
              mode: 'managed',
              source,
              ...(pkgName ? { package: pkgName } : {}),
              ...(version && version.trim() ? { version: version.trim() } : {}),
            });
          }
        }
      }

      const system: string[] = [];
      if (deps.system !== undefined) {
        if (!Array.isArray(deps.system)) errors.push('dependencies.system must be an array');
        else for (const entry of deps.system) if (typeof entry === 'string') system.push(entry);
      }

      dependencies = {
        ...(packages.length ? { packages } : {}),
        ...(mcp.length ? { mcp } : {}),
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
          properties: normalizeConfigProperties(cfg.properties as Record<string, unknown>),
          ...(Array.isArray(cfg.required)
            ? { required: cfg.required.filter((v): v is string => typeof v === 'string') }
            : {}),
        };
      }
    }
  }

  let ui: ListenerUi | undefined;
  if (input.ui !== undefined) {
    if (typeof input.ui !== 'object' || input.ui === null) {
      errors.push('ui must be an object');
    } else {
      const uiObj = input.ui as Record<string, unknown>;
      const page = str(uiObj.page);
      const pageInline = str(uiObj.pageInline);
      if (page !== undefined && pageInline !== undefined) {
        errors.push('ui.page and ui.pageInline are mutually exclusive — pick one');
      } else if (page !== undefined) {
        // Confined to the plugin directory: a relative path of plain
        // segments. Absolute paths, `..` and any other fs/shell syntax fail
        // here and at host resolve time.
        const segments = page.split('/');
        const pathOk =
          page.length <= LISTENER_UI_PATH_MAX &&
          !page.startsWith('/') &&
          !segments.includes('..') &&
          segments.every((seg) => /^[a-zA-Z0-9._-]{1,128}$/.test(seg));
        if (!pathOk) {
          errors.push(
            'ui.page must be a relative path inside the plugin directory (no "..", no absolute paths, ≤ 200 chars)',
          );
        } else {
          ui = { page };
        }
      } else if (pageInline !== undefined) {
        if (pageInline.length > LISTENER_UI_INLINE_MAX) {
          errors.push(`ui.pageInline is too large (max ${LISTENER_UI_INLINE_MAX} chars)`);
        } else {
          ui = { pageInline };
        }
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

  // Outbound actions. Each becomes a tool, so the schema is the model's only
  // documentation for the parameters — a missing description is a real defect,
  // not a style nit.
  const actions: PluginAction[] = [];
  if (input.actions !== undefined) {
    if (!Array.isArray(input.actions)) {
      errors.push('actions must be an array');
    } else {
      const seenActions = new Set<string>();
      for (const [index, entry] of input.actions.entries()) {
        if (!entry || typeof entry !== 'object') {
          errors.push(`actions[${index}] must be an object`);
          continue;
        }
        const action = entry as Record<string, unknown>;
        const actionName = str(action.name);
        if (!actionName) {
          errors.push(`actions[${index}].name is required`);
          continue;
        }
        if (!ACTION_NAME_PATTERN.test(actionName)) {
          errors.push(`actions[${index}].name must be lowercase [a-z0-9_], at most 40 chars`);
          continue;
        }
        if (seenActions.has(actionName)) {
          errors.push(`actions[${index}].name "${actionName}" is declared twice`);
          continue;
        }
        seenActions.add(actionName);

        const description = str(action.description);
        if (!description) errors.push(`actions[${index}].description is required`);

        const rawInput = action.input;
        if (!rawInput || typeof rawInput !== 'object') {
          errors.push(`actions[${index}].input must be a JSON Schema object`);
          continue;
        }
        const schema = rawInput as Record<string, unknown>;
        if (schema.type !== undefined && schema.type !== 'object') {
          errors.push(`actions[${index}].input.type must be "object"`);
        }

        actions.push({
          name: actionName,
          description: description ?? actionName,
          input: {
            type: 'object',
            ...(schema.properties && typeof schema.properties === 'object'
              ? { properties: schema.properties as Record<string, Record<string, unknown>> }
              : {}),
            ...(Array.isArray(schema.required)
              ? { required: schema.required.filter((n): n is string => typeof n === 'string') }
              : {}),
          },
          ...(action.repliesToOrigin === true ? { repliesToOrigin: true } : {}),
        });
      }
    }
  }

  // Slash commands. Names are matched after the '/', so they must be a single
  // token; anything else could never be typed on a phone keyboard.
  const commands: PluginCommand[] = [];
  if (input.commands !== undefined) {
    if (!Array.isArray(input.commands)) {
      errors.push('commands must be an array');
    } else {
      const seenCommands = new Set<string>();
      for (const [index, entry] of input.commands.entries()) {
        if (!entry || typeof entry !== 'object') {
          errors.push(`commands[${index}] must be an object`);
          continue;
        }
        const command = entry as Record<string, unknown>;
        const cmdName = str(command.name)?.replace(/^\//, '');
        if (!cmdName) {
          errors.push(`commands[${index}].name is required`);
          continue;
        }
        if (!ACTION_NAME_PATTERN.test(cmdName)) {
          errors.push(`commands[${index}].name must be lowercase [a-z0-9_], at most 40 chars`);
          continue;
        }
        if (seenCommands.has(cmdName)) {
          errors.push(`commands[${index}].name "${cmdName}" is declared twice`);
          continue;
        }
        seenCommands.add(cmdName);
        const cmdDesc = str(command.description);
        if (!cmdDesc) errors.push(`commands[${index}].description is required`);
        commands.push({
          name: cmdName,
          description: cmdDesc ?? cmdName,
          ...(str(command.usage) ? { usage: str(command.usage)! } : {}),
        });
      }
    }
  }

  if (errors.length) return { ok: false, errors, warnings };

  const manifest: ListenerManifest = {
    // Echo whatever was accepted: a v1 listener stays v1 on re-read, so we do
    // not silently rewrite a user's file just by loading it.
    spec: input.spec === PLUGIN_SPEC ? PLUGIN_SPEC : LISTENER_SPEC,
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
    ...(ui ? { ui } : {}),
    ...(setup.length ? { setup } : {}),
    ...(actions.length ? { actions } : {}),
    ...(commands.length ? { commands } : {}),
    ...(str(input.locales) ? { locales: str(input.locales)! } : {}),
  };

  return { ok: true, manifest, errors, warnings };
}
