/**
 * memory-wiki.ts — parse a domain's MEMORY.md into a wiki model (sections +
 * entities) and lay it out as a deterministic radial knowledge graph.
 *
 * The model is intentionally conservative: it reads what the file actually
 * says (headings, bullets, bold terms, dates, code refs) and classifies by
 * keyword heuristics. No LLM, no server round-trip — the graph is a VIEW of
 * the same markdown the 原文 tab renders, so it can never disagree with it.
 */

export type EntityKind = 'decision' | 'pitfall' | 'preference' | 'date' | 'term' | 'fact'

export interface WikiEntity {
  id: string
  /** Short label shown on the graph node (bold term when present, else first words) */
  label: string
  /** Full bullet text (for the detail card / 实体 tab) */
  text: string
  sectionId: string
  kind: EntityKind
  /** Inline code / link targets this entity references (graph edges) */
  refs: string[]
}

export interface WikiSection {
  id: string
  title: string
  /** Stable hue for this section's graph cluster */
  hue: number
  entities: WikiEntity[]
}

export interface WikiModel {
  title: string
  sections: WikiSection[]
  entities: WikiEntity[]
}

const DECISION_RE = /决定|定案|翻案|拍板|采用|选择|定为|改为|不再|弃用|改用|替换/
const PITFALL_RE = /坑|教训|警告|注意|避免|别|失败|错误|bug|翻车|踩|崩了|炸了|崩|炸/i
const PREFERENCE_RE = /偏好|喜欢|习惯|约定|风格|口味/
const DATE_RE = /\d{4}-\d{2}-\d{2}|\d{4}\/\d{1,2}\/\d{1,2}|\d+月\d+日/

/**
 * Kind priority: semantic first (a dated decision is still a decision),
 * then dated records, then code-term entries, then plain facts.
 */
function classify(text: string): EntityKind {
  if (DECISION_RE.test(text)) return 'decision'
  if (PITFALL_RE.test(text)) return 'pitfall'
  if (PREFERENCE_RE.test(text)) return 'preference'
  if (DATE_RE.test(text)) return 'date'
  if (/`[^`]+`/.test(text)) return 'term'
  return 'fact'
}

function extractLabel(text: string): string {
  const bold = text.match(/\*\*(.+?)\*\*/)
  if (bold) return bold[1].slice(0, 18)
  // first code token is usually the subject
  const code = text.match(/`([^`]+)`/)
  if (code) return code[1].slice(0, 18)
  const clean = text.replace(/^[-*•\d.)\s]+/, '').replace(/\*\*/g, '').slice(0, 18)
  return clean || text.slice(0, 12)
}

function extractRefs(text: string): string[] {
  const refs = new Set<string>()
  for (const m of text.matchAll(/`([^`]+)`/g)) refs.add(m[1])
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) refs.add(m[1])
  return [...refs].slice(0, 4)
}

function slugify(title: string, index: number): string {
  const s = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '')
  return s || `section-${index}`
}

/** Parse MEMORY.md-style markdown into sections + entities. */
export function parseWiki(markdown: string, domainSlug: string): WikiModel {
  const sections: WikiSection[] = []
  const entities: WikiEntity[] = []
  let title = domainSlug
  let current: WikiSection | null = null

  const ensureCurrent = (): WikiSection => {
    if (!current) {
      current = {
        id: slugify('概览', sections.length),
        title: '概览',
        hue: (sections.length * 47) % 360,
        entities: [],
      }
      sections.push(current)
    }
    return current
  }

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const h1 = line.match(/^#\s+(.+)$/)
    if (h1) {
      title = h1[1].trim() || title
      continue
    }

    const h2 = line.match(/^##\s+(.+)$/)
    if (h2) {
      current = {
        id: slugify(h2[1].trim(), sections.length),
        title: h2[1].trim(),
        hue: (sections.length * 47) % 360,
        entities: [],
      }
      sections.push(current)
      continue
    }

    const bullet = line.match(/^([-*•]|\d+[.)])\s+(.+)$/)
    if (bullet) {
      const sec = ensureCurrent()
      const body = bullet[2].trim()
      const entity: WikiEntity = {
        id: `${sec.id}-${entities.length}`,
        label: extractLabel(body),
        text: body,
        sectionId: sec.id,
        kind: classify(body),
        refs: extractRefs(body),
      }
      sec.entities.push(entity)
      entities.push(entity)
    }
    // Prose lines are viewable in 原文; only structured bullets become entities.
  }

  return { title, sections, entities }
}

// ---------------------------------------------------------------------------
// Deterministic radial layout
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string
  label: string
  x: number
  y: number
  r: number
  /** 'domain' | 'section' | 'entity' | 'more' */
  role: 'domain' | 'section' | 'entity' | 'more'
  hue?: number
  kind?: EntityKind
  entityId?: string
}

export interface GraphEdge {
  from: string
  to: string
  kind: 'section' | 'entity' | 'ref'
}

export interface GraphLayout {
  width: number
  height: number
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** How many entities a section spreads into its own ring before collapsing to "+N". */
const MAX_ENTITIES_PER_SECTION = 5
const FAN_ANGLE = 44 // degrees between entity nodes within a section fan

export function layoutWikiGraph(model: WikiModel, domainSlug: string, width = 720, height = 380): GraphLayout {
  const cx = width / 2
  const cy = height / 2
  const sectionRadius = height * 0.3
  const entityRadius = height * 0.46

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  nodes.push({ id: 'domain', label: domainSlug, x: cx, y: cy, r: 22, role: 'domain' })

  const n = model.sections.length || 1
  const startAngle = -Math.PI / 2
  model.sections.forEach((section, i) => {
    const angle = n === 1 ? -Math.PI / 2 : startAngle + (i * 2 * Math.PI) / n
    const sx = cx + Math.cos(angle) * sectionRadius
    const sy = cy + Math.sin(angle) * sectionRadius
    const sectionId = `sec:${section.id}`
    nodes.push({ id: sectionId, label: section.title, x: sx, y: sy, r: 13, role: 'section', hue: section.hue })
    edges.push({ from: 'domain', to: sectionId, kind: 'section' })

    const shown = section.entities.slice(0, MAX_ENTITIES_PER_SECTION)
    const overflow = section.entities.length - shown.length
    if (overflow > 0) {
      nodes.push({
        id: `${sectionId}-more`,
        label: `+${overflow}`,
        x: sx + 26,
        y: sy - 14,
        r: 10,
        role: 'more',
        hue: section.hue,
      })
    }

    // Fan entities around the section's angle, alternating sides to avoid
    // overlapping with neighbouring sections' fans.
    shown.forEach((entity, j) => {
      const offset = (j - (shown.length - 1) / 2) * ((FAN_ANGLE * Math.PI) / 180)
      const a = angle + offset
      const ex = cx + Math.cos(a) * entityRadius
      const ey = cy + Math.sin(a) * entityRadius
      nodes.push({
        id: entity.id,
        label: entity.label,
        x: ex,
        y: ey,
        r: 6,
        role: 'entity',
        hue: section.hue,
        kind: entity.kind,
        entityId: entity.id,
      })
      edges.push({ from: sectionId, to: entity.id, kind: 'entity' })
    })
  })

  return { width, height, nodes, edges }
}

/** Legend metadata for the six entity kinds. */
export const ENTITY_KINDS: Array<{ kind: EntityKind; label: string }> = [
  { kind: 'decision', label: '决策' },
  { kind: 'pitfall', label: '坑/警告' },
  { kind: 'preference', label: '偏好' },
  { kind: 'date', label: '时间记录' },
  { kind: 'term', label: '术语' },
  { kind: 'fact', label: '事实' },
]

/**
 * Fixed hue per entity kind — entities are colored by what they ARE
 * (a decision vs a pitfall…), while sections keep their positional hue.
 */
export const KIND_HUES: Record<EntityKind, number> = {
  decision: 265,
  pitfall: 40,
  preference: 170,
  date: 205,
  term: 300,
  fact: 225,
}

export const kindLabel = (kind: EntityKind): string =>
  ENTITY_KINDS.find((k) => k.kind === kind)?.label ?? kind
