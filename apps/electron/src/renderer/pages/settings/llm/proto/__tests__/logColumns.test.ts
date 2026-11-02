import { describe, expect, test } from 'bun:test'

import { COLUMNS, normalizeColumns } from '../logColumns'

describe('LLM gateway log columns', () => {
  test('does not include the unit display column', () => {
    expect((COLUMNS as ReadonlyArray<{ id: string }>).some((column) => column.id === 'unit')).toBe(false)
  })

  test('drops the removed unit column from saved visibility preferences', () => {
    expect(normalizeColumns(['time', 'unit', 'model'])).toEqual(['time', 'model'])
  })

  test('falls back to remaining default columns if only the removed column was visible', () => {
    expect(normalizeColumns(['unit'])).toEqual(COLUMNS.map((column) => column.id))
  })

  test('preserves an intentionally empty visible-column preference', () => {
    expect(normalizeColumns([])).toEqual([])
  })
})
