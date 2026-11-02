import { describe, expect, it } from 'bun:test'
import { shouldCloseHeaderSearch } from '../HeaderSearchControl'

describe('header search close behavior', () => {
  it('does not close when editing clears the query', () => {
    expect(shouldCloseHeaderSearch('change', '')).toBe(false)
  })

  it('closes on blur only when the input has no characters', () => {
    expect(shouldCloseHeaderSearch('blur', '')).toBe(true)
    expect(shouldCloseHeaderSearch('blur', 'x')).toBe(false)
    expect(shouldCloseHeaderSearch('blur', '  ')).toBe(false)
  })

  it('does not close on change when text remains', () => {
    expect(shouldCloseHeaderSearch('change', 'craft')).toBe(false)
  })
})
