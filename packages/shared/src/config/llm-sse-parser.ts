export interface SseFrame {
  event?: string
  data: string
  raw: string
}

/** Incremental SSE parser that preserves each complete frame for byte-compatible forwarding. */
export class SseFrameParser {
  private readonly decoder = new TextDecoder()
  private lineBuffer = ''
  private raw = ''
  private event: string | undefined
  private data: string[] = []

  push(chunk: Uint8Array): SseFrame[] {
    this.lineBuffer += this.decoder.decode(chunk, { stream: true })
    return this.drainLines(false)
  }

  finish(): SseFrame[] {
    this.lineBuffer += this.decoder.decode()
    const frames = this.drainLines(true)
    const final = this.dispatchFrame()
    if (final) frames.push(final)
    return frames
  }

  private drainLines(flush: boolean): SseFrame[] {
    const frames: SseFrame[] = []
    let newline = this.lineBuffer.indexOf('\n')
    while (newline >= 0) {
      const lineWithEnding = this.lineBuffer.slice(0, newline + 1)
      this.lineBuffer = this.lineBuffer.slice(newline + 1)
      const line = lineWithEnding.slice(0, -1).replace(/\r$/, '')
      const frame = this.consumeLine(line, lineWithEnding)
      if (frame) frames.push(frame)
      newline = this.lineBuffer.indexOf('\n')
    }
    if (flush && this.lineBuffer.length > 0) {
      const line = this.lineBuffer.replace(/\r$/, '')
      const raw = this.lineBuffer
      this.lineBuffer = ''
      const frame = this.consumeLine(line, raw)
      if (frame) frames.push(frame)
    }
    return frames
  }

  private consumeLine(line: string, rawLine: string): SseFrame | undefined {
    this.raw += rawLine
    if (line === '') return this.dispatchFrame()
    if (line.startsWith(':')) return undefined

    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'event') this.event = value
    else if (field === 'data') this.data.push(value)
    return undefined
  }

  private dispatchFrame(): SseFrame | undefined {
    const hasFrame = this.event !== undefined || this.data.length > 0
    const frame = hasFrame
      ? { ...(this.event !== undefined ? { event: this.event } : {}), data: this.data.join('\n'), raw: this.raw }
      : undefined
    this.raw = ''
    this.event = undefined
    this.data = []
    return frame
  }
}
