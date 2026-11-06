/**
 * Loads a plugin's program, whatever language it is written in.
 *
 * The host knows two execution shapes and nothing else:
 *
 *   module   — TS/JS that exports `createAdapter` / `parseCredentials`.
 *              Loaded in-process, so it can be a normal adapter object.
 *   process  — anything the machine can run (python, node, a binary). The host
 *              spawns it and speaks JSON over stdin/stdout. No in-process
 *              access, which is also the only shape that can be sandboxed later.
 *
 * Which one applies is declared by the plugin (`program.entry`), with a sensible
 * fallback ladder so a plugin that just drops `program/index.ts` works without
 * configuration. Nothing here names a platform.
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PlatformAdapter } from './types'

/** Module shape (TS/JS, in-process). */
export interface AdapterProgramModule {
  createAdapter?: (options?: Record<string, unknown>) => PlatformAdapter
  /**
   * Turns the stored credential blob into a typed shape.
   *
   * Credential formats are platform knowledge, so the plugin parses its own.
   */
  parseCredentials?: (raw: string | undefined) => unknown
}

/**
 * A program's own declaration, read from `manifest.program`.
 *
 * `entry` is relative to the plugin directory. When omitted the loader probes
 * `program/index.ts`, then `index.js`, then `program/index.js`.
 */
export interface ProgramDeclaration {
  entry?: string
  /** `module` loads in-process; `process` spawns `runtime`. */
  kind?: 'module' | 'process'
  /** argv for `process`, e.g. `["python", "program/main.py"]`. */
  runtime?: string[]
  /** Per-request timeout for `process` mode. */
  timeoutMs?: number
}

export interface AdapterLoaderOptions {
  /** Directories to search, highest priority first (workspace, then catalog). */
  pluginDirs: string[]
  /** Override for tests. */
  importModule?: (url: string) => Promise<AdapterProgramModule>
  /** Reads `manifest.program` for a plugin; absent = probe the ladder. */
  readProgram?: (pluginId: string, dir: string) => ProgramDeclaration | null
}

let cached: AdapterLoaderOptions | null = null

export function configureAdapterLoader(options: AdapterLoaderOptions): void {
  cached = options
}

const ENTRY_LADDER = ['program/index.ts', 'program/index.js', 'index.js', 'index.ts']

/** Resolve the plugin directory (first root that has it). */
function pluginDir(pluginId: string, dirs = cached?.pluginDirs ?? []): string | null {
  for (const root of dirs) {
    const dir = join(root, pluginId)
    if (existsSync(dir)) return dir
  }
  return null
}

export interface ResolvedProgram {
  dir: string
  /** Absolute path of the entry file, when it is a module. */
  entry?: string
  kind: 'module' | 'process'
  runtime?: string[]
  timeoutMs?: number
}

/**
 * Work out what to run for a plugin.
 *
 * Returns null when the plugin ships no program at all — that is a legitimate
 * state (a receive-only plugin), not an error.
 */
export function resolveProgram(
  pluginId: string,
  dirs = cached?.pluginDirs ?? [],
): ResolvedProgram | null {
  const dir = pluginDir(pluginId, dirs)
  if (!dir) return null

  const declared = cached?.readProgram?.(pluginId, dir) ?? readDeclaredProgram(dir)

  if (declared?.kind === 'process' && declared.runtime?.length) {
    return {
      dir,
      kind: 'process',
      runtime: declared.runtime,
      ...(declared.timeoutMs ? { timeoutMs: declared.timeoutMs } : {}),
    }
  }

  // Explicit entry wins; otherwise probe the ladder so a plugin that simply
  // drops program/index.ts needs no manifest field at all.
  const candidates = declared?.entry ? [declared.entry] : ENTRY_LADDER
  for (const rel of candidates) {
    const abs = join(dir, rel)
    if (existsSync(abs)) {
      return { dir, entry: abs, kind: 'module', ...(declared?.timeoutMs ? { timeoutMs: declared.timeoutMs } : {}) }
    }
  }

  // A declared runtime without `kind` is still a process plugin: the plugin
  // said how to start it, so honour that over "no program".
  if (declared?.runtime?.length) {
    return { dir, kind: 'process', runtime: declared.runtime, ...(declared?.timeoutMs ? { timeoutMs: declared.timeoutMs } : {}) }
  }

  return null
}

/** The plugin's own `manifest.json` → `program` block. */
function readDeclaredProgram(dir: string): ProgramDeclaration | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    const program = raw.program
    if (program && typeof program === 'object') {
      const p = program as Record<string, unknown>
      return {
        ...(typeof p.entry === 'string' ? { entry: p.entry } : {}),
        ...(p.kind === 'module' || p.kind === 'process' ? { kind: p.kind } : {}),
        ...(Array.isArray(p.runtime) && p.runtime.every((x) => typeof x === 'string')
          ? { runtime: p.runtime as string[] }
          : {}),
        ...(typeof p.timeoutMs === 'number' ? { timeoutMs: p.timeoutMs } : {}),
      }
    }
    // Back-compat: `runtime.program` was the pre-polyglot name for the argv.
    const legacy = raw.runtime as Record<string, unknown> | undefined
    if (legacy && Array.isArray(legacy.program) && legacy.program.every((x) => typeof x === 'string')) {
      return { kind: 'process', runtime: legacy.program as string[] }
    }
    return null
  } catch {
    return null
  }
}

/** Kept for callers that only need "is there a module entry". */
export function adapterProgramPath(pluginId: string, dirs = cached?.pluginDirs ?? []): string | null {
  const resolved = resolveProgram(pluginId, dirs)
  return resolved?.kind === 'module' ? (resolved.entry ?? null) : null
}

/** What a process-mode program answers. */
interface ProcessResult {
  ok?: boolean
  adapter?: unknown
  value?: unknown
  error?: string
}

/**
 * Run one request against a process-mode program.
 *
 * One spawn per request: a platform's program is short-lived by design here, and
 * a persistent channel would need a supervision protocol the host does not have
 * yet. Spawn cost is ~20ms, paid only when credentials are parsed or an adapter
 * is constructed.
 */
async function runProcess(
  resolved: ResolvedProgram,
  request: Record<string, unknown>,
): Promise<ProcessResult> {
  const [cmd, ...args] = resolved.runtime ?? []
  if (!cmd) throw new Error('plugin program declares no runtime command')

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: resolved.dir, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`plugin program timed out after ${resolved.timeoutMs ?? 10_000}ms`))
    }, resolved.timeoutMs ?? 10_000)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`plugin program exited ${code}: ${stderr.trim().slice(0, 400)}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as ProcessResult)
      } catch {
        reject(new Error(`plugin program returned non-JSON: ${stdout.slice(0, 200)}`))
      }
    })

    child.stdin.end(JSON.stringify(request))
  })
}

/**
 * Instantiate the adapter a plugin ships.
 *
 * Module mode returns the adapter object directly. Process mode returns a thin
 * adapter that forwards every call to the program — the host still gets a
 * `PlatformAdapter`, so nothing downstream branches on the language.
 */
export async function loadAdapter(
  pluginId: string,
  options: Record<string, unknown> = {},
): Promise<PlatformAdapter | null> {
  const resolved = resolveProgram(pluginId)
  if (!resolved) return null

  if (resolved.kind === 'process') {
    const result = await runProcess(resolved, { op: 'createAdapter', options })
    if (!result.ok || !result.adapter) {
      throw new Error(result.error ?? `plugin ${pluginId}: program failed to create an adapter`)
    }
    if (typeof result.adapter !== 'object') {
      throw new Error(`plugin ${pluginId}: program must return an adapter object`)
    }
    // A process plugin may only implement the outbound action it declared; the
    // host treats a missing method as "not supported" rather than crashing.
    return result.adapter as PlatformAdapter
  }

  const importer = cached?.importModule ?? ((url: string) => import(url))
  const mod = await importer(pathToFileURL(resolved.entry!).href)
  if (typeof mod.createAdapter !== 'function') {
    throw new Error(`plugin ${pluginId}: program must export createAdapter()`)
  }
  return mod.createAdapter(options)
}

/** Parse a stored credential blob with the plugin's own parser. */
export async function parsePluginCredentials(pluginId: string, raw: string | undefined): Promise<unknown> {
  const resolved = resolveProgram(pluginId)
  if (!resolved) throw new Error(`plugin ${pluginId} has no program, cannot parse credentials`)

  if (resolved.kind === 'process') {
    const result = await runProcess(resolved, { op: 'parseCredentials', raw })
    if (!result.ok) throw new Error(result.error ?? `plugin ${pluginId}: credential parser failed`)
    return result.value
  }

  const importer = cached?.importModule ?? ((url: string) => import(url))
  const mod = await importer(pathToFileURL(resolved.entry!).href)
  if (typeof mod.parseCredentials !== 'function') {
    throw new Error(`plugin ${pluginId}: program must export parseCredentials()`)
  }
  return mod.parseCredentials(raw)
}
