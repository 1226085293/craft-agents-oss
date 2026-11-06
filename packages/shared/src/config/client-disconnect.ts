type Listener = () => void

interface EmitterLike {
  once(event: string, listener: Listener): unknown
  off(event: string, listener: Listener): unknown
}

interface RequestLike extends EmitterLike {
  socket: EmitterLike
}

/**
 * Runs `handler` once when the downstream connection disappears.
 *
 * Three signals are watched because Node and Bun disagree about which fires
 * when a client aborts mid-request: response `close`, request `aborted`, and
 * the underlying socket `close`. The first one wins; cleanup detaches all of
 * them so a later keep-alive close cannot abort an unrelated request.
 */
export function attachClientDisconnect(
  req: RequestLike,
  res: EmitterLike,
  handler: () => void,
): () => void {
  let fired = false
  const listener = (): void => {
    if (fired) return
    fired = true
    handler()
  }
  res.once('close', listener)
  req.once('aborted', listener)
  req.socket.once('close', listener)
  return () => {
    res.off('close', listener)
    req.off('aborted', listener)
    req.socket.off('close', listener)
  }
}
