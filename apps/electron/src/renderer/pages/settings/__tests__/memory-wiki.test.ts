/**
 * memory-wiki.ts — parse + deterministic layout tests.
 */
import { describe, it, expect } from 'bun:test'
import { parseWiki, layoutWikiGraph, kindLabel, KIND_HUES } from '../memory-wiki'

const SAMPLE = `# agent-ui 域（样例）

## 决策
- **采用** Tailwind v4 作为唯一样式方案（2026-11-19 定案）
- 不再使用内联样式

## 坑
- 注意：关闸要清本地草稿，否则红警失效
- \`radix\` 空值 item 会崩整页

## 术语
- 核心组件：\`radix Select\`

## 偏好
- 回复约定：中文、简洁
`

describe('parseWiki', () => {
  it('extracts title, sections and entities', () => {
    const model = parseWiki(SAMPLE, 'agent-ui')
    expect(model.title).toBe('agent-ui 域（样例）')
    expect(model.sections.map((s) => s.title)).toEqual(['决策', '坑', '术语', '偏好'])
    expect(model.entities.length).toBe(6)
    // every entity belongs to a real section
    for (const e of model.entities) {
      expect(model.sections.some((s) => s.id === e.sectionId)).toBe(true)
    }
  })

  it('classifies kinds with semantic-over-dates priority', () => {
    const model = parseWiki(SAMPLE, 'x')
    expect(model.entities.map((e) => e.kind)).toEqual([
      'decision', // 采用/定案（带日期仍是决策）
      'decision', // 不再
      'pitfall', // 注意：
      'pitfall', // 会崩整页（崩 命中坑类，优先于 term）
      'term', // 核心组件：`radix Select`（无关键词 → 术语类）
      'preference', // 约定
    ])
  })

  it('pulls inline code and link targets into refs', () => {
    const model = parseWiki(SAMPLE, 'x')
    const radix = model.entities.find((e) => e.text.includes('radix'))
    expect(radix?.refs).toContain('radix')
  })

  it('handles bullets before any heading (synthetic 概览 section)', () => {
    const model = parseWiki('- 没有标题的一行\n- 第二行', 'd')
    expect(model.sections.length).toBe(1)
    expect(model.sections[0].title).toBe('概览')
    expect(model.entities.length).toBe(2)
  })

  it('stays empty on prose-only files', () => {
    const model = parseWiki('# 只有段落\n\n纯叙述，没有条目。', 'd')
    expect(model.entities.length).toBe(0)
  })
})

describe('layoutWikiGraph', () => {
  it('is deterministic and in-bounds', () => {
    const model = parseWiki(SAMPLE, 'agent-ui')
    const a = layoutWikiGraph(model, 'agent-ui')
    const b = layoutWikiGraph(model, 'agent-ui')
    expect(a).toEqual(b)
    for (const n of a.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(a.width)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(a.height)
    }
  })

  it('emits one domain node, one node per section, and the expected edges', () => {
    const model = parseWiki(SAMPLE, 'agent-ui')
    const g = layoutWikiGraph(model, 'agent-ui')
    expect(g.nodes.filter((n) => n.role === 'domain').length).toBe(1)
    expect(g.nodes.filter((n) => n.role === 'section').length).toBe(4)
    expect(g.nodes.filter((n) => n.role === 'entity').length).toBe(6)
    expect(g.edges.filter((e) => e.kind === 'section').length).toBe(4)
    expect(g.edges.filter((e) => e.kind === 'entity').length).toBe(6)
  })

  it('collapses overflow entities into a +N chip (max 6 per section)', () => {
    const lines = Array.from({ length: 9 }, (_, i) => `- 条目 ${i}`).join('\n')
    const model = parseWiki(`## 大分区\n${lines}`, 'd')
    const g = layoutWikiGraph(model, 'd')
    expect(g.nodes.filter((n) => n.role === 'entity').length).toBe(6)
    const more = g.nodes.find((n) => n.role === 'more')
    expect(more?.label).toBe('+3')
  })

  it('keeps section hues stable and distinct-ish (47° steps)', () => {
    const model = parseWiki(SAMPLE, 'd')
    const hues = model.sections.map((s) => s.hue)
    expect(hues).toEqual([0, 47, 94, 141])
    expect(hues.every((h) => h >= 0 && h < 360)).toBe(true)
  })
})

describe('kind metadata', () => {
  it('kindLabel resolves all six kinds and kind hues are valid hsl inputs', () => {
    for (const kind of ['decision', 'pitfall', 'preference', 'date', 'term', 'fact'] as const) {
      expect(kindLabel(kind)).toBeTruthy()
      expect(KIND_HUES[kind]).toBeGreaterThanOrEqual(0)
      expect(KIND_HUES[kind]).toBeLessThan(360)
    }
  })
})
