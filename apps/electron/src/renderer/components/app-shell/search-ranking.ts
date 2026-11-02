import type { FolderConfig } from '@craft-agent/shared/sessions/folders'
import { matchText, type TextMatch } from '@/utils/text-matching'

export function rankFolderSearchResults<T extends Pick<FolderConfig, 'id' | 'name'>>(
  folders: readonly T[],
  query: string,
  compareTies?: (a: T, b: T) => number,
): T[] {
  return folders
    .map((folder, index) => ({ folder, index, match: matchText(folder.name, query) }))
    .filter((entry): entry is typeof entry & { match: TextMatch } => entry.match !== null)
    .sort((a, b) => b.match.count - a.match.count
      || b.match.fuzzyScore - a.match.fuzzyScore
      || compareTies?.(a.folder, b.folder)
      || a.index - b.index)
    .map(entry => entry.folder)
}

export interface RankedSession<T> {
  item: T
  matchCount: number
  contentMatchCount: number
  titleMatch?: TextMatch
}

export function rankSessionSearchResults<T extends { id: string }>(
  sessions: readonly T[],
  query: string,
  contentMatchCounts: ReadonlyMap<string, number>,
  getTitle: (session: T) => string,
): RankedSession<T>[] {
  return sessions
    .map((item, index) => {
      const titleMatch = matchText(getTitle(item), query) ?? undefined
      const contentMatchCount = contentMatchCounts.get(item.id) ?? 0
      return {
        item,
        index,
        matchCount: contentMatchCount + (titleMatch?.count ?? 0),
        contentMatchCount,
        titleMatch,
      }
    })
    .filter(result => result.matchCount > 0)
    .sort((a, b) =>
      b.matchCount - a.matchCount
      || (b.titleMatch?.count ?? 0) - (a.titleMatch?.count ?? 0)
      || b.contentMatchCount - a.contentMatchCount
      || a.index - b.index,
    )
    .map(({ index: _index, ...result }) => result)
}
