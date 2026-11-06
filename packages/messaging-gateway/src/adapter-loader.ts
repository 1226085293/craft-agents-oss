/**
 * Loads a platform adapter from the plugin that owns it.
 *
 * The host holds no platform code. A plugin ships `program/index.ts` exporting a
 * factory, and this module is the single place that knows how to find it: the
 * plugin directory comes from the catalog, the factory is looked up by name,
 * and nothing here mentions QQ, Telegram, 飞书, 微信 or WhatsApp.
 *
 * Shipping adapters as plugin programs is what makes "add a platform" a plugin
 * change rather than a host release.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PlatformAdapter } from './types'

/** Shape every plugin program must export. */
export interface AdapterProgramModule {
  /** Named export the loader calls. */
  createAdapter?: (options?: Record<string, unknown>) => PlatformAdapter
  /**
   * Turns the stored credential blob into a typed shape.
   *
   * Credential formats are platform knowledge: Lark wants appId/appSecret JSON,
   * QQ wants its own. Keeping the parser in the plugin is what lets the host
   * accept a new format without a release.
   */
  parseCredentials?: (raw: string | undefined) => unknown
}

export interface AdapterLoaderOptions {
  /** Directories to search, highest priority first (workspace, then catalog). */
  pluginDirs: string[]
  /** Override for tests. */
  importModule?: (url: string) => Promise<AdapterProgramModule>
}

let cached: AdapterLoaderOptions | null = null

/** Configure once at boot (bootstrap passes the workspace + catalog dirs). */
export function configureAdapterLoader(options: AdapterLoaderOptions): void {
  cached = options
}

/** Where a plugin's program lives, if it has one. */
export function adapterProgramPath(pluginId: string, dirs = cached?.pluginDirs ?? []): string | null {
  for (const root of dirs) {
    const candidate = join(root, pluginId, 'program', 'index.ts')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Instantiate the adapter a plugin ships.
 *
 * A plugin without a program is not an error: it is a receive-only plugin, and
 * the caller decides what that means (the registry only calls this for
 * platforms it was asked to connect).
 */
export async function loadAdapter(
  pluginId: string,
  options: Record<string, unknown> = {},
): Promise<PlatformAdapter | null> {
  const path = adapterProgramPath(pluginId)
  if (!path) return null

  const importer = cached?.importModule ?? ((url: string) => import(url))
  const mod = await importer(pathToFileURL(path).href)
  if (typeof mod.createAdapter !== 'function') {
    throw new Error(`plugin ${pluginId}: program/index.ts must export createAdapter()`)
  }
  return mod.createAdapter(options)
}

/** Parse a stored credential blob with the plugin's own parser. */
export async function parsePluginCredentials(pluginId: string, raw: string | undefined): Promise<unknown> {
  const path = adapterProgramPath(pluginId)
  if (!path) throw new Error(`plugin ${pluginId} has no program, cannot parse credentials`)
  const importer = cached?.importModule ?? ((url: string) => import(url))
  const mod = await importer(pathToFileURL(path).href)
  if (typeof mod.parseCredentials !== 'function') {
    throw new Error(`plugin ${pluginId}: program must export parseCredentials()`)
  }
  return mod.parseCredentials(raw)
}
