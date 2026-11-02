export interface SearchHighlightSplit<T> {
  active: T | null
  passive: T[]
}

export function splitSearchHighlights<T>(ranges: readonly T[], currentIndex: number): SearchHighlightSplit<T> {
  if (currentIndex < 0 || currentIndex >= ranges.length) {
    return { active: null, passive: [...ranges] }
  }

  return {
    active: ranges[currentIndex] ?? null,
    passive: ranges.filter((_, index) => index !== currentIndex),
  }
}
