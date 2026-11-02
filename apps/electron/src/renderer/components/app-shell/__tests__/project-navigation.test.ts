import { describe, expect, it } from 'bun:test'
import { getEnteredProjectDetailScopeId } from '../project-navigation'

const projects = [
  { id: 'project-a', slug: 'project-a' },
  { id: 'project-b', slug: 'project-b' },
]

describe('getEnteredProjectDetailScopeId', () => {
  it('preserves the entered project scope on that project’s detail route', () => {
    expect(getEnteredProjectDetailScopeId('project-a', 'project-a', projects)).toBe('project-a')
  })

  it('does not preserve mode 2 on a different project detail route', () => {
    expect(getEnteredProjectDetailScopeId('project-a', 'project-b', projects)).toBeNull()
  })

  it('does not preserve mode 2 when there is no entered project or project detail route', () => {
    expect(getEnteredProjectDetailScopeId(null, 'project-a', projects)).toBeNull()
    expect(getEnteredProjectDetailScopeId('project-a', null, projects)).toBeNull()
    expect(getEnteredProjectDetailScopeId('missing', 'project-a', projects)).toBeNull()
  })
})
