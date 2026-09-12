/**
 * Memory Tools — Tools for querying and managing cross-session memory.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  MemoryQueryArgs,
  MemoryAction,
  MemoryType,
} from './types.ts';
import {
  loadMemoryStore,
  saveMemoryStore,
  queryMemories,
  applyMemoryAction,
  getMemoryStats,
  getMemoryStorePath,
} from './store.ts';

// ============================================================================
// Tool Definitions
// ============================================================================

/** Schema for memory_query tool */
export const MemoryQuerySchema = z.object({
  query: z.string().describe('Search query (keyword or phrase)'),
  type: z.enum(['fact', 'preference', 'workflow', 'reminder', 'context']).optional()
    .describe('Filter by memory type'),
  tags: z.string().optional()
    .describe('Filter by tags (comma-separated, exact match)'),
  limit: z.number().int().min(1).max(20).optional().describe('Maximum results (default: 10)'),
  minConfidence: z.number().min(0).max(1).optional()
    .describe('Minimum confidence threshold (0.0-1.0, default: 0.3)'),
});

/** Schema for memory_manage tool */
export const MemoryManageSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    content: z.string().min(1).describe('The memory content to add'),
    type: z.enum(['fact', 'preference', 'workflow', 'reminder', 'context']).describe('Memory type'),
    tags: z.array(z.string()).optional().describe('Tags for the memory'),
    confidence: z.number().min(0).max(1).optional().describe('Confidence score (0.0-1.0)'),
  }),
  z.object({
    action: z.literal('update'),
    id: z.string().uuid().describe('Memory entry ID to update'),
    content: z.string().optional().describe('New content'),
    tags: z.array(z.string()).optional().describe('New tags'),
    confidence: z.number().min(0).max(1).optional().describe('New confidence score'),
  }),
  z.object({
    action: z.literal('delete'),
    id: z.string().uuid().describe('Memory entry ID to delete'),
  }),
  z.object({
    action: z.literal('query'),
    query: z.string().describe('Search query'),
    type: z.enum(['fact', 'preference', 'workflow', 'reminder', 'context']).optional(),
    tags: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
  }),
  z.object({
    action: z.literal('stats'),
  }),
]);

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Create the memory_query tool definition.
 */
export function createMemoryQueryTool(
  workspaceRootPath: string,
): Tool {
  return {
    name: 'memory_query',
    description: `Search cross-session persistent memories.

Returns facts, preferences, workflows, and reminders extracted from previous conversations. Use this to recall important context from earlier sessions.

Examples:
- "What does the user prefer about code style?" → query: "code style preference"
- "What projects am I working on?" → query: "project" type: "context"
- "What workflows have I learned?" → query: "workflow" type: "workflow"`,
    inputSchema: MemoryQuerySchema.shape as any,
  };
}

/**
 * Create the memory_manage tool definition.
 */
export function createMemoryManageTool(
  workspaceRootPath: string,
): Tool {
  return {
    name: 'memory_manage',
    description: `Manage cross-session persistent memories.

Actions:
- query: Search memories by keyword
- add: Add a new memory (e.g., "I prefer TypeScript over JavaScript")
- update: Edit an existing memory by ID
- delete: Remove a memory by ID
- stats: Show memory statistics

Use this to manually curate the knowledge base that persists across sessions.`,
    inputSchema: MemoryManageSchema as any,
  };
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Handle memory_query tool calls.
 */
export async function handleMemoryQuery(
  args: MemoryQueryArgs,
  workspaceRootPath: string,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    const store = loadMemoryStore(workspaceRootPath);
    const result = queryMemories(store, args);

    if (result.entries.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No memories found matching "${args.query}".\n\nTry:\n- Broadening your search terms\n- Using a different type filter\n- Checking memory_stats to see what's available`,
        }],
      };
    }

    const sections = result.entries.map((entry, i) => {
      const tagStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
      return `${i + 1}. [${entry.type}]${tagStr}\n   ${entry.content}\n   Confidence: ${(entry.confidence * 100).toFixed(0)}% | From: ${entry.sourceSessionId.slice(0, 8)}...`;
    });

    return {
      content: [{
        type: 'text',
        text: `Found ${result.totalCount} memory(s) matching "${args.query}":\n\n${sections.join('\n\n')}`,
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Memory query failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}

/**
 * Handle memory_manage tool calls.
 */
export async function handleMemoryManage(
  args: z.infer<typeof MemoryManageSchema>,
  workspaceRootPath: string,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    const store = loadMemoryStore(workspaceRootPath);

    if (args.action === 'stats') {
      const stats = getMemoryStats(store);
      return {
        content: [{
          type: 'text',
          text: `Memory Statistics:
- Total entries: ${stats.totalEntries}
- By type: facts=${stats.entriesByType.fact}, preferences=${stats.entriesByType.preference}, workflows=${stats.entriesByType.workflow}, reminders=${stats.entriesByType.reminder}, context=${stats.entriesByType.context}
- Total extractions: ${stats.totalExtractions}
- Last extraction: ${stats.lastExtractionAt ? new Date(stats.lastExtractionAt).toLocaleString() : 'Never'}
- Total injection tokens: ${stats.totalInjectionTokens}`,
        }],
      };
    }

    if (args.action === 'query') {
      return handleMemoryQuery(args, workspaceRootPath);
    }

    // Mutating actions: add, update, delete
    const action: MemoryAction = args.action === 'add'
      ? { type: 'add', content: args.content, typeLabel: args.type, tags: args.tags, confidence: args.confidence }
      : args.action === 'update'
        ? { type: 'update', id: args.id, content: args.content, tags: args.tags, confidence: args.confidence }
        : { type: 'delete', id: args.id };

    const result = applyMemoryAction(store, action as any);
    saveMemoryStore(workspaceRootPath, store);

    if (!result.success) {
      return {
        content: [{ type: 'text', text: 'Action failed: entry not found or invalid' }],
        isError: true,
      };
    }

    const messages: Record<string, string> = {
      add: `Memory added successfully (ID: ${result.entryId}).`,
      update: `Memory updated successfully.`,
      delete: `Memory deleted successfully.`,
    };

    return {
      content: [{ type: 'text', text: messages[action.type] ?? 'Done.' }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Memory management failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}

/**
 * Register memory tools into an MCP server.
 */
export function registerMemoryTools(
  mcpServer: { addTool: (tool: Tool, handler?: Function) => void },
  workspaceRootPath: string,
): void {
  const queryTool = createMemoryQueryTool(workspaceRootPath);
  const manageTool = createMemoryManageTool(workspaceRootPath);

  mcpServer.addTool(queryTool, async (args: MemoryQueryArgs) =>
    handleMemoryQuery(args, workspaceRootPath));
  mcpServer.addTool(manageTool, async (args: z.infer<typeof MemoryManageSchema>) =>
    handleMemoryManage(args, workspaceRootPath));
}
