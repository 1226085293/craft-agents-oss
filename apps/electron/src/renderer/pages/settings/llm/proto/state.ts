/**
 * Shell state shared between the LLM management shell and its views.
 *
 * Navigation mirrors the prototype's `view` + `detail` pair; dialogs are a
 * single discriminated union so exactly one overlay can exist at a time —
 * same as the prototype's `#overlay-root` innerHTML swap.
 */

import * as React from 'react'

export type ProtoView = 'overview' | 'providers' | 'strategies' | 'logs' | 'settings'

export type DialogState =
  | { kind: 'provider-edit'; providerId: string }
  | { kind: 'provider-create' }
  | { kind: 'provider-delete'; providerId: string }
  | { kind: 'strategy-edit'; strategyId: string | null }
  | { kind: 'strategy-delete'; strategyId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'error-agg' }
  | { kind: 'model-settings'; providerId: string; model: string }
  | { kind: 'add-key'; providerId: string }
  | { kind: 'key-delete'; providerId: string; keyId: string }

export interface ProtoShellApi {
  view: ProtoView
  detail: string | null
  go: (v: ProtoView) => void
  gotoDetail: (id: string) => void
  goBack: () => void
  dialog: DialogState | null
  openDialog: (d: DialogState) => void
  closeDialog: () => void
  toast: (msg: string) => void
}

export const ProtoShellContext = React.createContext<ProtoShellApi | null>(null)

export function useProtoShell(): ProtoShellApi {
  const ctx = React.useContext(ProtoShellContext)
  if (!ctx) throw new Error('useProtoShell outside the LLM management shell')
  return ctx
}

/** Providers sub-tab: list vs. the type/preset management page. */
export type ProvTab = 'list' | 'types'
