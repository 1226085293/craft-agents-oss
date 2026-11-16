/**
 * Plugin-provided HTML page — sandboxed rendering + theme hand-off + action
 * relay.
 *
 * The manifest declares `ui.page` (a file inside the plugin directory) or
 * `ui.pageInline`; the server ships the document over RPC and this component
 * renders it under the detail page's 内容 section.
 *
 * The page is the plugin's own surface: it shows what it wants (a QR code, a
 * status table, a chart) and interacts with the user. When it needs the
 * plugin to do something, it posts `{ type: 'action', action, args,
 * requestId }`; the host relays that to the plugin's loopback control
 * service as a manifest-declared action and answers with `action-result`.
 * Craft knows nothing about what an action means — the manifest whitelist is
 * the only gate.
 *
 * Security boundary:
 *   - sandbox="allow-scripts allow-forms": NO allow-same-origin, so the
 *     document runs on an opaque origin — it cannot read Craft's DOM,
 *     cookies, localStorage, or reach the Electron bridge. No allow-popups,
 *     no allow-top-navigation: it cannot open windows or navigate Craft.
 *     Scripts stay enabled because that is the point of a plugin page.
 *   - Messages are only accepted from this exact iframe (event.source check)
 *     and only when they carry `source: "craft-plugin-ui"`.
 *   - Actions are only relayed when the manifest declares them; the result
 *     of an undeclared action is a plain refusal, never an execution.
 *
 * Theme hand-off (day/night + palette), two layers:
 *   1. First paint: a `<style data-craft-theme>` block is injected into the
 *      document head carrying `color-scheme` plus Craft's CSS custom
 *      properties — so the theme is right before the plugin's own scripts
 *      run.
 *   2. Live: on every theme switch, `{ type: 'theme', colorScheme, cssVars }`
 *      is posted so a plugin that keeps its page alive can re-skin without a
 *      reload (the frame is NOT re-created on theme change — plugin page
 *      state survives day/night flips). Craft's values are a baseline; the
 *      plugin's own styles may still override them.
 *
 * Bridge protocol (all messages carry source: 'craft-plugin-ui'):
 *   parent → iframe: { type: 'init', colorScheme, cssVars, config }
 *                    { type: 'theme', colorScheme, cssVars }
 *                    { type: 'action-result', requestId, ok, message }
 *   iframe → parent: { type: 'ready' }
 *                    { type: 'resize', height }
 *                    { type: 'action', action, args, requestId }
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The tokens a plugin page is most likely to style against. Craft's palette
 * is theme-driven (light/dark sets in index.css); passing the raw variable
 * values means the plugin document tracks Craft's current theme.
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

export interface PluginPageFrameProps {
  /** The plugin's HTML document (fetched by the server, never by the renderer). */
  html: string
  /** Whether Craft is currently in dark mode — drives color-scheme + variables. */
  isDark: boolean
  /**
   * Craft's current UI language (e.g. `zh-Hans`, `en`).
   *
   * The frame is sandboxed without `allow-same-origin`, so the page cannot read
   * the host's locale from `localStorage`, and `navigator.language` only reports
   * the OS language — a host switched to English still sees `zh-CN` there. The
   * locale is therefore handed over explicitly, on init and again whenever it
   * changes.
   */
  locale: string
  /**
   * The listener's saved config, handed to the page on init so it can show
   * its own state (read-only from the page's side; writing goes through the
   * plugin's actions or Craft's config form).
   */
  config: Record<string, unknown>
  /**
   * Relay a page action to the plugin's control service. The manifest
   * whitelist is enforced server-side; the parent just resolves with the
   * plugin's own answer.
   */
  onAction: (action: string, args: Record<string, unknown>) => Promise<{ ok: boolean; message: string }>
  className?: string
}

const MIN_HEIGHT = 120
const MAX_HEIGHT = 1600
const DEFAULT_HEIGHT = 320

export function PluginPageFrame({
  html,
  isDark,
  locale,
  config,
  onAction,
  className,
}: PluginPageFrameProps): React.ReactElement {
  const { t } = useTranslation()
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = React.useState(DEFAULT_HEIGHT)

  // Snapshot taken at mount: the theme block is baked into srcDoc once, so a
  // later theme flip reaches the frame through the live 'theme' post below,
  // not through a document reload (which would reset the plugin's page).
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
  const onActionRef = React.useRef(onAction)
  onActionRef.current = onAction
  const isDarkRef = React.useRef(isDark)
  isDarkRef.current = isDark
  const localeRef = React.useRef(locale)
  localeRef.current = locale

  const post = React.useCallback((message: Record<string, unknown>) => {
    const frame = iframeRef.current
    frame?.contentWindow?.postMessage({ source: 'craft-plugin-ui', ...message }, '*')
  }, [])

  // Announce the current theme + variables to a live frame on every flip.
  //
  // The read is deferred by one frame on purpose: `isDark` changes as soon as
  // React re-renders, but the host's CSS variables are applied to the document
  // afterwards. Reading them in the effect body sent the *new* colorScheme
  // together with the *old* variables — a light-page-on-dark-background pair,
  // which is exactly the “inverted theme” a plugin saw on every flip.
  React.useEffect(() => {
    let cancelled = false
    let second = 0
    const send = () => {
      if (cancelled) return
      const vars = collectThemeVars()
      // Nothing to announce if the host has not painted the new variables yet
      // (still the previous round's values): the next frame will catch up.
      post({
        type: 'theme',
        colorScheme: isDark ? 'dark' : 'light',
        cssVars: vars,
      })
    }
    const raf = requestAnimationFrame(() => {
      second = requestAnimationFrame(send)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (second) cancelAnimationFrame(second)
    }
  }, [isDark, post])

  // Language changes arrive the same way: no document reload, so the page keeps
  // whatever state the person had reached.
  React.useEffect(() => {
    post({ type: 'locale', locale })
  }, [locale, post])

  // When the document (re)loads: hand it the full initial state.
  React.useEffect(() => {
    const frame = iframeRef.current
    if (!frame) return
    const announce = () => {
      post({
        type: 'init',
        colorScheme: isDarkRef.current ? 'dark' : 'light',
        cssVars: collectThemeVars(),
        locale: localeRef.current,
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
      const data = event.data as {
        source?: string
        type?: string
        action?: string
        args?: unknown
        requestId?: unknown
        height?: unknown
      } | null
      if (!data || data.source !== 'craft-plugin-ui' || typeof data.type !== 'string') return

      if (data.type === 'ready') {
        post({ type: 'init', locale: localeRef.current, config: configRef.current })
      }
      if (data.type === 'action' && typeof data.action === 'string') {
        const requestId = typeof data.requestId === 'string' || typeof data.requestId === 'number'
          ? data.requestId
          : null
        const args =
          data.args !== null && typeof data.args === 'object' && !Array.isArray(data.args)
            ? (data.args as Record<string, unknown>)
            : {}
        void onActionRef.current(data.action, args).then((result) => {
          post({ type: 'action-result', requestId, ok: result.ok, message: result.message })
        })
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
      title={t('events.page.title')}
      sandbox="allow-scripts allow-forms"
      srcDoc={srcDoc}
      style={{ height }}
      scrolling="auto"
      className={`w-full border-0 bg-background ${className ?? ''}`}
    />
  )
}
