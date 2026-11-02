import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { rankFolderSearchResults, rankSessionSearchResults } from '../search-ranking'
import { matchText } from '../../../utils/text-matching'
import { highlightMatch } from '../../../utils/session'
import type { FolderConfig } from '@craft-agent/shared/sessions/folders'

describe('matchText', () => {
  it('counts repeated literal occurrences and returns ranges for each one', () => {
    expect(matchText('你好你好', '你好')).toEqual({
      count: 2,
      ranges: [0, 2, 2, 4],
      fuzzyScore: 2,
    })
  })

  it('returns a fuzzy match range when there is no literal substring', () => {
    expect(matchText('My Project', 'M Project')).toEqual({
      count: 1,
      ranges: [0, 1, 3, 10],
      fuzzyScore: 1,
    })
  })

  it('returns null when the text does not match', () => {
    expect(matchText('session-search', 'xyz')).toBeNull()
  })
})

describe('rankFolderSearchResults', () => {
  const folders = [
    { id: 'one', name: 'hello docs', parentId: null, createdAt: 1, updatedAt: 1 },
    { id: 'many', name: 'hello hello notes', parentId: null, createdAt: 1, updatedAt: 1 },
    { id: 'not-match', name: 'goodbye world', parentId: null, createdAt: 1, updatedAt: 1 },
  ] as FolderConfig[]

  it('orders matching folders by match count descending', () => {
    expect(rankFolderSearchResults(folders, 'hello').map(folder => folder.id))
      .toEqual(['many', 'one'])
  })
})

describe('rankSessionSearchResults', () => {
  const sessions = [
    { id: 'body-many', title: 'Unrelated title' },
    { id: 'both', title: 'needle needle' },
    { id: 'title-only', title: 'needle' },
    { id: 'body-one', title: 'Another title' },
  ]
  const contentMatchCounts = new Map([
    ['body-many', 6],
    ['both', 1],
    ['body-one', 1],
  ])

  it('includes title-only matches and sorts by combined title and content match count', () => {
    const ranked = rankSessionSearchResults(sessions, 'needle', contentMatchCounts, session => session.title)
    expect(ranked.map(result => result.item.id)).toEqual(['body-many', 'both', 'title-only', 'body-one'])
    expect(ranked.map(result => result.matchCount)).toEqual([6, 3, 1, 1])
  })

  it('ranks single-character content and title matches', () => {
    const ranked = rankSessionSearchResults(
      [{ id: 'title', title: '你好' }, { id: 'content', title: '没有匹配' }],
      '好',
      new Map([['content', 3]]),
      session => session.title,
    )
    expect(ranked.map(result => result.item.id)).toEqual(['content', 'title'])
    expect(ranked.map(result => result.matchCount)).toEqual([3, 1])
  })

  it('prefers title matches when content counts tie', () => {
    const ranked = rankSessionSearchResults(sessions.slice(1), 'needle', new Map([['both', 1], ['body-one', 1]]), session => session.title)
    expect(ranked.map(result => result.item.id)).toEqual(['both', 'title-only', 'body-one'])
  })
})

describe('highlightMatch', () => {
  it('highlights fuzzy title match characters with a background span', () => {
    const html = renderToStaticMarkup(createElement('div', null, highlightMatch('My Project', 'M Project')))
    expect(html).toContain('bg-yellow-300/30')
    expect(html).toContain('>M</span>')
    expect(html).toContain('>Project</span>')
  })
})
