/**
 * Truth table for `derivePickerMode`. The helper is small but its behavior
 * has been wrong before (issue #727 was a precedence ordering bug) — pinning
 * each row of the matrix here so future renames / reshufflings can't
 * silently regress to the trapped state.
 *
 * 2026-08-22 semantics change: mid-session switching is now engine-supported
 * (Pi SDK applies a new model between turns with full context, and the
 * backend accepts hot connection switches). Therefore:
 * - `switcher` no longer requires an empty session;
 * - `locked-single` only fires when there is genuinely no alternative
 *   (single configured connection AND single-model compat default).
 */

import { describe, test, expect } from 'bun:test'
import { derivePickerMode, type PickerModeInput } from '../picker-mode'

function input(overrides: Partial<PickerModeInput> = {}): PickerModeInput {
  return {
    connectionUnavailable: false,
    connectionDefaultModel: null,
    isEmptySession: false,
    connectionCount: 1,
    ...overrides,
  }
}

describe('derivePickerMode', () => {
  // -------------------------------------------------------------------------
  // Precedence: unavailable wins
  // -------------------------------------------------------------------------

  test('connectionUnavailable beats every other flag', () => {
    expect(
      derivePickerMode(
        input({
          connectionUnavailable: true,
          connectionDefaultModel: 'mistral-7b',
          isEmptySession: true,
          connectionCount: 5,
        }),
      ),
    ).toBe('unavailable')
  })

  // -------------------------------------------------------------------------
  // switcher: any session state, ≥2 connections
  // -------------------------------------------------------------------------

  test('empty session + ≥2 connections + single-model pi_compat default → switcher (#727)', () => {
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: 'mistral-7b',
          isEmptySession: true,
          connectionCount: 2,
        }),
      ),
    ).toBe('switcher')
  })

  test('NON-empty session + ≥2 connections + single-model pi_compat default → switcher (mid-session unlock)', () => {
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: 'mistral-7b',
          isEmptySession: false,
          connectionCount: 5,
        }),
      ),
    ).toBe('switcher')
  })

  test('non-empty session + many connections + multi-model default → switcher', () => {
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: null,
          isEmptySession: false,
          connectionCount: 3,
        }),
      ),
    ).toBe('switcher')
  })

  // -------------------------------------------------------------------------
  // locked-single: only when there is truly nothing else to pick
  // -------------------------------------------------------------------------

  test('single connection + single-model pi_compat default → locked-single regardless of session state', () => {
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: 'mistral-7b',
          isEmptySession: false,
          connectionCount: 1,
        }),
      ),
    ).toBe('locked-single')
  })

  test('empty session + only 1 connection + single-model pi_compat default → locked-single', () => {
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: 'mistral-7b',
          isEmptySession: true,
          connectionCount: 1,
        }),
      ),
    ).toBe('locked-single')
  })

  // -------------------------------------------------------------------------
  // Flat list: the unremarkable "list models for the active connection" case
  // -------------------------------------------------------------------------

  test('single connection + multi-model → flat regardless of session state', () => {
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: null,
          isEmptySession: false,
          connectionCount: 1,
        }),
      ),
    ).toBe('flat')
  })

  test('empty session + only 1 multi-model connection → flat', () => {
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: null,
          isEmptySession: true,
          connectionCount: 1,
        }),
      ),
    ).toBe('flat')
  })

  // -------------------------------------------------------------------------
  // Boundary: connectionCount > 1 vs == 1
  // -------------------------------------------------------------------------

  test('connectionCount=2 triggers switcher even mid-session (lower bound for >1)', () => {
    expect(
      derivePickerMode(input({ connectionDefaultModel: 'm', isEmptySession: false, connectionCount: 2 })),
    ).toBe('switcher')
  })

  test('connectionCount=1 never triggers switcher', () => {
    expect(
      derivePickerMode(input({ connectionDefaultModel: 'm', isEmptySession: true, connectionCount: 1 })),
    ).toBe('locked-single')
  })

  // -------------------------------------------------------------------------
  // connectionCount=0 — defensive: should never panic, falls through to flat
  // -------------------------------------------------------------------------

  test('connectionCount=0 (no connections configured) → flat (defensive fallthrough)', () => {
    expect(
      derivePickerMode(input({ connectionDefaultModel: null, isEmptySession: true, connectionCount: 0 })),
    ).toBe('flat')
  })
})
