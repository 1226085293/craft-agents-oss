import { describe, expect, it } from 'bun:test'

import {
  buildSettingsWindowDeepLink,
  buildWorkspaceDeepLink,
  isSettingsWindowMode,
  normalizeSettingsRoute,
  normalizeSettingsSubpage,
  settingsRouteFromLocation,
  settingsSubpageFromRoute,
} from '../settings-window'

describe('settings window route helpers', () => {
  it('recognizes the independent settings window query mode', () => {
    expect(isSettingsWindowMode({ search: '?windowMode=settings&route=settings%2Fai' })).toBe(true)
    expect(isSettingsWindowMode({ search: '?windowMode=main' })).toBe(false)
    expect(isSettingsWindowMode({ search: '' })).toBe(false)
  })

  it('falls back to the App settings page for bare or invalid routes', () => {
    expect(normalizeSettingsSubpage(undefined)).toBe('app')
    expect(normalizeSettingsSubpage('not-a-page')).toBe('app')
    expect(normalizeSettingsRoute('settings')).toBe('settings/app')
    expect(normalizeSettingsRoute('settings/not-a-page')).toBe('settings/app')
    expect(settingsSubpageFromRoute('settings/shortcuts')).toBe('shortcuts')
    expect(settingsSubpageFromRoute(undefined)).toBe('app')
    expect(settingsSubpageFromRoute('settings/not-a-page')).toBe('app')
  })

  it('reads and canonicalizes the initial route from the window URL', () => {
    expect(settingsRouteFromLocation({ search: '?windowMode=settings&route=settings%2Fappearance' }))
      .toBe('settings/appearance')
    expect(settingsRouteFromLocation({ search: '?windowMode=settings' }))
      .toBe('settings/app')
  })

  it('builds workspace-scoped settings and main-window session links', () => {
    expect(buildSettingsWindowDeepLink('ai', 'workspace-1'))
      .toBe('craftagents://workspace/workspace-1/settings/ai')
    expect(buildSettingsWindowDeepLink('settings/ai', 'workspace-1'))
      .toBe('craftagents://workspace/workspace-1/settings/ai')
    expect(buildSettingsWindowDeepLink(undefined, 'workspace-1'))
      .toBe('craftagents://workspace/workspace-1/settings/app')
    expect(buildWorkspaceDeepLink('allSessions/session/session-1', 'workspace-1'))
      .toBe('craftagents://workspace/workspace-1/allSessions/session/session-1')
  })
})
