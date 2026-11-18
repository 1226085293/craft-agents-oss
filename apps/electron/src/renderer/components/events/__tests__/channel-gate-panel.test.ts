/**
 * ChannelGatePanel.isGroupChannel — group detection incl. legacy v1 records
 * that predate the channelKind field (H1 zero-backfill).
 */
import { describe, it, expect } from 'bun:test'
import { isGroupChannel } from '../ChannelGatePanel'

describe('isGroupChannel', () => {
  it('explicit channelKind=group wins', () => {
    expect(isGroupChannel({ channelKey: 'message://telegram/123', channelKind: 'group' })).toBe(true)
  })

  it('legacy record (no channelKind): negative telegram id = group', () => {
    expect(isGroupChannel({ channelKey: 'message://telegram/-5095098301' })).toBe(true)
  })

  it('legacy record (no channelKind): positive telegram id = private', () => {
    expect(isGroupChannel({ channelKey: 'message://telegram/8362946740' })).toBe(false)
  })

  it('explicit channelKind beats key shape', () => {
    expect(isGroupChannel({ channelKey: 'message://telegram/-123', channelKind: 'private' })).toBe(false)
  })

  it('other platforms without channelKind stay conservative (non-group)', () => {
    expect(isGroupChannel({ channelKey: 'lark://room/abc' })).toBe(false)
    expect(isGroupChannel({ channelKey: 'qq://group/xyz' })).toBe(false)
  })
})
