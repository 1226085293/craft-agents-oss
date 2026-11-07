import { describe, expect, it } from 'bun:test'

import { buildSectionOwnerPrompt, parseSectionOwner, shouldReassignOwner } from './section-owner.ts'
import type { AgentPromptEntry } from '@craft-agent/shared/agents'

const roster: AgentPromptEntry[] = [
  { id: 'agent-ui', name: 'UI 工程师', gist: '负责界面实现与视觉还原' },
  { id: 'agent-research', name: '研究员', gist: '负责检索与资料整理' },
  { id: 'agent-default', name: '通用', isDefault: true },
]

/**
 * Ownership is a routing decision, and it is made here rather than by the worker.
 *
 * A worker cannot see the roster, so a name it wrote was a guess — and the
 * auto-dispatch that trusts the field would hand a section to a role nobody meant.
 */
describe('section owner chooser', () => {
  it('shows the roster so the choice can be made on more than a name', () => {
    const prompt = buildSectionOwnerPrompt({
      task: { name: '接口改造', instruction: '把接口改完', spec: { scope: '只动 src/api' } },
      outline: { id: '1', title: '前端部分' },
      steps: [{ id: '1.1', title: '改表单' }],
      roster,
    })
    expect(prompt).toContain('agent-ui')
    expect(prompt).toContain('负责界面实现与视觉还原')
    expect(prompt).toContain('只动 src/api')
    expect(prompt).toContain('1.1 改表单')
  })

  it('reads a bare id', () => {
    expect(parseSectionOwner('agent-ui', roster)).toBe('agent-ui')
  })

  it('reads an id wrapped in prose or punctuation', () => {
    expect(parseSectionOwner('应该由 `agent-research` 来做。', roster)).toBe('agent-research')
    expect(parseSectionOwner('负责人：agent-ui', roster)).toBe('agent-ui')
  })

  it('refuses an id that is not in the roster', () => {
    // An unknown id is worse than none: it dispatches an agent that does not
    // exist, and the failure shows up later as a session with the wrong persona.
    expect(parseSectionOwner('agent-frontend', roster)).toBeUndefined()
    expect(parseSectionOwner('', roster)).toBeUndefined()
    expect(parseSectionOwner('不知道', roster)).toBeUndefined()
  })

  it('does not match an id that is merely a prefix of another', () => {
    const overlapping: AgentPromptEntry[] = [
      { id: 'agent-ui', name: 'UI' },
      { id: 'agent-ui-pro', name: 'UI Pro' },
    ]
    expect(parseSectionOwner('agent-ui-pro', overlapping)).toBe('agent-ui-pro')
  })

  it('overrules an owner the planner guessed, keeps one it could have known', () => {
    // A worker writing the plan has no roster, so its guess must not outrank the
    // chooser — otherwise the only participant that could check the name is the
    // one that gets skipped, and the section runs as the workspace default.
    expect(shouldReassignOwner({ agent: 'agent-frntend' }, roster)).toBe(true)
    expect(shouldReassignOwner({ agent: undefined }, roster)).toBe(true)
    // A name that resolves was deliberate: the chooser leaves it alone.
    expect(shouldReassignOwner({ agent: 'agent-ui' }, roster)).toBe(false)
  })
})
