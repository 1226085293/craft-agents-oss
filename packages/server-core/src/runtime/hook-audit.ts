/**
 * Boot-time check that the hooks the host relies on actually exist.
 *
 * Four bugs in this codebase had one shape: a hook was declared optional, called
 * with `?.()`, and never provided. Nothing threw. The feature simply never ran —
 * the supervisor fallback never routed an event, `onSupervisorIdle` was never
 * called, a reminder callback went nowhere. Each was found by a user noticing the
 * behaviour was missing.
 *
 * Cordis rejects that shape structurally: a declared dependency that nobody
 * provides keeps the plugin pending and is reported at boot. The host is not a
 * plugin system, so this is the smallest version of the same idea — name the
 * hooks that matter, check they exist, and say so once, loudly, at startup.
 *
 * Optional here means "this host build may not have it" (headless vs desktop), not
 * "we forgot". If a hook is in this list, its absence is a defect of the wiring,
 * so the check is permissive about *which* host and strict about *consistency*:
 * it reports every missing hook in one line instead of failing the boot.
 */

export interface HookCheck {
  /** Dot path, for the message. */
  name: string
  /** What stops working when it is missing — the consequence, not the name. */
  consequence: string
  present: boolean
}

export interface HookAuditResult {
  ok: boolean
  missing: HookCheck[]
  /** One line for the boot log; empty when everything is present. */
  summary: string
}

/**
 * Declare the hooks a host profile must provide, with the capability each one
 * carries. Kept as data so adding a hook is one entry rather than a code path.
 */
export function auditHooks(checks: HookCheck[]): HookAuditResult {
  const missing = checks.filter((check) => !check.present)
  if (missing.length === 0) return { ok: true, missing: [], summary: '' }
  return {
    ok: false,
    missing,
    summary:
      `宿主缺少 ${missing.length} 个必需钩子：` +
      missing.map((check) => `${check.name}（${check.consequence}）`).join('；'),
  }
}

/**
 * The hooks the desktop host must provide on a session manager.
 *
 * Only what has a user-visible consequence is listed: listing everything would
 * make the check noise and the noise would be ignored. Each entry here is a place
 * where a silent no-op reads as a broken feature.
 */
export const DESKTOP_SESSION_HOOKS = [
  {
    key: 'createEventDispatchTarget',
    consequence: '事件无法投递给会话，订阅者收不到任何事件',
  },
  {
    key: 'routeUnclaimedEvent',
    consequence: '没有订阅者的事件会被丢弃，督导永远收不到',
  },
  {
    key: 'createHostActions',
    consequence: '插件无法调用 stop/compact/send，只能发消息',
  },
  {
    key: 'disposeWorkspace',
    consequence: '删除工作区后，它的看门狗与定时器继续运行',
  },
] as const

/** Build the audit input from a live session manager. */
export function checkSessionHooks(target: Record<string, unknown> | null | undefined): HookAuditResult {
  const checks: HookCheck[] = DESKTOP_SESSION_HOOKS.map((hook) => ({
    name: hook.key,
    consequence: hook.consequence,
    present: typeof target?.[hook.key] === 'function',
  }))
  return auditHooks(checks)
}
