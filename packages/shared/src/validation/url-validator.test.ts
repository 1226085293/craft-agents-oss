import { describe, expect, it } from 'bun:test'
import { validateMcpUrl } from './url-validator.ts'

describe('validateMcpUrl', () => {
  it('accepts valid Craft MCP URLs', async () => {
    const urls = [
      'https://mcp.craft.do/links/DSdsfdsjkf34235/mcp',
      'https://mcp.craft.do/links/ABC123/mcp',
      'https://mcp.craft.do/links/xY9-abc_123/mcp/',
    ]

    for (const url of urls) {
      const result = await validateMcpUrl(url)
      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
    }
  })

  it('rejects malformed or non-Craft URLs', async () => {
    const urls = [
      '',
      'mcp.craft.do/links/abc/mcp',
      'http://mcp.craft.do/links/abc/mcp',
      'https://evil.com/links/abc/mcp',
      'https://mcp.craft.do.evil.com/links/abc/mcp',
      'https://user:pass@mcp.craft.do/links/abc/mcp',
      'https://mcp.craft.do',
      'https://mcp.craft.do/links//mcp',
      'https://mcp.craft.do/links/abc/other',
      'https://mcp.craft.do/links/abc/mcp?x=1',
      'https://mcp.craft.do/links/abc/mcp#frag',
      'https://mcp.craft.do/links/abc%20def/mcp',
    ]

    for (const url of urls) {
      const result = await validateMcpUrl(url)
      expect(result.valid).toBe(false)
      expect(result.error).toBeTruthy()
    }
  })
})
