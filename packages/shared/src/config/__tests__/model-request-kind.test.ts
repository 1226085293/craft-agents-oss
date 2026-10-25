/**
 * The request-kind registry.
 *
 * The routing column is the part that keeps moving — auxiliary calls started on
 * a single global group and later moved to follow the session's own. These pin
 * the rules that make regrouping safe: session-scoped work is the default, only
 * session-less work is `dedicated`, and the key probe is `none` because it must
 * never be handed a group.
 *
 * There is deliberately no "is this kind emitted yet" column: every entry in
 * the registry has a sender by definition, and a kind with no sender would show
 * up in the log's filter as an option that matches nothing.
 */

import { describe, expect, test } from 'bun:test'
import {
  allKinds,
  isProbeKind,
  kindLabel,
  kindRouting,
  MODEL_KIND_HEADER,
  MODEL_KIND_OVERRIDE_HEADER,
} from '../model-request-kind'

describe('kindRouting', () => {
  test('session-scoped work inherits the session group', () => {
    for (const kind of [
      'chat',
      'call_llm',
      'busy_decision',
      'group_decision',
      'title',
      'transfer_summary',
      'verification',
      'steer_check',
    ]) {
      expect(kindRouting(kind)).toBe('session')
    }
  })

  test('only session-less work uses a dedicated group', () => {
    expect(kindRouting('memory')).toBe('dedicated')
  })

  test('the connection probe is logged but never routed', () => {
    // It must reach the upstream directly to test the key, so it has no group.
    // It is still a kind — the log is where "when was this key tried?" lives.
    expect(kindRouting('connection_test')).toBe('none')
    expect(kindLabel('connection_test')).toBe('连接测试')
  })

  test('an unknown kind defaults to session', () => {
    // A kind added to the sender but not yet classified here is far more likely
    // to be session work than global work, and a wrong `dedicated` guess would
    // route it away from the group the user is looking at.
    expect(kindRouting('some_future_kind')).toBe('session')
  })

  test('an absent kind is treated as session', () => {
    expect(kindRouting(undefined)).toBe('session')
    expect(kindRouting('')).toBe('session')
  })
})

describe('kindLabel', () => {
  test('renders a known kind as its short Chinese label', () => {
    expect(kindLabel('chat')).toBe('对话')
    expect(kindLabel('busy_decision')).toBe('忙碌决策')
    expect(kindLabel('memory')).toBe('记忆')
  })

  test('renders an unknown kind verbatim so the row is still readable', () => {
    // The gateway stores `kind` verbatim, so a newer build's row can reach an
    // older app. Labels must never depend on the kind being known here.
    expect(kindLabel('mystery')).toBe('mystery')
  })

  test('renders an absent kind as an em dash', () => {
    expect(kindLabel(undefined)).toBe('—')
    expect(kindLabel('')).toBe('—')
  })

  test('every registered kind labels itself', () => {
    for (const spec of allKinds()) expect(kindLabel(spec.kind)).toBe(spec.label)
  })
})

describe('isProbeKind', () => {
  test('matches only the connection probe', () => {
    // Shared by the bucket writer and the aggregates: a second literal
    // `=== 'connection_test'` is how the two would drift apart.
    expect(isProbeKind('connection_test')).toBe(true)
    for (const spec of allKinds()) {
      if (spec.kind === 'connection_test') continue
      expect(isProbeKind(spec.kind)).toBe(false)
    }
    expect(isProbeKind(undefined)).toBe(false)
  })
})

describe('registry hygiene', () => {
  test('every kind has a non-empty label', () => {
    for (const spec of allKinds()) {
      expect(spec.label.length).toBeGreaterThan(0)
      expect(spec.kind.length).toBeGreaterThan(0)
    }
  })

  test('kinds are unique', () => {
    const ids = allKinds().map((s) => s.kind)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('the header names are lower-case, as HTTP/2 requires', () => {
    expect(MODEL_KIND_HEADER).toBe(MODEL_KIND_HEADER.toLowerCase())
    expect(MODEL_KIND_OVERRIDE_HEADER).toBe(MODEL_KIND_OVERRIDE_HEADER.toLowerCase())
  })

  test('the per-call override is a distinct header', () => {
    // Same name would lose: the SDK merges provider headers last.
    expect(MODEL_KIND_OVERRIDE_HEADER).not.toBe(MODEL_KIND_HEADER)
  })
})
