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
    expect(isSettingsWindowMode({ search: '?windowMode=settings&route=settings%2Fllm' })).toBe(true)
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
    expect(buildSettingsWindowDeepLink('llm', 'workspace-1'))
      .toBe('craftagents://workspace/workspace-1/settings/llm')
    expect(buildSettingsWindowDeepLink('settings/llm', 'workspace-1'))
      .toBe('craftagents://workspace/workspace-1/settings/llm')
  })

  it('falls back to app for a subpage that no longer exists', () => {
    // The old 'ai' page was removed. A deep link still pointing at it must
    // land somewhere renderable rather than on a dead route.
    expect(buildSettingsWindowDeepLink('ai', 'workspace-1'))
      .toBe('craftagents://workspace/workspace-1/settings/app')
    expect(buildSettingsWindowDeepLink('settings/ai', 'workspace-1'))
      .toBe('craftagents://workspace/workspace-1/settings/app')
  })

  it('builds session links outside the settings shell', () => {
    expect(buildSettingsWindowDeepLink(undefined, 'workspace-1'))
      .toBe('craftagents://workspace/workspace-1/settings/app')
    expect(buildWorkspaceDeepLink('allSessions/session/session-1', 'workspace-1'))
      .toBe('craftagents://workspace/workspace-1/allSessions/session/session-1')
  })
})
