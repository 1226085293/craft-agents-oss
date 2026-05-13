import { describe, expect, it } from 'bun:test'
import { focusOrCreateWindowForSecondInstance } from '../second-instance'

describe('second instance window activation', () => {
  it('creates a window for the first workspace when the running instance has no managed windows', () => {
    const createdFor: string[] = []
    const windowManager = {
      getAllWindows: () => [],
      createWindow: ({ workspaceId }: { workspaceId: string }) => {
        createdFor.push(workspaceId)
      },
    }

    focusOrCreateWindowForSecondInstance({
      windowManager,
      getWorkspaces: () => [
        { id: 'ws-1' },
        { id: 'ws-2' },
      ],
    })

    expect(createdFor).toEqual(['ws-1'])
  })
})
