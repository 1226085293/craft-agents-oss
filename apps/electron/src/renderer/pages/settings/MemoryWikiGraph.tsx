/**
 * MemoryWikiGraph — deterministic radial knowledge-graph view of a domain's
 * MEMORY.md. Zero dependencies: inline SVG, CSS-variable-friendly hsl()
 * colors, native <title> tooltips. The layout is pure (memory-wiki.ts), so
 * the same file always renders the same picture.
 */

import * as React from 'react'
import { layoutWikiGraph, ENTITY_KINDS, KIND_HUES, type EntityKind, type WikiModel } from './memory-wiki'

const hueOf = (kind: EntityKind | undefined): number => (kind ? KIND_HUES[kind] : 225)

interface MemoryWikiGraphProps {
  model: WikiModel
  domainSlug: string
  selectedEntityId?: string | null
  onSelectEntity?: (id: string | null) => void
  width?: number
  height?: number
}

export function MemoryWikiGraph({
  model,
  domainSlug,
  selectedEntityId,
  onSelectEntity,
  width = 720,
  height = 380,
}: MemoryWikiGraphProps): React.JSX.Element {
  const layout = React.useMemo(
    () => layoutWikiGraph(model, domainSlug, width, height),
    [model, domainSlug, width, height],
  )
  const [hoverId, setHoverId] = React.useState<string | null>(null)

  const activeId = selectedEntityId ?? hoverId
  const activeEntity = activeId ? layout.nodes.find((n) => n.id === activeId && n.role === 'entity') : null
  const activeSection = activeEntity
    ? layout.edges.find((e) => e.to === activeEntity.id && e.kind === 'entity')?.from
    : null
  // Entity nodes don't carry their section id — derive it from the entity edges.
  const entitySectionOf = React.useMemo(() => {
    const m = new Map<string, string>()
    for (const e of layout.edges) if (e.kind === 'entity') m.set(e.to, e.from)
    return m
  }, [layout])

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mx-auto block w-full max-w-[560px]"
        role="img"
        aria-label={`记忆知识图：${domainSlug}`}
      >
        {/* edges */}
        {layout.edges.map((edge, i) => {
          const from = layout.nodes.find((n) => n.id === edge.from)
          const to = layout.nodes.find((n) => n.id === edge.to)
          if (!from || !to) return null
          const isEntityEdge = edge.kind === 'entity'
          const highlighted = isEntityEdge && activeSection === edge.from && activeEntity?.id === edge.to
          const dimmed = activeEntity != null && !(highlighted || edge.kind === 'section')
          return (
            <line
              key={i}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={
                edge.kind === 'section'
                  ? `hsl(${from.hue ?? 225} 35% 55% / ${dimmed ? 0.1 : 0.4})`
                  : highlighted
                    ? `hsl(${hueOf(activeEntity.kind)} 55% 50% / 0.9)`
                    : `hsl(225 15% 50% / ${dimmed ? 0.08 : isEntityEdge ? 0.25 : 0.2})`
              }
              strokeWidth={highlighted ? 1.6 : edge.kind === 'section' ? 1.4 : 1}
            />
          )
        })}

        {/* nodes */}
        {layout.nodes.map((node) => {
          if (node.role === 'domain') {
            return (
              <g key={node.id}>
                <circle cx={node.x} cy={node.y} r={node.r} className="fill-foreground/[0.08] stroke-foreground/30" strokeWidth={1} />
                <text
                  x={node.x}
                  y={node.y + 4}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={600}
                  className="fill-foreground"
                >
                  {node.label.length > 14 ? `${node.label.slice(0, 14)}…` : node.label}
                </text>
                <title>{node.label}</title>
              </g>
            )
          }
          if (node.role === 'section' || node.role === 'more') {
            const active = activeSection === node.id
            return (
              <g key={node.id} opacity={activeEntity != null && !active && node.role === 'section' ? 0.35 : 1}>
                {node.role === 'section' ? (
                  <>
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={node.r}
                      fill={`hsl(${node.hue} 45% 50% / ${active ? 0.95 : 0.8})`}
                      stroke={`hsl(${node.hue} 50% 35% / 0.5)`}
                    />
                    <text x={node.x} y={node.y + 4} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="white">
                      {node.label.length > 6 ? `${node.label.slice(0, 6)}…` : node.label}
                    </text>
                  </>
                ) : (
                  <text
                    x={node.x}
                    y={node.y}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={600}
                    fill={`hsl(${node.hue} 40% 45% / 0.9)`}
                  >
                    {node.label}
                  </text>
                )}
                <title>{node.role === 'section' ? `分区：${node.label}` : '更多条目（原文查看）'}</title>
              </g>
            )
          }
          // entity
          const isActive = activeEntity?.id === node.id
          const dimmed = activeEntity != null && !isActive && activeSection !== entitySectionOf.get(node.id)
          return (
            <g
              key={node.id}
              opacity={dimmed ? 0.18 : 1}
              className={onSelectEntity ? 'cursor-pointer' : undefined}
              onClick={() => onSelectEntity?.(isActive ? null : node.id ?? null)}
              onMouseEnter={() => setHoverId(node.id ?? null)}
              onMouseLeave={() => setHoverId(null)}
            >
              {isActive ? (
                <circle cx={node.x} cy={node.y} r={node.r + 4} fill={`hsl(${hueOf(node.kind)} 60% 50% / 0.2)`} />
              ) : null}
              <circle
                cx={node.x}
                cy={node.y}
                r={isActive ? node.r + 2 : node.r}
                fill={`hsl(${hueOf(node.kind)} ${node.kind === 'fact' ? 20 : 55}% ${node.kind === 'fact' ? 55 : 48}% / 0.95)`}
              />
              <text
                x={node.x + node.r + 5}
                y={node.y + 3}
                fontSize={9}
                fill={`hsl(${hueOf(node.kind)} 30% 40%)`}
                opacity={dimmed ? 0.4 : 0.9}
                className="select-none"
              >
                {node.label.length > 16 ? `${node.label.slice(0, 16)}…` : node.label}
              </text>
              <title>{node.label}</title>
            </g>
          )
        })}
      </svg>

      {/* legend */}
      <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pb-2">
        {ENTITY_KINDS.map(({ kind, label }) => (
          <span key={kind} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: `hsl(${KIND_HUES[kind]} ${kind === 'fact' ? 20 : 55}% ${kind === 'fact' ? 55 : 48}% / 0.9)`,
              }}
            />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
