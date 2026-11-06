/**
 * Plugin-provided HTML config UI — sandboxed rendering + theme hand-off.
 *
 * The manifest declares `ui.configHtml` (a file inside the plugin directory)
 * or `ui.configHtmlInline`; the server ships the document over RPC and this
 * component renders it.
 *
 * Security boundary:
 *   - sandbox="allow-scripts allow-forms": NO allow-same-origin, so the
 *     document runs on an opaque origin — it cannot read Craft's DOM,
 *     cookies, localStorage, or reach the Electron bridge. No allow-popups,
 *     no allow-top-navigation: it cannot open windows or navigate Craft.
 *     Scripts stay enabled because that is the point of a config UI.
 *   - Messages are only accepted from this exact iframe (event.source check)
 *     and only when they carry `source: "craft-plugin-ui"`.
 *   - Config updates are coerced against the manifest schema
 *     (sanitizePluginConfigUpdate, shared) before they reach the save path.
 *
 * Theme hand-off (day/night + palette), two layers:
 *   1. First paint: a `<style data-craft-theme>` block is injected into the
 *      document head carrying `color-scheme` plus Craft's CSS custom
 *      properties — so the theme is right before the plugin's own scripts
 *      run.
 *   2. Live: on every theme switch, `{ type: 'theme', colorScheme, cssVars }`
 *      is posted so a plugin that keeps its form alive can re-skin without a
 *      reload (the frame is NOT re-created on theme change — plugin form
 *      state survives day/night flips). Craft's values are a baseline; the
 *      plugin's own styles may still override them.
 *
 * Bridge protocol (all messages carry source: 'craft-plugin-ui'):
 *   parent → iframe: { type: 'init', colorScheme, cssVars, config }
 *                    { type: 'theme', colorScheme, cssVars }
 *                    { type: 'config', config }
 *   iframe → parent: { type: 'ready' }
 *                    { type: 'config-update', config }
 *                    { type: 'resize', height }
 */

import * as React from 'react'
import {
  sanitizePluginConfigUpdate,
  type ListenerConfigSchemaLike,
} from '@craft-agent/shared/events/plugin-status'

/**
 * The tokens a plugin config form is most likely to style against. Craft's
 * palette is theme-driven (light/dark sets in index.css); passing the raw
 * variable values means the plugin document tracks Craft's current theme.
 */
const THEME_VARS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
  '--success',
  '--info',
]

function collectThemeVars(): Record<string, string> {
  const styles = window.getComputedStyle(document.documentElement)
  const out: Record<string, string> = {}
  for (const name of THEME_VARS) {
    const value = styles.getPropertyValue(name).trim()
    if (value) out[name] = value
  }
  return out
}

/**
 * Inject the theme block into the document head (or before the first content
 * when there is none). String surgery only — the document is plugin-owned and
 * must not be parsed.
 */
function buildSrcDoc(html: string, colorScheme: 'light' | 'dark', cssVars: Record<string, string>): string {
  const decls = Object.entries(cssVars)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n')
  const style = `<style data-craft-theme>html, :root {\n  color-scheme: ${colorScheme};\n${decls}\n}</style>`
  const head = html.match(/<head[^>]*>/i)
  if (head) return html.replace(head[0], `${head[0]}${style}`)
  return `${style}\n${html}`
}

export interface PluginConfigUiFrameProps {
  /** The plugin's HTML document (fetched by the server, never by the renderer). */
  html: string
  /** Whether Craft is currently in dark mode — drives color-scheme + variables. */
  isDark: boolean
  /** The manifest config schema: the contract the plugin's updates are checked against. */
  configSchema?: ListenerConfigSchemaLike
  /**
   * Current draft values; pushed to the frame when it signals ready. May
   * hold native number/boolean values — the plugin form is the only thing
   * that reads them back.
   */
  config: Record<string, unknown>
  /** Called with a schema-sanitized patch; the parent decides merging/saving. */
  onConfigUpdate: (patch: Record<string, string | number | boolean>) => void
  className?: string
}

const MIN_HEIGHT = 120
const MAX_HEIGHT = 900
const DEFAULT_HEIGHT = 320

export function PluginConfigUiFrame({
  html,
  isDark,
  configSchema,
  config,
  onConfigUpdate,
  className,
}: PluginConfigUiFrameProps): React.ReactElement {
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = React.useState(DEFAULT_HEIGHT)

  // Snapshot taken at mount: the theme block is baked into srcDoc once, so a
  // later theme flip reaches the frame through the live 'theme' post below,
  // not through a document reload (which would reset the plugin's form).
  const [mountCssVars] = React.useState<Record<string, string>>(() => collectThemeVars())
  const mountSchemeRef = React.useRef<'light' | 'dark'>(isDark ? 'dark' : 'light')
  const srcDoc = React.useMemo(
    () => buildSrcDoc(html, mountSchemeRef.current, mountCssVars),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, mountCssVars],
  )

  // Live refs so the message handler never works from a stale closure.
  const configRef = React.useRef(config)
  configRef.current = config
  const onConfigUpdateRef = React.useRef(onConfigUpdate)
  onConfigUpdateRef.current = onConfigUpdate
  const configSchemaRef = React.useRef(configSchema)
  configSchemaRef.current = configSchema
  const isDarkRef = React.useRef(isDark)
  isDarkRef.current = isDark

  const post = React.useCallback((message: Record<string, unknown>) => {
    const frame = iframeRef.current
    frame?.contentWindow?.postMessage({ source: 'craft-plugin-ui', ...message }, '*')
  }, [])

  // Announce the current theme + variables to a live frame on every flip.
  React.useEffect(() => {
    post({
      type: 'theme',
      colorScheme: isDark ? 'dark' : 'light',
      cssVars: collectThemeVars(),
    })
  }, [isDark, post])

  // When the document (re)loads: hand it the full initial state.
  React.useEffect(() => {
    const frame = iframeRef.current
    if (!frame) return
    const announce = () => {
      post({
        type: 'init',
        colorScheme: isDarkRef.current ? 'dark' : 'light',
        cssVars: collectThemeVars(),
        config: configRef.current,
      })
    }
    frame.addEventListener('load', announce)
    announce() // in case the load event already fired before we attached
    return () => frame.removeEventListener('load', announce)
  }, [srcDoc, post])

  // iframe → parent: only this exact frame, only the plugin's protocol.
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current
      // A sandboxed (no same-origin) frame reports origin "null"; the
      // contentWindow identity check is the real boundary.
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data as { source?: string; type?: string; config?: unknown; height?: unknown } | null
      if (!data || data.source !== 'craft-plugin-ui' || typeof data.type !== 'string') return

      if (data.type === 'ready') {
        post({ type: 'config', config: configRef.current })
      }
      if (data.type === 'config-update') {
        const clean = sanitizePluginConfigUpdate(data.config, configSchemaRef.current)
        if (Object.keys(clean).length > 0) onConfigUpdateRef.current(clean)
      }
      if (data.type === 'resize' && typeof data.height === 'number' && Number.isFinite(data.height)) {
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(data.height))))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [post])

  return (
    <iframe
      ref={iframeRef}
      title="插件自定义配置界面"
      sandbox="allow-scripts allow-forms"
      srcDoc={srcDoc}
      style={{ height }}
      scrolling="auto"
      className={`w-full border-0 bg-background ${className ?? ''}`}
    />
  )
}
