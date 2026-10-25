/**
 * Model request kinds, and which strategy group each one routes through.
 *
 * This is a registry rather than a set of `if (kind === ...)` branches because
 * the routing policy is a product decision that keeps moving: kinds have been
 * regrouped more than once already (auxiliary calls started out on a single
 * global group, then moved to follow the session's own group). Adding a kind
 * here, or changing which group an existing one uses, must not require touching
 * the gateway, the session manager, or the usage writer.
 *
 * `routing` is the whole point: it answers "does this kind inherit the
 * session's strategy, does it need a group of its own, or does it never route
 * at all?" Without that recorded per kind, every caller re-derives it and they
 * drift apart.
 *
 * **Only add an entry here when something emits it.** The log's filter is built
 * from this list, so a kind with no sender would show up as an option that
 * always matches nothing.
 */

/** Every request kind the app can make. Extend by adding a line to `SPECS`. */
export type ModelRequestKind =
  | 'chat'              // the session's own conversation
  | 'call_llm'          // model-invoked sub-query (summarize / classify / extract)
  | 'busy_decision'     // what to do with a message arriving mid-run
  | 'group_decision'    // whether to join a group chat
  | 'title'             // session title generation
  | 'transfer_summary'  // summary carried with an exported session
  | 'verification'      // defense read-back judge
  | 'steer_check'       // does new guidance conflict with a running tool
  | 'memory'            // memory extraction / consolidation / adjudication
  | 'connection_test'   // settings-page key probe; logged, but never routed

/** How a kind picks its strategy group. */
export type KindRouting = 'session' | 'dedicated' | 'none';

export interface KindSpec {
  /** Wire value carried in `X-Craft-Model-Kind` and stored in usage records. */
  readonly kind: ModelRequestKind
  /** Shown in the log's 类型 column. Keep it short — the column is narrow. */
  readonly label: string
  /**
   * `session`  — follows the session's own strategy group. The default and the
   *              right answer for anything that reads session context.
   * `dedicated`— needs a group of its own (`miniStrategy`), for work that has
   *              no session to inherit from.
   * `none`     — recorded in the log but never routed through a group at all.
   *              The settings-page key probe is the only member: it must reach
   *              the upstream directly to test the key, so there is no group to
   *              pick and no request for the gateway to route.
   */
  readonly routing: KindRouting
}

const SPECS: readonly KindSpec[] = [
  { kind: 'chat', label: '对话', routing: 'session' },
  // Emitted from inside the main session's subprocess: one process serves four
  // kinds, so these tag the model object per call
  // (`MODEL_KIND_OVERRIDE_HEADER`) instead of relying on the provider header.
  { kind: 'call_llm', label: 'call_llm', routing: 'session' },
  { kind: 'busy_decision', label: '忙碌决策', routing: 'session' },
  { kind: 'group_decision', label: '群聊决策', routing: 'session' },
  { kind: 'title', label: '标题', routing: 'session' },
  { kind: 'transfer_summary', label: '传输摘要', routing: 'session' },
  { kind: 'verification', label: '校验', routing: 'session' },
  { kind: 'steer_check', label: '转向判断', routing: 'session' },
  // Memory consolidation used to borrow a session's agent; it now has its own
  // backend and emits this kind.
  { kind: 'memory', label: '记忆', routing: 'dedicated' },
  // Not gateway traffic — the probe builds a synthetic connection and calls the
  // upstream directly, because testing the gateway would not test the key. It
  // is still logged (so "when was this key last tried, and did it work?" has an
  // answer) with `routing: 'none'` saying it never touched a group.
  { kind: 'connection_test', label: '连接测试', routing: 'none' },
]

const BY_KIND = new Map<ModelRequestKind, KindSpec>(SPECS.map((s) => [s.kind, s]))

/** Label for the log's 类型 column; falls back to the raw kind. */
export function kindLabel(kind: string | undefined): string {
  if (!kind) return '—'
  return BY_KIND.get(kind as ModelRequestKind)?.label ?? kind
}

/** All kinds, in display order — drives the log's 类型 filter. */
export function allKinds(): readonly KindSpec[] {
  return SPECS
}

/**
 * Which group this kind routes through: the session's, a dedicated one, or
 * none at all.
 *
 * Unknown kinds are treated as `session`: a new kind that has not been
 * classified yet is far more likely to be session-scoped work than global
 * work, and a wrong guess here shows up as "requests missing from the group I
 * expected" rather than as a silent bypass.
 */
export function kindRouting(kind: string | undefined): KindRouting {
  if (!kind) return 'session'
  return BY_KIND.get(kind as ModelRequestKind)?.routing ?? 'session'
}

/**
 * True for the settings-page key probe.
 *
 * Shared rather than re-spelled at each site: the bucket writer and the
 * aggregates must agree on which rows are not traffic, and a second literal
 * `=== 'connection_test'` is how they would drift apart.
 */
export function isProbeKind(kind: string | undefined): boolean {
  return kind === 'connection_test'
}

/** Header the gateway reads to attribute a request. */
export const MODEL_KIND_HEADER = 'x-craft-model-kind'

/**
 * Header carrying the Craft session id to the gateway.
 *
 * The gateway must know which session a request belongs to before it can tell
 * that session "your key/model changed, compact before the next prompt". The
 * client key is shared by every session, so it cannot serve as the identity.
 *
 * Backends set it per process (Pi: provider headers; Claude:
 * `ANTHROPIC_CUSTOM_HEADERS`). The gateway reads it from the inbound request
 * only and never forwards it upstream — upstream headers are built from the
 * provider config, so there is no leak even for a custom client.
 */
export const SESSION_HEADER = 'x-craft-session-id'

/**
 * Per-request override of {@link MODEL_KIND_HEADER}.
 *
 * The plain header is set once per backend (the SDK registers provider headers
 * at registration time), which is right for auxiliary backends — one process,
 * one kind. Inside the main session's subprocess a single process serves four
 * kinds, so those calls tag the model object they are about to use instead.
 *
 * A separate key rather than the same one because the SDK merges provider
 * headers *last*, so a per-call value under the same name would be silently
 * overwritten by the process-wide default.
 */
export const MODEL_KIND_OVERRIDE_HEADER = 'x-craft-model-kind-override'
