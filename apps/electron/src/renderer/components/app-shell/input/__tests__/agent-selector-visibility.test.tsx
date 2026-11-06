import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AgentSelector, shouldShowAgentPicker, type AgentOption } from '../AgentSelector'

const AGENTS: AgentOption[] = [
  { id: 'builtin-default', name: '默认' },
  { id: 'agent-terse', name: '简洁' },
]

describe('role picker visibility', () => {
  // The regression this exists for: `50d3fb35` removed the supervisor check from
  // both call sites and left `sessionRole` destructured but unused. Nothing
  // broke, because an unread prop is still a valid prop — the picker simply
  // appeared on a supervisor session, where picking a different profile cannot
  // turn it into a normal session (`updateSessionAgent` changes `agentId`, never
  // `role`).
  it('hides the picker on a supervisor session', () => {
    expect(shouldShowAgentPicker({ agentCount: AGENTS.length, sessionRole: 'supervisor' })).toBe(false)
  })

  it('shows the picker on a worker session', () => {
    expect(shouldShowAgentPicker({ agentCount: AGENTS.length, sessionRole: 'worker' })).toBe(true)
  })

  it('shows the picker when the session carries no role', () => {
    // Ordinary sessions have `role: undefined`; they must keep the picker.
    expect(shouldShowAgentPicker({ agentCount: AGENTS.length, sessionRole: undefined })).toBe(true)
  })

  it('hides the picker when no role profile exists', () => {
    expect(shouldShowAgentPicker({ agentCount: 0, sessionRole: undefined })).toBe(false)
    expect(shouldShowAgentPicker({ agentCount: 0, sessionRole: 'worker' })).toBe(false)
  })
})

describe('AgentSelector rendering', () => {
  it('renders a trigger when shown', () => {
    const html = renderToStaticMarkup(
      createElement(AgentSelector, { agents: AGENTS, value: 'builtin-default', onChange: () => {} }),
    )
    expect(html).toContain('<button')
    expect(html).toContain('默认')
  })

  it('renders nothing at all when told to hide', () => {
    const html = renderToStaticMarkup(
      createElement(AgentSelector, { agents: AGENTS, value: 'builtin-default', onChange: () => {}, hidden: true }),
    )
    expect(html).toBe('')
  })

  // The two halves together: the rule says "hide", and hiding really produces no
  // markup. Asserting only the boolean would let a render path that ignores it
  // pass unnoticed.
  it('produces no markup for a supervisor session end to end', () => {
    const show = shouldShowAgentPicker({ agentCount: AGENTS.length, sessionRole: 'supervisor' })
    const html = renderToStaticMarkup(
      createElement(AgentSelector, { agents: AGENTS, value: 'builtin-default', onChange: () => {}, hidden: !show }),
    )
    expect(html).toBe('')
  })
})
