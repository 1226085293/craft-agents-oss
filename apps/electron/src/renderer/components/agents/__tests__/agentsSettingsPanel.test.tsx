import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { filterScopeCandidates } from '../AgentsSettingsPanel'

const CANDIDATES = [
  { slug: 'github', name: 'GitHub' },
  { slug: 'qqmail-idle', name: 'QQ 邮箱' },
  { slug: 'local-fs', name: '本地文件夹' },
]

describe('scope candidate search', () => {
  it('returns everything for an empty query', () => {
    expect(filterScopeCandidates(CANDIDATES, '')).toHaveLength(3)
    expect(filterScopeCandidates(CANDIDATES, '   ')).toHaveLength(3)
  })

  it('matches the display name case-insensitively', () => {
    expect(filterScopeCandidates(CANDIDATES, 'github')).toEqual([CANDIDATES[0]])
    expect(filterScopeCandidates(CANDIDATES, 'GitHub')).toEqual([CANDIDATES[0]])
  })

  // The regression: a Chinese display name was unfindable by its slug, which
  // read as "the search box does nothing".
  it('matches the slug of an entry whose name is not ASCII', () => {
    expect(filterScopeCandidates(CANDIDATES, 'qqmail')).toEqual([CANDIDATES[1]])
    expect(filterScopeCandidates(CANDIDATES, 'local')).toEqual([CANDIDATES[2]])
  })

  it('matches Chinese substrings', () => {
    expect(filterScopeCandidates(CANDIDATES, '邮箱')).toEqual([CANDIDATES[1]])
    expect(filterScopeCandidates(CANDIDATES, '文件夹')).toEqual([CANDIDATES[2]])
  })

  it('returns nothing for a miss', () => {
    expect(filterScopeCandidates(CANDIDATES, 'zzz')).toHaveLength(0)
  })

  it('survives candidates with a missing name', () => {
    const ragged = [{ slug: 'only-slug', name: undefined as unknown as string }]
    expect(filterScopeCandidates(ragged, 'only')).toHaveLength(1)
    expect(filterScopeCandidates(ragged, 'x')).toHaveLength(0)
  })
})

describe('agents panel markup', () => {
  // Guards the fix for the native <select> styling: on Windows/Chromium the
  // OS-drawn popup renders options at very low contrast on a dark theme, so
  // settings pages must use the Radix-based SettingsSelectRow instead.
  //
  // Radix keeps one hidden <select aria-hidden> per control for form
  // submission; that one is not user-visible and is expected.
  it('renders no user-visible native select element', async () => {
    const { AgentsSettingsPanel } = await import('../AgentsSettingsPanel')
    const html = renderToStaticMarkup(
      createElement(AgentsSettingsPanel, {
        workspaceId: 'ws-test',
        sources: CANDIDATES,
        skills: CANDIDATES,
        strategies: [{ id: 'grp', name: '主力组' }],
      }),
    )
    const nativeSelects = html.match(/<select(?![^>]*aria-hidden)/g) ?? []
    expect(nativeSelects).toHaveLength(0)
    expect(html.match(/role="combobox"/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    // The icon field is a button with a tooltip, not a text input holding an
    // emoji placeholder (which rendered in colour and looked broken).
    expect(html).not.toContain('placeholder="🙂"')
    expect(html).toContain('title="选择图标"')
  })
})
