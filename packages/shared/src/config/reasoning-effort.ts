/**
 * Thinking level → `reasoning_effort`, for OpenAI-shaped upstreams.
 *
 * Craft's composer sets a thinking level (`low … max`), the Pi SDK sends it to
 * the gateway in *Anthropic* shape, and the gateway talks to OpenAI-compatible
 * relays. Two things used to happen in between, and together they made the
 * setting a no-op:
 *
 * 1. The SDK's budget-based path collapses `xhigh`/`max` into `high`
 *    (`clampReasoning()` in pi-ai): `high`, `xhigh` and `max` all produce
 *    `budget_tokens: 16384`. The level is already gone at that point.
 * 2. `transcodeRequestToOpenAI()` dropped `thinking` entirely, so nothing at
 *    all reached the upstream — which then ran at its own `defaultEffort`
 *    (`high` for deepseek-v4.1-flash, 2026-10-29).
 *
 * The gateway-hosted endpoint therefore asks the SDK for the *adaptive* path on
 * gateway-routed models, where the level travels as a string
 * (`output_config.effort = "max"`), and this module turns that string — or, for
 * older clients, the budget figure — into what the relay understands.
 *
 * Levels are clamped to what the model accepts, and the ladder comes from the
 * best source available: the user's declaration
 * (`modelOptions.reasoningEfforts`), then the upstream's own `GET /models`
 * catalog (`parseEffortsCatalog`), then the standard OpenAI subset. Because the
 * composer's "最大" must survive on a model whose top level is `high`, the
 * clamp steps *down* to the nearest level that exists instead of dropping the
 * field — and a relay that still refuses the level is answered by trying the
 * next one down (`effortCandidates`), not by failing the turn (2026-10-30).
 */

import type { ThinkingLevel } from '../agent/thinking-levels.ts'

/** Anthropic thinking block, as the SDK sends it. */
export interface AnthropicThinking {
  type?: string
  budget_tokens?: number
}

/**
 * Budget → level, matching pi-ai's `DEFAULT_THINKING_BUDGETS`
 * (`minimal: 1024, low: 2048, medium: 8192, high: 16384`).
 *
 * Only used when the client did not send an explicit `output_config.effort` —
 * i.e. a budget-based client, where `max` is already indistinguishable from
 * `high` and the best we can do is report the level the budget really encodes.
 */
const BUDGET_STEPS: ReadonlyArray<{ level: ThinkingLevel; max: number }> = [
  { level: 'low', max: 4095 },
  { level: 'medium', max: 12287 },
  { level: 'high', max: Number.MAX_SAFE_INTEGER },
]

/** The level a thinking budget encodes. */
export function levelForBudget(budget: number): ThinkingLevel {
  for (const step of BUDGET_STEPS) {
    if (budget <= step.max) return step.level
  }
  return 'high'
}

/**
 * The effort a request asks for, or `undefined` when it asks for none.
 *
 * `output_config.effort` wins: that is the adaptive path, the only one that can
 * still carry `max`. A budget-based `thinking` block is the fallback.
 */
export function requestedEffort(body: {
  thinking?: AnthropicThinking | null
  output_config?: { effort?: unknown } | null
}): string | undefined {
  const effort = body.output_config?.effort
  if (typeof effort === 'string' && effort.trim()) return effort.trim().toLowerCase()
  const thinking = body.thinking
  if (!thinking || typeof thinking !== 'object') return undefined
  const type = String(thinking.type ?? '').toLowerCase()
  if (type === 'disabled' || type === 'off') return 'none'
  if (type === 'adaptive') return undefined
  if (type === 'enabled' && typeof thinking.budget_tokens === 'number' && thinking.budget_tokens > 0) {
    return levelForBudget(thinking.budget_tokens)
  }
  return undefined
}

/** Ordering used to pick a neighbour when the exact level is unsupported. */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The standard OpenAI subset — the levels a relay that publishes nothing is
 * assumed to understand.
 *
 * `xhigh` is deliberately absent: it is a Craft/Pi extension that most
 * OpenAI-shaped relays do not accept, so stepping from `max` to `high` skips a
 * request that would be refused anyway. `max` itself is still tried first — the
 * ladder below it is a fallback, not a cage.
 */
const STANDARD_EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high']

/** Position of `effort` on the ladder, or -1 when it is not a level at all. */
export function effortRank(effort: string | undefined): number {
  if (!effort) return -1
  return EFFORT_ORDER.indexOf(effort.trim().toLowerCase())
}

/**
 * Cap `effort` at `ceiling` — the highest level this route has actually
 * accepted before.
 *
 * `'none'` as a ceiling means "this route rejects every level", so nothing is
 * sent at all; that is the shape every upstream accepts.
 */
export function capEffort(
  effort: string | undefined,
  ceiling: string | undefined,
): string | undefined {
  if (!effort) return undefined
  if (!ceiling) return effort
  if (ceiling.trim().toLowerCase() === 'none') return undefined
  const cap = effortRank(ceiling)
  const rank = effortRank(effort)
  if (cap === -1 || rank === -1) return effort
  return rank <= cap ? effort : EFFORT_ORDER[cap]
}

/**
 * The levels to try for one request, best first, ending in "send nothing".
 *
 * Two cases, because they mean different things:
 *
 * - `supported` is a ladder the model is known to have (the user declared it):
 *   the selection is clamped into it first, so 最大 on a model that tops out at
 *   `high` starts at `high` and never sends a level that cannot work.
 * - `supported` is empty: nothing is known. The requested level is sent as-is —
 *   that is the only way 最大 can ever reach a relay nobody described — and a
 *   refusal walks down one standard level at a time.
 *
 * The last entry is `undefined`: omit the field entirely, the one shape every
 * upstream accepts.
 */
export function effortCandidates(
  effort: string | undefined,
  supported: readonly string[],
  ceiling?: string,
): Array<string | undefined> {
  if (!effort) return [undefined]
  // A route that rejected every level sends no field at all — walking the
  // ladder again would just replay the rejections.
  if (ceiling && ceiling.trim().toLowerCase() === 'none') return [undefined]
  const allowed = supported.map((s) => s.trim().toLowerCase()).filter(Boolean)
  const known = allowed.length > 0
  const first = capEffort(
    known ? clampEffort(effort, allowed) : effort.trim().toLowerCase(),
    ceiling,
  )
  const from = first ? effortRank(first) : effortRank(effort)
  const out: Array<string | undefined> = first ? [first] : []
  for (let i = from - 1; i >= 0; i -= 1) {
    const level = EFFORT_ORDER[i]!
    // `none` is not a level an OpenAI relay accepts as `reasoning_effort`;
    // omitting the field is how reasoning is switched off there.
    if (level === 'none') continue
    // A known ladder bounds the retries; an unknown model gets the standard
    // subset, since guessing below `minimal` buys nothing.
    if (known ? !allowed.includes(level) : !STANDARD_EFFORTS.includes(level)) continue
    out.push(level)
  }
  out.push(undefined)
  return out
}

/**
 * Whether a failed response is the upstream refusing the effort we sent.
 *
 * Only 400/422 can be this, and the body has to name reasoning/thinking/
 * effort — a plain "invalid request" is not something a lower level fixes, and
 * retrying it would cost a request for nothing.
 */
export function isEffortRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false
  return /reasoning[\s_-]?effort|\bthinking\b|\beffort\b|推理|思考/i.test(body)
}

/**
 * Clamp `effort` to one the model declares.
 *
 * Nearest is preferred downward (`max` on a model that tops out at `high` runs
 * at `high`, never at a level it does not have). `undefined` when the model
 * declares nothing to clamp against — the caller then sends nothing.
 */
export function clampEffort(
  effort: string | undefined,
  supported: readonly string[] | undefined,
): string | undefined {
  if (!effort) return undefined
  const allowed = (supported ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (allowed.length === 0) return undefined
  const wanted = effort.trim().toLowerCase()
  if (allowed.includes(wanted)) return wanted
  const wantedIndex = EFFORT_ORDER.indexOf(wanted)
  if (wantedIndex === -1) return undefined
  for (let i = wantedIndex; i >= 0; i -= 1) {
    if (allowed.includes(EFFORT_ORDER[i]!)) return EFFORT_ORDER[i]
  }
  for (let i = wantedIndex + 1; i < EFFORT_ORDER.length; i += 1) {
    if (allowed.includes(EFFORT_ORDER[i]!)) return EFFORT_ORDER[i]
  }
  return undefined
}

/**
 * An Anthropic thinking block that expresses `effort`, for upstreams that only
 * understand the budget shape.
 *
 * Used when an adaptive request is forwarded to an `anthropic-messages` relay:
 * `output_config` is not something a non-Anthropic relay can be expected to
 * parse, but the budget is the shape those relays were already receiving.
 */
export function thinkingForEffort(effort: string | undefined): AnthropicThinking | undefined {
  if (!effort) return undefined
  const level = effort.toLowerCase()
  if (level === 'none' || level === 'off') return { type: 'disabled' }
  const budget =
    level === 'minimal' ? 1024
      : level === 'low' ? 2048
        : level === 'medium' ? 8192
          : level === 'xhigh' || level === 'max' ? 32768
            : 16384
  return { type: 'enabled', budget_tokens: budget }
}

/**
 * Pull each model's `reasoning_efforts` ladder out of a `GET /models`
 * response, keyed by model id.
 *
 * The OpenAI shape is `{ data: [{ id, reasoning_efforts: [...] }] }`, but
 * relays vary: some nest under `models`, some call the field
 * `reasoningEfforts`, and some publish no ladder at all. A model with no
 * usable ladder is simply absent from the result.
 *
 * This is the "automatic downgrade" source the gateway consults when the user
 * has not declared a ladder in `modelOptions.reasoningEfforts`: a relay that
 * silently falls back to its default for an unsupported level (200, no
 * rejection) never trips the step-down path, so the ladder must be known
 * *before* the request goes out.
 */
export function parseEffortsCatalog(raw: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const collect = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return
    const rec = entry as Record<string, unknown>
    const id =
      typeof rec.id === 'string' ? rec.id.trim()
        : typeof rec.model === 'string' ? rec.model.trim()
          : undefined
    if (!id) return
    const efforts = rec.reasoning_efforts ?? rec.reasoningEfforts
    if (!Array.isArray(efforts)) return
    const ladder = efforts
      .map((e) => String(e).trim().toLowerCase())
      .filter(Boolean)
    if (ladder.length) out.set(id, ladder)
  }
  if (Array.isArray(raw)) {
    raw.forEach(collect)
    return out
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>
    const list = Array.isArray(rec.data) ? rec.data
      : Array.isArray(rec.models) ? rec.models
        : Array.isArray(rec.list) ? rec.list
          : undefined
    if (list) list.forEach(collect)
  }
  return out
}
