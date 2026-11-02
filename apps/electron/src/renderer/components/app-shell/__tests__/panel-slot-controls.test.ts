import { describe, expect, it } from 'bun:test'
import { shouldShowPanelCloseButton } from '../panel-slot-controls'

describe('panel close button visibility', () => {
  it('hides the close button when the panel is the only one', () => {
    expect(shouldShowPanelCloseButton(true)).toBe(false)
  })

  it('shows the close button when other panels are present', () => {
    expect(shouldShowPanelCloseButton(false)).toBe(true)
  })
})
