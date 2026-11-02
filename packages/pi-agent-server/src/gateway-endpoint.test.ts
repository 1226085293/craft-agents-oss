/**
 * Which endpoints get the adaptive thinking shape.
 *
 * The Craft gateway translates `output_config.effort` into `reasoning_effort`
 * (the only path on which `max` survives). A user's own anthropic-compatible
 * relay was never sent that shape and may reject it, so the detection has to be
 * narrow: loopback host + the gateway's `/s/<strategy>` path.
 */

import { describe, expect, it } from 'bun:test'

import { isCraftGatewayEndpoint } from './gateway-endpoint.ts'

describe('isCraftGatewayEndpoint', () => {
  it('recognises the gateway strategy endpoint', () => {
    expect(isCraftGatewayEndpoint('http://127.0.0.1:49574/s/workbuddycn')).toBe(true)
    expect(isCraftGatewayEndpoint('http://localhost:8787/s/provider/')).toBe(true)
    expect(isCraftGatewayEndpoint('http://[::1]:8787/s/provider')).toBe(true)
  })

  it('rejects a relay that merely lives on loopback', () => {
    // uni-api / wb_proxy style relays: same host, different shape. They must
    // keep receiving a budget block.
    expect(isCraftGatewayEndpoint('http://127.0.0.1:8788/v1')).toBe(false)
    expect(isCraftGatewayEndpoint('http://localhost:8000/v1/chat/completions')).toBe(false)
    expect(isCraftGatewayEndpoint('http://127.0.0.1:8787/v1/messages')).toBe(false)
  })

  it('rejects a remote endpoint even with the same path', () => {
    expect(isCraftGatewayEndpoint('https://api.example.com/s/auto')).toBe(false)
  })

  it('tolerates junk', () => {
    expect(isCraftGatewayEndpoint(undefined)).toBe(false)
    expect(isCraftGatewayEndpoint('not a url')).toBe(false)
    expect(isCraftGatewayEndpoint('')).toBe(false)
  })
})
