/**
 * Tests for activity grouping and helper utilities in turn-utils.ts
 *
 * These tests cover:
 * - groupActivitiesByParent() - Task subagent grouping
 * - extractTodosFromActivities() - TodoWrite parsing (internal, tested via exports)
 * - computeLastChildSet() - Tree view last-child detection
 * - extractTaskOutputData() - TaskOutput JSON parsing (internal, tested indirectly)
 */

import { describe, it, expect } from 'bun:test'
import {
  groupActivitiesByParent,
  computeLastChildSet,
  isActivityGroup,
  groupMessagesByTurn,
  type ActivityGroup,
  type AssistantTurn,
} from '../turn-utils'
import type { ActivityItem } from '../TurnCard'

// ============================================================================
// Test Helpers
// ============================================================================

let activityIdCounter = 0

function resetCounters() {
  activityIdCounter = 0
}

/**
 * Create a basic activity item for testing
 */
function createActivity(
  overrides: Partial<ActivityItem> = {}
): ActivityItem {
  const id = `activity-${++activityIdCounter}`
  return {
    id,
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolUseId: `tu-${activityIdCounter}`,
    timestamp: Date.now() + activityIdCounter * 100,
    depth: 0,
    ...overrides,
  }
}

/**
 * Create a Task activity (parent tool that groups children)
 */
function createTaskActivity(
  description: string,
  overrides: Partial<ActivityItem> = {}
): ActivityItem {
  return createActivity({
    toolName: 'Task',
    toolInput: { description, subagent_type: 'Explore' },
    ...overrides,
  })
}

/**
 * Create a child activity with a parent reference
 */
function createChildActivity(
  parentToolUseId: string,
  overrides: Partial<ActivityItem> = {}
): ActivityItem {
  return createActivity({
    parentId: parentToolUseId,
    depth: 1,
    ...overrides,
  })
}

/**
 * Create a TaskOutput activity (provides duration/token data for parent Task)
 */
function createTaskOutputActivity(
  taskId: string,
  data: { durationMs?: number; inputTokens?: number; outputTokens?: number },
  overrides: Partial<ActivityItem> = {}
): ActivityItem {
  const content = JSON.stringify({
    result: 'Task completed',
    duration_ms: data.durationMs,
    usage: {
      input_tokens: data.inputTokens,
      output_tokens: data.outputTokens,
    },
  })
  return createActivity({
    toolName: 'TaskOutput',
    toolInput: { task_id: taskId },
    content,
    ...overrides,
  })
}

/**
 * Create a TodoWrite activity with todo items
 */
function createTodoWriteActivity(
  todos: Array<{ content: string; status: string; activeForm?: string }>,
  overrides: Partial<ActivityItem> = {}
): ActivityItem {
  return createActivity({
    toolName: 'TodoWrite',
    toolInput: { todos },
    content: 'Todo list updated successfully',
    status: 'completed',
    ...overrides,
  })
}

// ============================================================================
// groupActivitiesByParent Tests
// ============================================================================

describe('groupActivitiesByParent', () => {
  describe('empty and flat cases', () => {
    it('returns empty array for empty input', () => {
      resetCounters()
      const result = groupActivitiesByParent([])
      expect(result).toEqual([])
    })

    it('returns flat list when no Task tools present', () => {
      resetCounters()
      const activities = [
        createActivity({ toolName: 'Read' }),
        createActivity({ toolName: 'Grep' }),
        createActivity({ toolName: 'Write' }),
      ]

      const result = groupActivitiesByParent(activities)

      // Should return same activities (not grouped)
      expect(result.length).toBe(3)
      expect(result.every(item => !isActivityGroup(item))).toBe(true)
    })
  })

  describe('single Task with children', () => {
    it('groups child activities under Task parent', () => {
      resetCounters()
      const taskActivity = createTaskActivity('Search codebase')
      const child1 = createChildActivity(taskActivity.toolUseId!, { toolName: 'Grep' })
      const child2 = createChildActivity(taskActivity.toolUseId!, { toolName: 'Read' })

      const activities = [taskActivity, child1, child2]
      const result = groupActivitiesByParent(activities)

      // Should have 1 group
      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)

      const group = result[0] as ActivityGroup
      expect(group.parent.id).toBe(taskActivity.id)
      expect(group.children.length).toBe(2)
      expect(group.children[0]!.id).toBe(child1.id)
      expect(group.children[1]!.id).toBe(child2.id)
    })

    it('maintains chronological order of children within group', () => {
      resetCounters()
      const taskActivity = createTaskActivity('Analyze code')

      // Create children with explicit timestamps out of order
      const child1 = createChildActivity(taskActivity.toolUseId!, {
        toolName: 'Read',
        timestamp: 3000,
      })
      const child2 = createChildActivity(taskActivity.toolUseId!, {
        toolName: 'Grep',
        timestamp: 1000,
      })
      const child3 = createChildActivity(taskActivity.toolUseId!, {
        toolName: 'Glob',
        timestamp: 2000,
      })

      // Input in arbitrary order
      const activities = [taskActivity, child1, child2, child3]
      const result = groupActivitiesByParent(activities)

      const group = result[0] as ActivityGroup
      // Children should be sorted by timestamp
      expect(group.children[0]!.toolName).toBe('Grep')   // timestamp 1000
      expect(group.children[1]!.toolName).toBe('Glob')   // timestamp 2000
      expect(group.children[2]!.toolName).toBe('Read')   // timestamp 3000
    })
  })

  // Regression guard: Claude Agent SDK v0.2.72 renamed the subagent launcher
  // from 'Task' to 'Agent'. Both names must group identically. If this test
  // fails, a callsite has narrowed back to `=== 'Task'` instead of using
  // `isParentTaskTool` — fix the callsite, don't loosen this test.
  describe('SDK Agent tool name (post v0.2.72 rename)', () => {
    it('groups children under an Agent parent identically to a Task parent', () => {
      resetCounters()
      const agentActivity = createActivity({
        toolName: 'Agent',
        toolInput: { description: 'Search codebase', subagent_type: 'Explore' },
      })
      const child1 = createChildActivity(agentActivity.toolUseId!, { toolName: 'Grep' })
      const child2 = createChildActivity(agentActivity.toolUseId!, { toolName: 'Read' })

      const result = groupActivitiesByParent([agentActivity, child1, child2])

      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)

      const group = result[0] as ActivityGroup
      expect(group.parent.toolName).toBe('Agent')
      expect(group.children.length).toBe(2)
      expect(group.children[0]!.id).toBe(child1.id)
      expect(group.children[1]!.id).toBe(child2.id)
    })
  })

  describe('multiple Tasks with children', () => {
    it('groups each Task with its own children', () => {
      resetCounters()
      const task1 = createTaskActivity('First task')
      const task2 = createTaskActivity('Second task')

      const child1a = createChildActivity(task1.toolUseId!, { toolName: 'Read' })
      const child1b = createChildActivity(task1.toolUseId!, { toolName: 'Grep' })
      const child2a = createChildActivity(task2.toolUseId!, { toolName: 'Write' })

      const activities = [task1, child1a, child1b, task2, child2a]
      const result = groupActivitiesByParent(activities)

      expect(result.length).toBe(2)

      const group1 = result[0] as ActivityGroup
      expect(group1.parent.id).toBe(task1.id)
      expect(group1.children.length).toBe(2)

      const group2 = result[1] as ActivityGroup
      expect(group2.parent.id).toBe(task2.id)
      expect(group2.children.length).toBe(1)
    })
  })

  describe('mixed orphans and Task groups', () => {
    it('preserves orphan activities alongside Task groups in chronological order', () => {
      resetCounters()

      // Create activities with explicit timestamps
      const orphan1 = createActivity({ toolName: 'Read', timestamp: 1000 })
      const task = createTaskActivity('Search', { timestamp: 2000 })
      const child = createChildActivity(task.toolUseId!, { toolName: 'Grep', timestamp: 2500 })
      const orphan2 = createActivity({ toolName: 'Write', timestamp: 3000 })

      const activities = [orphan1, task, child, orphan2]
      const result = groupActivitiesByParent(activities)

      expect(result.length).toBe(3)

      // First item: orphan Read
      expect(isActivityGroup(result[0]!)).toBe(false)
      expect((result[0] as ActivityItem).toolName).toBe('Read')

      // Second item: Task group
      expect(isActivityGroup(result[1]!)).toBe(true)
      expect((result[1] as ActivityGroup).parent.toolName).toBe('Task')

      // Third item: orphan Write
      expect(isActivityGroup(result[2]!)).toBe(false)
      expect((result[2] as ActivityItem).toolName).toBe('Write')
    })
  })

  describe('TaskOutput data attachment', () => {
    it('attaches TaskOutput data to parent Task group via agentId chain', () => {
      resetCounters()

      // Task that ran in background returns agentId in its result
      const task = createTaskActivity('Background task', {
        content: 'Task completed successfully\n\nagentId: abc123',
        status: 'completed',
      })

      // TaskOutput references the agentId
      const taskOutput = createTaskOutputActivity('abc123', {
        durationMs: 5000,
        inputTokens: 1000,
        outputTokens: 500,
      })

      const activities = [task, taskOutput]
      const result = groupActivitiesByParent(activities)

      // TaskOutput should be hidden, only Task group visible
      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)

      const group = result[0] as ActivityGroup
      expect(group.taskOutputData).toBeDefined()
      expect(group.taskOutputData!.durationMs).toBe(5000)
      expect(group.taskOutputData!.inputTokens).toBe(1000)
      expect(group.taskOutputData!.outputTokens).toBe(500)
    })

    it('handles Task without TaskOutput data gracefully', () => {
      resetCounters()

      const task = createTaskActivity('Simple task', { status: 'completed' })
      const child = createChildActivity(task.toolUseId!, { toolName: 'Read' })

      const activities = [task, child]
      const result = groupActivitiesByParent(activities)

      const group = result[0] as ActivityGroup
      expect(group.taskOutputData).toBeUndefined()
    })

    it('hides TaskOutput activities from result', () => {
      resetCounters()

      const task = createTaskActivity('Task with output', {
        content: 'Done\n\nagentId: xyz789',
        status: 'completed',
      })
      const taskOutput = createTaskOutputActivity('xyz789', { durationMs: 1000 })
      const orphan = createActivity({ toolName: 'Read' })

      const activities = [orphan, task, taskOutput]
      const result = groupActivitiesByParent(activities)

      // TaskOutput should not appear in result
      expect(result.length).toBe(2)
      expect(result.some(item =>
        !isActivityGroup(item) && (item as ActivityItem).toolName === 'TaskOutput'
      )).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('handles Task with no children (empty group)', () => {
      resetCounters()

      const task = createTaskActivity('Empty task')
      const result = groupActivitiesByParent([task])

      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)
      expect((result[0] as ActivityGroup).children.length).toBe(0)
    })

    it('shows children with missing parents as orphan activities at root level', () => {
      resetCounters()

      // Child references non-existent parent (parent Task doesn't exist)
      const orphanChild = createChildActivity('non-existent-parent', { toolName: 'Read' })
      const result = groupActivitiesByParent([orphanChild])

      // Orphaned children (with parentId pointing to non-existent Task) should
      // appear as standalone activities at root level, not be silently dropped.
      // This provides better visibility into edge cases where parent arrives late
      // or doesn't exist.
      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(false)
      expect((result[0] as ActivityItem).toolName).toBe('Read')
    })

    it('handles malformed TaskOutput JSON gracefully', () => {
      resetCounters()

      const task = createTaskActivity('Task', {
        content: 'Done\n\nagentId: bad123',
        status: 'completed',
      })

      // TaskOutput with invalid JSON content
      const badTaskOutput = createActivity({
        toolName: 'TaskOutput',
        toolInput: { task_id: 'bad123' },
        content: 'not valid json',
        status: 'completed',
      })

      const activities = [task, badTaskOutput]
      const result = groupActivitiesByParent(activities)

      // Should still work, just without taskOutputData
      expect(result.length).toBe(1)
      const group = result[0] as ActivityGroup
      expect(group.taskOutputData).toBeUndefined()
    })
  })

  describe('stateless invariants (post-refactor)', () => {
    it('out-of-order stored messages: children before parent still group correctly', () => {
      resetCounters()

      // Simulate a restored session where children were persisted before
      // their parent Task (e.g., from parallel event processing).
      // The grouping must work regardless of insertion order.
      const task = createTaskActivity('Search code')
      const child1 = createChildActivity(task.toolUseId!, {
        toolName: 'Grep',
        timestamp: 1500,
      })
      const child2 = createChildActivity(task.toolUseId!, {
        toolName: 'Read',
        timestamp: 2000,
      })

      // Children appear BEFORE parent in the array
      const activities = [child1, child2, task]
      const result = groupActivitiesByParent(activities)

      // Should still produce a single group with both children
      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)

      const group = result[0] as ActivityGroup
      expect(group.parent.id).toBe(task.id)
      expect(group.children.length).toBe(2)
    })

    it('restored session with nested Task hierarchy produces correct groups', () => {
      resetCounters()

      // Outer Task spawns an inner Task (nested subagent pattern).
      // After session restore, all activities arrive as a flat list.
      const outerTask = createTaskActivity('Explore codebase', { timestamp: 1000 })
      const innerTask = createChildActivity(outerTask.toolUseId!, {
        toolName: 'Task',
        toolInput: { description: 'Deep search', subagent_type: 'Explore' },
        timestamp: 1500,
      })
      const innerChild = createActivity({
        toolName: 'Grep',
        parentId: innerTask.toolUseId,
        depth: 2,
        timestamp: 2000,
      })
      const outerChild = createChildActivity(outerTask.toolUseId!, {
        toolName: 'Read',
        timestamp: 3000,
      })

      const activities = [outerTask, innerTask, innerChild, outerChild]
      const result = groupActivitiesByParent(activities)

      // Outer Task should be grouped with innerTask + outerChild as its children.
      // innerChild belongs to innerTask (depth 2), but groupActivitiesByParent
      // only groups by direct parentId, so innerChild is a child of innerTask.
      expect(result.length).toBe(1)
      expect(isActivityGroup(result[0]!)).toBe(true)

      const outerGroup = result[0] as ActivityGroup
      expect(outerGroup.parent.id).toBe(outerTask.id)
      // outerTask's direct children: innerTask and outerChild
      // innerChild has parentId = innerTask.toolUseId, not outerTask.toolUseId
      expect(outerGroup.children.length).toBe(2)
    })

    it('mixed top-level and nested tools group into correct turns', () => {
      resetCounters()

      // Realistic scenario: top-level Read, then a Task with children,
      // then another top-level Write. Verifies clean separation.
      const topRead = createActivity({
        toolName: 'Read',
        timestamp: 1000,
      })
      const task = createTaskActivity('Analyze', { timestamp: 2000 })
      const taskChild1 = createChildActivity(task.toolUseId!, {
        toolName: 'Grep',
        timestamp: 2500,
      })
      const taskChild2 = createChildActivity(task.toolUseId!, {
        toolName: 'Read',
        timestamp: 3000,
      })
      const topWrite = createActivity({
        toolName: 'Write',
        timestamp: 4000,
      })

      const activities = [topRead, task, taskChild1, taskChild2, topWrite]
      const result = groupActivitiesByParent(activities)

      // 3 items: topRead (standalone), Task group, topWrite (standalone)
      expect(result.length).toBe(3)

      expect(isActivityGroup(result[0]!)).toBe(false)
      expect((result[0] as ActivityItem).toolName).toBe('Read')

      expect(isActivityGroup(result[1]!)).toBe(true)
      const group = result[1] as ActivityGroup
      expect(group.parent.toolName).toBe('Task')
      expect(group.children.length).toBe(2)
      expect(group.children[0]!.toolName).toBe('Grep')
      expect(group.children[1]!.toolName).toBe('Read')

      expect(isActivityGroup(result[2]!)).toBe(false)
      expect((result[2] as ActivityItem).toolName).toBe('Write')
    })
  })
})

// ============================================================================
// computeLastChildSet Tests
// ============================================================================

describe('computeLastChildSet', () => {
  it('returns empty set for empty input', () => {
    resetCounters()
    const result = computeLastChildSet([])
    expect(result.size).toBe(0)
  })

  it('returns empty set when no activities have parents (all depth 0)', () => {
    resetCounters()
    const activities = [
      createActivity({ depth: 0 }),
      createActivity({ depth: 0 }),
      createActivity({ depth: 0 }),
    ]

    const result = computeLastChildSet(activities)
    expect(result.size).toBe(0)
  })

  it('identifies last child for single parent', () => {
    resetCounters()
    const parent = createActivity({ toolName: 'Task' })
    const child1 = createChildActivity(parent.toolUseId!, { toolName: 'Read' })
    const child2 = createChildActivity(parent.toolUseId!, { toolName: 'Grep' })
    const child3 = createChildActivity(parent.toolUseId!, { toolName: 'Write' })

    const activities = [parent, child1, child2, child3]
    const result = computeLastChildSet(activities)

    // Only child3 should be in the set (last child of parent)
    expect(result.size).toBe(1)
    expect(result.has(child3.id)).toBe(true)
    expect(result.has(child1.id)).toBe(false)
    expect(result.has(child2.id)).toBe(false)
  })

  it('identifies last child for multiple parents', () => {
    resetCounters()
    const parent1 = createActivity({ toolName: 'Task' })
    const parent2 = createActivity({ toolName: 'Task' })

    const child1a = createChildActivity(parent1.toolUseId!, { toolName: 'Read' })
    const child1b = createChildActivity(parent1.toolUseId!, { toolName: 'Grep' })
    const child2a = createChildActivity(parent2.toolUseId!, { toolName: 'Write' })

    const activities = [parent1, child1a, child1b, parent2, child2a]
    const result = computeLastChildSet(activities)

    // child1b is last child of parent1, child2a is last child of parent2
    expect(result.size).toBe(2)
    expect(result.has(child1b.id)).toBe(true)
    expect(result.has(child2a.id)).toBe(true)
    expect(result.has(child1a.id)).toBe(false)
  })

  it('handles nested parent-child relationships (depth > 1)', () => {
    resetCounters()
    const grandparent = createActivity({ toolName: 'Task', depth: 0 })
    const parent = createChildActivity(grandparent.toolUseId!, {
      toolName: 'Task',
      depth: 1,
    })
    const child1 = createActivity({
      toolName: 'Read',
      parentId: parent.toolUseId,
      depth: 2,
    })
    const child2 = createActivity({
      toolName: 'Grep',
      parentId: parent.toolUseId,
      depth: 2,
    })

    const activities = [grandparent, parent, child1, child2]
    const result = computeLastChildSet(activities)

    // parent is last child of grandparent, child2 is last child of parent
    expect(result.size).toBe(2)
    expect(result.has(parent.id)).toBe(true)
    expect(result.has(child2.id)).toBe(true)
  })

  it('handles single child (is both first and last)', () => {
    resetCounters()
    const parent = createActivity({ toolName: 'Task' })
    const onlyChild = createChildActivity(parent.toolUseId!, { toolName: 'Read' })

    const activities = [parent, onlyChild]
    const result = computeLastChildSet(activities)

    expect(result.size).toBe(1)
    expect(result.has(onlyChild.id)).toBe(true)
  })
})

// ============================================================================
// isActivityGroup Type Guard Tests
// ============================================================================

describe('isActivityGroup', () => {
  it('returns true for ActivityGroup objects', () => {
    resetCounters()
    const group: ActivityGroup = {
      type: 'group',
      parent: createActivity({ toolName: 'Task' }),
      children: [],
    }

    expect(isActivityGroup(group)).toBe(true)
  })

  it('returns false for ActivityItem objects', () => {
    resetCounters()
    const activity = createActivity({ toolName: 'Read' })

    expect(isActivityGroup(activity)).toBe(false)
  })

  it('returns false for activity with type property that is not "group"', () => {
    resetCounters()
    const activity = createActivity({ type: 'tool' })

    expect(isActivityGroup(activity)).toBe(false)
  })
})

// ============================================================================
// extractTodosFromActivities Tests (tested via groupMessagesByTurn integration)
// Note: This function is internal but we can test its behavior indirectly
// by checking that turns have correct todos extracted
// ============================================================================

describe('TodoWrite extraction', () => {
  // These tests verify the todo extraction behavior by creating activities
  // and checking groupActivitiesByParent doesn't break with TodoWrite activities

  it('includes TodoWrite activities in flat list (not grouped)', () => {
    resetCounters()
    const todoActivity = createTodoWriteActivity([
      { content: 'First task', status: 'completed' },
      { content: 'Second task', status: 'in_progress', activeForm: 'Working on second task' },
    ])

    const result = groupActivitiesByParent([todoActivity])

    expect(result.length).toBe(1)
    expect(isActivityGroup(result[0]!)).toBe(false)
    expect((result[0] as ActivityItem).toolName).toBe('TodoWrite')
  })

  it('handles TodoWrite as child of Task', () => {
    resetCounters()
    const task = createTaskActivity('Plan implementation')
    const todoChild = createTodoWriteActivity(
      [{ content: 'Step 1', status: 'pending' }],
      { parentId: task.toolUseId, depth: 1 }
    )

    const activities = [task, todoChild]
    const result = groupActivitiesByParent(activities)

    expect(result.length).toBe(1)
    const group = result[0] as ActivityGroup
    expect(group.children.length).toBe(1)
    expect(group.children[0]!.toolName).toBe('TodoWrite')
  })
})

// ============================================================================
// Persisted retry-ladder row grouping (2026-10-08)
// ============================================================================

describe('persisted retry-ladder row (statusType retrying)', () => {
  it('maps a retrying row to a running status activity carrying the retry payload', () => {
    const turns = groupMessagesByTurn([
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
      {
        id: 'retry-row',
        role: 'status',
        statusType: 'retrying',
        content: '',
        timestamp: 50,
        retry: { status: 'retrying', attempt: 2, nextRetryAt: 10_050, startedAt: 50 },
      },
    ])

    const turn = turns.find(t => t.type === 'assistant') as AssistantTurn | undefined
    expect(turn).toBeDefined()
    const row = turn!.activities.find(a => a.id === 'retry-row')
    expect(row).toMatchObject({
      type: 'status',
      status: 'running',
      statusType: 'retrying',
      retry: { status: 'retrying', attempt: 2, nextRetryAt: 10_050, startedAt: 50 },
    })
  })

  it('derives completed/error activity status from a settled payload', () => {
    const turns = groupMessagesByTurn([
      {
        id: 'recovered-row',
        role: 'status',
        statusType: 'retrying',
        content: '',
        timestamp: 10,
        retry: { status: 'recovered', attempt: 3, startedAt: 1, elapsedMs: 9000 },
      },
      {
        id: 'failed-row',
        role: 'status',
        statusType: 'retrying',
        content: '',
        timestamp: 20,
        retry: { status: 'failed', attempt: 4, startedAt: 2, elapsedMs: 8000 },
      },
    ])

    const turn = turns.find(t => t.type === 'assistant') as AssistantTurn | undefined
    const recovered = turn!.activities.find(a => a.id === 'recovered-row')!
    const failed = turn!.activities.find(a => a.id === 'failed-row')!
    expect(recovered.status).toBe('completed')
    expect(failed.status).toBe('error')
  })

  it('keeps the retry row chronologically before the recovered run messages', () => {
    const turns = groupMessagesByTurn([
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'tool-1', role: 'tool', toolName: 'Read', toolUseId: 'tu-1', toolStatus: 'completed', toolResult: 'ok', timestamp: 10, turnId: 'turn-1' },
      {
        id: 'retry-row',
        role: 'status',
        statusType: 'retrying',
        content: '',
        timestamp: 20,
        retry: { status: 'recovered', attempt: 2, startedAt: 20, elapsedMs: 5000 },
      },
      { id: 'tool-2', role: 'tool', toolName: 'Bash', toolUseId: 'tu-2', toolStatus: 'completed', toolResult: 'ok', timestamp: 30, turnId: 'turn-1' },
    ])

    const turn = turns.find(t => t.type === 'assistant') as AssistantTurn | undefined
    const listed = turn!.activities.map(a => a.id)
    // 重试成功行位于阶梯触发位置（重试运行的过程消息之前）
    expect(listed.indexOf('retry-row')).toBeGreaterThan(listed.indexOf('tool-1'))
    expect(listed.indexOf('retry-row')).toBeLessThan(listed.indexOf('tool-2'))
  })
})

describe('retryPending error card does not split the process block (2026-10-09)', () => {
  it('defers the retry-promise card until after the turn that owns the retry line, keeping one card', () => {
    const turns = groupMessagesByTurn([
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'tool-1', role: 'tool', toolName: 'Read', toolUseId: 'tu-1', toolStatus: 'completed', toolResult: 'ok', timestamp: 10, turnId: 'turn-1' },
      {
        id: 'retry-row',
        role: 'status',
        statusType: 'retrying',
        content: '',
        timestamp: 20,
        retry: { status: 'retrying', attempt: 1, startedAt: 20 },
      },
      {
        id: 'retry-card',
        role: 'error',
        content: 'API error — retrying in the background',
        retryPending: true,
        retryAttempt: 1,
        timestamp: 21,
      },
      { id: 'tool-2', role: 'tool', toolName: 'Bash', toolUseId: 'tu-2', toolStatus: 'completed', toolResult: 'ok', timestamp: 30, turnId: 'turn-1' },
      { id: 'final', role: 'assistant', content: 'Recovered answer', timestamp: 40, turnId: 'turn-1', isIntermediate: false, isPending: false },
    ])

    // One assistant card (tool-1 + retry row + tool-2 + final), then the system card BELOW it.
    const assistantIdx = turns.findIndex(t => t.type === 'assistant')
    const systemIdx = turns.findIndex(t => t.type === 'system')
    expect(assistantIdx).toBeGreaterThanOrEqual(0)
    expect(systemIdx).toBeGreaterThan(assistantIdx)
    expect(turns.filter(t => t.type === 'assistant')).toHaveLength(1)
    const turn = turns[assistantIdx] as AssistantTurn
    const ids = turn.activities.map(a => a.id)
    expect(ids).toEqual(['tool-1', 'retry-row', 'tool-2'])
    // Chronological retry line before the retried-run rows.
    expect(ids.indexOf('retry-row')).toBeLessThan(ids.indexOf('tool-2'))
  })

  it('keeps terminal error cards (non retryPending) splitting as before', () => {
    const turns = groupMessagesByTurn([
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'tool-1', role: 'tool', toolName: 'Read', toolUseId: 'tu-1', toolStatus: 'completed', toolResult: 'ok', timestamp: 10, turnId: 'turn-1' },
      { id: 'terminal', role: 'error', content: 'fatal', timestamp: 20 },
      { id: 'tool-2', role: 'tool', toolName: 'Bash', toolUseId: 'tu-2', toolStatus: 'completed', toolResult: 'ok', timestamp: 30, turnId: 'turn-1' },
    ])
    // Terminal error still closes the current card.
    const assistantTurns = turns.filter(t => t.type === 'assistant')
    const systemTurns = turns.filter(t => t.type === 'system')
    expect(assistantTurns).toHaveLength(2)
    expect(systemTurns).toHaveLength(1)
  })
})
