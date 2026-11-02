/**
 * Is this base URL the Craft gateway's strategy endpoint?
 *
 * The gateway is the one endpoint that understands Anthropic's *adaptive*
 * thinking shape, and the only path on which the session's thinking level
 * survives: the budget-based shape runs the level through pi-ai's
 * `clampReasoning()`, which folds `xhigh`/`max` into `high`, so `max` and `high`
 * leave as the same `budget_tokens: 16384` and the relay runs at its own
 * default (2026-10-29).
 *
 * Detection has to be narrow. A user's own anthropic-compatible relay on
 * loopback has never been sent `output_config` and may reject it, so it keeps
 * the budget shape — hence both conditions: loopback host AND the gateway's
 * `/s/<strategyId>` path (see `applyGatewayStrategy` in server-core).
 */
export function isCraftGatewayEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  return loopback && /^\/s\/[^/]+\/?$/.test(url.pathname)
}
