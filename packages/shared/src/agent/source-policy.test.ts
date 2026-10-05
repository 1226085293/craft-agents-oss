import { describe, expect, it } from 'bun:test'
import {
  classifySourceToolRisk,
  evaluateSourceToolAccess,
  inferSourceToolPermission,
  parseSourceSlugFromTool,
} from './source-policy.ts'

describe('parseSourceSlugFromTool', () => {
  it('parses MCP proxy tool names', () => {
    expect(parseSourceSlugFromTool('mcp__linear__createIssue')).toEqual({ slug: 'linear', sourceType: 'mcp' })
  })
  it('parses API tool names', () => {
    expect(parseSourceSlugFromTool('api_github')).toEqual({ slug: 'github', sourceType: 'api' })
  })
  it('returns null for non-source tools', () => {
    expect(parseSourceSlugFromTool('Bash')).toBeNull()
    expect(parseSourceSlugFromTool('Read')).toBeNull()
  })
})

describe('inferSourceToolPermission', () => {
  it('infers read for plain GET/read tools', () => {
    expect(inferSourceToolPermission('api_github', { method: 'GET', path: '/repos' })).toBe('read')
  })
  it('infers write for mutations', () => {
    expect(inferSourceToolPermission('api_github', { method: 'POST', path: '/repos' })).toBe('write')
    expect(inferSourceToolPermission('mcp__crm__updateContact', {})).toBe('write')
  })
  it('infers delete/external/payment/sensitive from keywords', () => {
    expect(inferSourceToolPermission('mcp__crm__deleteContact', {})).toBe('delete')
    expect(inferSourceToolPermission('mcp__crm__sendEmail', {})).toBe('external')
    expect(inferSourceToolPermission('mcp__billing__chargeCustomer', {})).toBe('payment')
    expect(inferSourceToolPermission('mcp__hr__accessSalary', {})).toBe('sensitive')
  })
})

describe('classifySourceToolRisk', () => {
  // safe 模式 allow = 明确只读；mutation（safe block）= 写
  const safeAllow = { mutation: false, readOnly: true }
  const safeBlock = { mutation: true, readOnly: false }
  const opt = { plansFolderPath: '/tmp/plans' }

  it('classifies GET API as low (service-side read-only)', () => {
    const risk = classifySourceToolRisk('api_github', { method: 'GET', path: '/repos' }, null, opt)
    expect(risk.risk).toBe('low')
    expect(risk.operation).toBe('read')
  })

  it('classifies mutation as high (never automatic)', () => {
    const risk = classifySourceToolRisk('mcp__crm__updateContact', {}, null, opt)
    expect(risk.risk).toBe('high')
    expect(risk.mutation).toBe(true)
  })

  it('classifies payment keywords as critical', () => {
    const risk = classifySourceToolRisk('mcp__billing__chargeCustomer', {}, null, opt)
    expect(risk.risk).toBe('critical')
  })

  it('does not let manual riskLevel downgrade detected dangerous semantics', () => {
    const risk = classifySourceToolRisk('mcp__crm__deleteContact', {}, { riskLevel: 'low' }, opt)
    expect(risk.risk).toBe('high') // delete → high，服务端最终裁定
  })

  it('honors manual riskLevel when no dangerous semantics detected', () => {
    const risk = classifySourceToolRisk('api_github', { method: 'GET', path: '/repos' }, { riskLevel: 'medium' }, opt)
    expect(risk.risk).toBe('medium')
  })
})

describe('evaluateSourceToolAccess', () => {
  it('blocks when grantedPermissions does not include the operation (hard constraint)', () => {
    const result = evaluateSourceToolAccess('mcp__crm__deleteContact', {}, {
      config: { grantedPermissions: ['read'] },
      opts: { plansFolderPath: '/tmp/plans' },
    })
    expect(result.decision).toBe('block')
  })

  it('blocks on tool-level deny policy', () => {
    const result = evaluateSourceToolAccess('mcp__crm__deleteContact', {}, {
      config: { sourceToolPolicies: { 'mcp__crm__deleteContact': 'deny' } },
      opts: { plansFolderPath: '/tmp/plans' },
    })
    expect(result.decision).toBe('block')
  })

  it('blocks on session deny', () => {
    const result = evaluateSourceToolAccess('mcp__crm__deleteContact', {}, {
      sessionDeny: true,
      opts: { plansFolderPath: '/tmp/plans' },
    })
    expect(result.decision).toBe('block')
  })

  it('allows via tool-level always-allow (auto) for low/medium risk', () => {
    const result = evaluateSourceToolAccess('api_github', { method: 'GET', path: '/repos' }, {
      config: { sourceToolPolicies: { 'api_github': 'auto' } },
      opts: { plansFolderPath: '/tmp/plans' },
    })
    expect(result.decision).toBe('allow')
  })

  it('never skips confirmation for high risk even with always-allow', () => {
    const result = evaluateSourceToolAccess('mcp__crm__deleteContact', {}, {
      config: { sourceToolPolicies: { 'mcp__crm__deleteContact': 'auto' } },
      opts: { plansFolderPath: '/tmp/plans' },
    })
    expect(result.decision).toBe('confirm') // high → 强制确认，auto 不跳过
  })

  it('allows via session allow for non-high risk', () => {
    const result = evaluateSourceToolAccess('api_github', { method: 'GET', path: '/repos' }, {
      sessionAllow: true,
      opts: { plansFolderPath: '/tmp/plans' },
    })
    expect(result.decision).toBe('allow')
  })

  it('confirms by default (medium/mutation) when no policy', () => {
    const result = evaluateSourceToolAccess('mcp__crm__updateContact', {}, {
      opts: { plansFolderPath: '/tmp/plans' },
    })
    expect(result.decision).toBe('confirm')
  })

  it('confirms all calls when sourcePolicy is confirm', () => {
    const result = evaluateSourceToolAccess('mcp__crm__listContacts', {}, {
      config: { sourcePolicy: 'confirm' },
      opts: { plansFolderPath: '/tmp/plans' },
    })
    expect(result.decision).toBe('confirm')
  })

  it('auto-allows clear low-risk read-only (GET API)', () => {
    const result = evaluateSourceToolAccess('api_github', { method: 'GET', path: '/repos' }, {
      opts: { plansFolderPath: '/tmp/plans' },
    })
    expect(result.decision).toBe('allow')
  })
})
