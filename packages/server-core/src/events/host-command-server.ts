/**
 * Host command API — the one HTTP surface a plugin uses to act on Craft.
 *
 * A platform plugin owns its own conversation with its users: it decides which
 * slash commands exist, what they mean, and what to reply. What it cannot own is
 * Craft's internals, so the host publishes exactly that and nothing more:
 *
 *   GET  /host                       → the catalogue (name, summary, params)
 *   POST /host/<command> { …params } → run it
 *
 * The catalogue is data, not a plugin-specific switch: a plugin asks what this
 * Craft can do instead of being compiled against a list that changes. That is
 * what lets `/compact` exist without the host knowing any platform ever checks
 * for it.
 *
 * Security is the ingest token plus the same three checks the event endpoint
 * applies; a command is only ever reachable by a program the user installed.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** One callable host capability. */
export interface HostCommand {
  name: string
  /** One line, shown to plugin authors and (indirectly) to users. */
  summary: string
  /**
   * Parameters, as data. A plugin must be able to build a valid call from the
   * catalogue alone — no out-of-band documentation.
   */
  params: Array<{
    name: string
    type: 'string' | 'boolean' | 'number'
    required?: boolean
    description: string
  }>
  run: (args: Record<string, unknown>) => Promise<unknown>
}

export interface HostCommandRegistryOptions {
  commands: HostCommand[]
  /** Bearer token, shared with the event endpoint. */
  token: string
  /** Loopback-only check, injected so tests can exercise both outcomes. */
  isLoopbackHostHeader: (host: string | undefined) => boolean
  readBody: (req: IncomingMessage, limit: number) => Promise<string | 'too_large'>
}

const MAX_BODY_BYTES = 64 * 1024

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Handle a `/host…` request.
 *
 * Returns true when the path belonged to this router, so the ingest server can
 * fall through to its own routing without duplicating the prefix check.
 */
export async function handleHostCommandRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HostCommandRegistryOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/host' && !url.pathname.startsWith('/host/')) return false

  if (!options.isLoopbackHostHeader(req.headers.host)) {
    sendJson(res, 403, { error: 'invalid_host' })
    return true
  }

  const auth = req.headers.authorization ?? ''
  const expected = `Bearer ${options.token}`
  if (auth !== expected) {
    sendJson(res, 401, { error: 'unauthorized' })
    return true
  }

  // The catalogue: ids and shapes only. No session contents, no config values —
  // a plugin needs to know what it may call, not what Craft is holding.
  if (url.pathname === '/host') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return true
    }
    sendJson(res, 200, {
      ok: true,
      commands: options.commands.map((command) => ({
        name: command.name,
        summary: command.summary,
        params: command.params,
      })),
    })
    return true
  }

  const name = decodeURIComponent(url.pathname.slice('/host/'.length))
  const command = options.commands.find((entry) => entry.name === name)
  if (!command) {
    sendJson(res, 404, {
      error: 'unknown_command',
      // Listing what does exist turns a typo into a one-round-trip fix instead
      // of a plugin that silently does nothing.
      available: options.commands.map((entry) => entry.name),
    })
    return true
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' })
    return true
  }

  const contentType = (req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    sendJson(res, 415, { error: 'unsupported_media_type', expected: 'application/json' })
    return true
  }

  const body = await options.readBody(req, MAX_BODY_BYTES)
  if (body === 'too_large') {
    sendJson(res, 413, { error: 'payload_too_large', limitBytes: MAX_BODY_BYTES })
    return true
  }

  let args: Record<string, unknown> = {}
  if (body.trim().length > 0) {
    try {
      const parsed = JSON.parse(body) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      }
    } catch {
      sendJson(res, 400, { error: 'invalid_json' })
      return true
    }
  }

  // Validate against the published shape rather than trusting the caller: the
  // catalogue said which params are required, so a missing one is a contract
  // violation worth naming, not a crash three layers down.
  for (const param of command.params) {
    if (!param.required) continue
    const value = args[param.name]
    if (value === undefined || value === null || value === '') {
      sendJson(res, 400, {
        error: 'missing_param',
        param: param.name,
        hint: `POST /host/${command.name} {"${param.name}": …}`,
      })
      return true
    }
  }

  try {
    const result = await command.run(args)
    sendJson(res, 200, { ok: true, result: result ?? null })
  } catch (error) {
    // A failed command is a normal answer: the plugin decides how to word it to
    // its users. Returning 200 with ok:false would hide real transport errors,
    // so keep the 500 and put the message in the body.
    sendJson(res, 500, {
      ok: false,
      error: 'command_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return true
}
