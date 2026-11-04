/**
 * Event body, with inline images drawn where the mail put them.
 *
 * A mail that embeds a picture carries two alternates: `text/plain` with a
 * placeholder like `[image0.jpeg]` (written by the sender's client) and a
 * `text/html` alternate whose `<img src="cid:…">` points at the part. We keep
 * the plain text as the body, so the placeholder is what survives — reading
 * "456[image0.jpeg]789" with no picture anywhere is the bug this fixes: the
 * listener now saves that part as an `inline` attachment and this component
 * swaps the placeholder for the image itself.
 */

import * as React from 'react'
import type { EventAttachmentDto } from '@craft-agent/shared/protocol/dto'

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; index: number; name: string }

interface InlineImage {
  index: number
  name: string
}

/**
 * Split the body around `[name]` placeholders belonging to inline images.
 *
 * Matching is by exact placeholder text, so ordinary prose that happens to
 * contain brackets is left alone. When several images share a name the earliest
 * placeholder wins, which keeps the original order intact.
 */
function buildSegments(body: string, inline: InlineImage[]): Segment[] {
  if (inline.length === 0) return [{ kind: 'text', text: body }]

  const segments: Segment[] = []
  let rest = body
  while (rest.length > 0) {
    let hit: { at: number; width: number; index: number; name: string } | null = null
    for (const candidate of inline) {
      const marker = `[${candidate.name}]`
      const at = rest.indexOf(marker)
      if (at < 0) continue
      if (!hit || at < hit.at) {
        hit = { at, width: marker.length, index: candidate.index, name: candidate.name }
      }
    }
    if (!hit) {
      segments.push({ kind: 'text', text: rest })
      break
    }
    if (hit.at > 0) segments.push({ kind: 'text', text: rest.slice(0, hit.at) })
    segments.push({ kind: 'image', index: hit.index, name: hit.name })
    rest = rest.slice(hit.at + hit.width)
  }
  return segments
}

export interface EventBodyProps {
  workspaceId: string
  eventId: string
  body: string
  attachments: EventAttachmentDto[]
}

export function EventBody({ workspaceId, eventId, body, attachments }: EventBodyProps): React.ReactElement {
  const inline = React.useMemo<InlineImage[]>(
    () =>
      attachments
        .map((attachment, index) => ({ attachment, index }))
        .filter((entry) => entry.attachment.inline === true)
        .map((entry) => ({ index: entry.index, name: entry.attachment.name })),
    [attachments],
  )

  const segments = React.useMemo(() => buildSegments(body, inline), [body, inline])

  const [images, setImages] = React.useState<Record<number, string | { error: string }>>({})

  React.useEffect(() => {
    const needed = new Set(segments.filter((s): s is Extract<Segment, { kind: 'image' }> => s.kind === 'image').map((s) => s.index))
    let cancelled = false
    for (const index of needed) {
      if (images[index] !== undefined) continue
      void window.electronAPI
        .readEventAttachment(workspaceId, eventId, index, 'dataUrl')
        .then((result) => {
          if (cancelled) return
          setImages((prev) => ({
            ...prev,
            [index]: result.kind === 'image' ? result.dataUrl : { error: 'not an image' },
          }))
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setImages((prev) => ({
            ...prev,
            [index]: { error: error instanceof Error ? error.message : String(error) },
          }))
        })
    }
    return () => {
      cancelled = true
    }
    // `images` is intentionally excluded: it is the cache this effect fills.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, eventId, segments])

  const shell = 'max-w-prose text-[13.5px] leading-7 whitespace-pre-wrap break-words font-mono bg-muted/30 rounded-md p-4'

  if (inline.length === 0) {
    return <pre className={shell}>{body}</pre>
  }

  return (
    <div className={shell}>
      {segments.map((segment, i) => {
        if (segment.kind === 'text') return <React.Fragment key={i}>{segment.text}</React.Fragment>
        const loaded = images[segment.index]
        if (loaded === undefined) {
          return (
            <span key={i} className="block my-2 text-[12.5px] text-muted-foreground">
              图片加载中…（{segment.name}）
            </span>
          )
        }
        if (typeof loaded !== 'string') {
          return (
            <span key={i} className="block my-2 text-[12.5px] text-muted-foreground">
              [图片无法显示：{segment.name}]
            </span>
          )
        }
        return (
          <img
            key={i}
            src={loaded}
            alt={segment.name}
            className="my-2 block max-h-[420px] max-w-full rounded-md border border-border/60 object-contain bg-background"
          />
        )
      })}
    </div>
  )
}
