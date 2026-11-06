import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { attachClientDisconnect } from '../client-disconnect.ts'

function fixtures() {
  const req = Object.assign(new EventEmitter(), { socket: new EventEmitter() })
  const res = new EventEmitter()
  return { req, res }
}

describe('attachClientDisconnect', () => {
  for (const signal of ['response close', 'request aborted', 'socket close'] as const) {
    it(`fires once on ${signal}`, () => {
      const { req, res } = fixtures()
      let calls = 0
      attachClientDisconnect(req, res, () => {
        calls += 1
      })

      if (signal === 'response close') res.emit('close')
      else if (signal === 'request aborted') req.emit('aborted')
      else req.socket.emit('close')
      // A second transport signal must not produce another abort.
      req.emit('aborted')
      res.emit('close')

      expect(calls).toBe(1)
    })
  }

  it('detaches every listener on cleanup', () => {
    const { req, res } = fixtures()
    let calls = 0
    const detach = attachClientDisconnect(req, res, () => {
      calls += 1
    })
    detach()

    res.emit('close')
    req.emit('aborted')
    req.socket.emit('close')

    expect(calls).toBe(0)
    expect(req.listenerCount('aborted')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
    expect(req.socket.listenerCount('close')).toBe(0)
  })
})
