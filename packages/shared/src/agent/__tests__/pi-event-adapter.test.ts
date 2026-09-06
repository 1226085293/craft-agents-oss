/**
 * Tests for PiEventAdapter
 *
 * Tests the Pi SDK AgentEvent / AgentSessionEvent → Craft AgentEvent conversion.
 * Each test provides mock Pi SDK event objects and verifies the AgentEvents produced.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { toolMetadataStore } from '../../interceptor-common.ts';

// Helper: collect all events from a generator
function collect(gen: Generator<any>): any[] {
  return [...gen];
}

describe('PiEventAdapter', () => {
  let adapter: PiEventAdapter;
  let sessionDir: string;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    sessionDir = mkdtempSync(join(tmpdir(), 'pi-adapter-'));
    adapter.setSessionDir(sessionDir);
    toolMetadataStore.setSessionDir(sessionDir);
    adapter.startTurn();
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  // ============================================================
  // Agent lifecycle
  // ============================================================

  describe('agent lifecycle', () => {
    it('should emit nothing for agent_start', () => {
      const events = collect(adapter.adaptEvent({ type: 'agent_start' } as any));
      expect(events).toHaveLength(0);
    });

    it('should emit complete for agent_end', () => {
      const events = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'complete' });
    });
  });

  // ============================================================
  // Turn lifecycle
  // ============================================================

  describe('turn lifecycle', () => {
    it('should set currentTurnId on turn_start', () => {
      // turn_start is handled internally — emits no events
      const events = collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      expect(events).toHaveLength(0);
    });

    it('should emit nothing on turn_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({ type: 'turn_end' } as any));
      expect(events).toHaveLength(0);
    });

    it('should generate sequential turn IDs across turns', () => {
      // First turn (turnIndex=1 from beforeEach startTurn)
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello' },
      } as any));
      expect(events1[0].turnId).toMatch(/^pi-turn-1/);

      // End first turn, start second
      collect(adapter.adaptEvent({ type: 'turn_end' } as any));
      adapter.startTurn();
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'World' },
      } as any));
      expect(events2[0].turnId).toMatch(/^pi-turn-2/);
    });
  });

  // ============================================================
  // Message events — text streaming
  // ============================================================

  describe('message events', () => {
    it('should emit nothing for message_start', () => {
      const events = collect(adapter.adaptEvent({ type: 'message_start' } as any));
      expect(events).toHaveLength(0);
    });

    it('should emit text_delta for message_update with text_delta', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_delta',
        text: 'Hello',
      });
      expect(events[0].turnId).toMatch(/^pi-turn-1__m0$/);
    });

    it('should skip message_update without text_delta type', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'usage_delta', delta: null },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should skip message_update with empty delta', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '' },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should reuse same sub-turnId for consecutive deltas', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events1 = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      } as any));
      const events2 = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: ' World' },
      } as any));

      expect(events1[0].turnId).toBe(events2[0].turnId);
    });

    it('should emit text_complete for final assistant message_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello there' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Hello there',
        isIntermediate: false,
      });
    });

    it('should attach sdkMessageId from message_end onto the text_complete', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        sdkMessageId: 'msg_pi_abc123',
        message: { role: 'assistant', stopReason: 'stop', content: 'Anchored output', id: 'msg_pi_abc123' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Anchored output',
        sdkMessageId: 'msg_pi_abc123',
      });
      // sdkTurnAnchor is delivered separately by a follow-up pi_turn_anchor event.
      expect((events[0] as { sdkTurnAnchor?: string }).sdkTurnAnchor).toBeUndefined();
    });

    it('should forward pi_turn_anchor events as Craft AgentEvents', () => {
      const events = collect(adapter.adaptEvent({
        type: 'pi_turn_anchor',
        sdkMessageId: 'msg_pi_abc123',
        sdkTurnAnchor: 'entry_abc123',
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'pi_turn_anchor',
        sdkMessageId: 'msg_pi_abc123',
        sdkTurnAnchor: 'entry_abc123',
      });
    });

    it('should drop pi_turn_anchor events with missing fields', () => {
      // No sdkTurnAnchor — useless to consumers.
      const e1 = collect(adapter.adaptEvent({
        type: 'pi_turn_anchor',
        sdkMessageId: 'msg_pi_abc123',
      } as any));
      expect(e1).toHaveLength(0);
      // No sdkMessageId — cannot correlate.
      const e2 = collect(adapter.adaptEvent({
        type: 'pi_turn_anchor',
        sdkTurnAnchor: 'entry_abc123',
      } as any));
      expect(e2).toHaveLength(0);
    });

    it('should skip non-assistant message_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'user', content: 'Hello' },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should skip toolResult message_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'toolResult', content: 'result' },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should extract text from content array', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: ' Part 2' },
          ],
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('Part 1 Part 2');
    });

    it('should skip message_end with no text content', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'tool_use', id: 'tool1' }],
        },
      } as any));
      expect(events).toHaveLength(0);
    });
  });

  // ============================================================
  // Intermediate vs final text classification
  // ============================================================

  describe('intermediate text classification', () => {
    it('should set isIntermediate: true when stopReason is toolUse', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me check that...',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Let me check that...',
        isIntermediate: true,
      });
    });

    it('should set isIntermediate: false when stopReason is stop', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Here is the final answer.',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Here is the final answer.',
        isIntermediate: false,
      });
    });

    it('should allow multiple intermediate messages in a turn', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // First intermediate message
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me read the file...',
        },
      } as any));

      // Simulate tool execution between intermediates
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'tool1',
        toolName: 'read',
        args: { path: '/foo.ts' },
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'tool1',
        result: 'file content',
        isError: false,
      } as any));

      // Second intermediate message
      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Now let me check the tests...',
        },
      } as any));

      expect(events1).toHaveLength(1);
      expect(events1[0].isIntermediate).toBe(true);

      expect(events2).toHaveLength(1);
      expect(events2[0].isIntermediate).toBe(true);
    });

    it('should block duplicate final messages in same turn', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // First final message
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Final answer',
        },
      } as any));

      // Duplicate final message (should be blocked)
      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Duplicate final',
        },
      } as any));

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(0);
    });

    it('should allow final message after tool completion resets state', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Intermediate message
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'Checking...' },
      } as any));

      // Tool execution
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'tool1',
        toolName: 'read',
        args: {},
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'tool1',
        result: 'output',
        isError: false,
      } as any));

      // Final message after tool — should work because tool_execution_end resets hasEmittedFinalText
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Here is the answer.' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].isIntermediate).toBe(false);
    });
  });

  // ============================================================
  // Sub-turnId isolation
  // ============================================================

  describe('sub-turnId isolation', () => {
    it('should generate unique sub-turnIds for text blocks', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // First text block
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'First' },
      } as any));

      // Tool between text blocks
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: {},
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 't1',
        result: 'ok',
        isError: false,
      } as any));

      // Second text block
      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Second' },
      } as any));

      expect(events1[0].turnId).not.toBe(events2[0].turnId);
      expect(events1[0].turnId).toMatch(/^pi-turn-1__m/);
      expect(events2[0].turnId).toMatch(/^pi-turn-1__m/);
    });

    it('should use streaming sub-turnId when deltas preceded text_complete', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Stream deltas first
      const deltaEvents = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      } as any));

      // Then text_complete
      const completeEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello world' },
      } as any));

      // text_complete should reuse the delta's sub-turnId
      expect(completeEvents[0].turnId).toBe(deltaEvents[0].turnId);
    });

    it('should reset sub-turnId counter across turns', () => {
      // First turn
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Turn 1' },
      } as any));

      // End turn, start new one
      collect(adapter.adaptEvent({ type: 'turn_end' } as any));
      adapter.startTurn();
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Turn 2' },
      } as any));

      // Sub-turn counter resets: both should end with m0
      expect(events1[0].turnId).toBe('pi-turn-1__m0');
      expect(events2[0].turnId).toBe('pi-turn-2__m0');
    });
  });

  // ============================================================
  // Error surfacing
  // ============================================================

  describe('error surfacing', () => {
    it('should emit plain error for unclassified error messages', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Something went wrong internally',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Something went wrong internally',
      });
    });

    it('should emit typed_error for raw HTML proxy pages', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudflare</center></body></html>',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect((events[0] as any).error.code).toBe('proxy_error');
      expect((events[0] as any).error.message.toLowerCase()).not.toContain('<html');
    });

    it('should emit typed_error for auth-expiry error messages', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Provided authentication token is expired. Please try signing in again.',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect(events[0].error.code).toBe('expired_oauth_token');
    });

    it('should emit typed_error for 401 unauthorized errors', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '401 Unauthorized',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect(events[0].error.code).toBe('invalid_api_key');
    });

    it('should emit typed_error for billing/402 errors', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '402 Payment required',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect(events[0].error.code).toBe('billing_error');
    });

    it('should defer retryable rate limit errors to the terminal agent_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '429 Too many requests - rate limit exceeded',
        },
      } as any));

      // Retryable errors are deferred — the SDK may auto-retry after the
      // upcoming agent_end, so surfacing here would report ❌ prematurely.
      expect(events).toHaveLength(0);

      // Terminal agent_end (no retry follows) surfaces the deferred error
      // exactly once, followed by complete.
      const terminal = collect(adapter.adaptEvent({ type: 'agent_end', willRetry: false } as any));
      expect(terminal[0].type).toBe('typed_error');
      expect((terminal[0] as any).error.code).toBe('rate_limited');
      expect(terminal[1]).toMatchObject({ type: 'complete' });
    });

    it('should not emit error without errorMessage even if stopReason is error', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          // No errorMessage — fall through to normal text extraction
          content: 'Some partial content',
        },
      } as any));

      // Should emit as text_complete, not error
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_complete');
    });
  });

  // ============================================================
  // Tool events
  // ============================================================

  describe('tool events', () => {
    it('should emit tool_start for tool_execution_start', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_123',
        toolName: 'bash',
        args: { command: 'ls -la', description: 'List files' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Bash',
        toolUseId: 'call_123',
        input: { command: 'ls -la', description: 'List files' },
        displayName: 'Run Command',
      });
    });

    it('should fallback to args metadata when store has no entry', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_no_store',
        toolName: 'bash',
        args: {
          command: 'npm test',
          _intent: 'Run unit tests',
          _displayName: 'Run Tests',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Bash',
        toolUseId: 'call_no_store',
        intent: 'Run unit tests',
        displayName: 'Run Tests',
      });
    });

    it('should preserve edits[] for Pi edit tools while deriving legacy diff fields', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_edit',
        toolName: 'edit',
        args: {
          path: '/src/app.ts',
          edits: [
            { oldText: 'const a = 1', newText: 'const a = 2' },
            { oldText: 'const b = 1', newText: 'const b = 2' },
          ],
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Edit',
        toolUseId: 'call_edit',
        input: {
          file_path: '/src/app.ts',
          old_string: 'const a = 1',
          new_string: 'const a = 2',
          edits: [
            { oldText: 'const a = 1', newText: 'const a = 2' },
            { oldText: 'const b = 1', newText: 'const b = 2' },
          ],
        },
      });
    });

    it('should prefer store metadata over args metadata when both exist', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      toolMetadataStore.set('call_store_wins', {
        intent: 'Stored intent',
        displayName: 'Stored name',
        timestamp: Date.now(),
      });

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_store_wins',
        toolName: 'bash',
        args: {
          command: 'npm test',
          _intent: 'Args intent',
          _displayName: 'Args name',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_store_wins',
        intent: 'Stored intent',
        displayName: 'Stored name',
      });
    });

    it('should use canonical metadata from event payload', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_canonical',
        toolName: 'bash',
        args: { command: 'npm test' },
        toolMetadata: {
          intent: 'Canonical intent',
          displayName: 'Canonical name',
          source: 'interceptor',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_canonical',
        intent: 'Canonical intent',
        displayName: 'Canonical name',
      });
    });

    it('should fallback to base id metadata when toolCallId includes a pipe suffix', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      toolMetadataStore.set('call_base_id', {
        intent: 'Stored base intent',
        displayName: 'Stored base name',
        timestamp: Date.now(),
      });

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_base_id|fc_123',
        toolName: 'bash',
        args: { command: 'npm test' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_base_id|fc_123',
        intent: 'Stored base intent',
        displayName: 'Stored base name',
      });
    });

    it('should prefer canonical metadata over store and args', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      toolMetadataStore.set('call_canonical_wins', {
        intent: 'Stored intent',
        displayName: 'Stored name',
        timestamp: Date.now(),
      });

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_canonical_wins',
        toolName: 'bash',
        args: {
          command: 'npm test',
          _intent: 'Args intent',
          _displayName: 'Args name',
        },
        toolMetadata: {
          intent: 'Canonical intent',
          displayName: 'Canonical name',
          source: 'interceptor',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_canonical_wins',
        intent: 'Canonical intent',
        displayName: 'Canonical name',
      });
    });

    it('should resolve Pi lowercase tool names to PascalCase', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const toolTests = [
        { piName: 'read', expected: 'Read' },
        { piName: 'write', expected: 'Write' },
        { piName: 'edit', expected: 'Edit' },
        { piName: 'grep', expected: 'Grep' },
        { piName: 'find', expected: 'Find' },
        { piName: 'ls', expected: 'Ls' },
      ];

      for (const { piName, expected } of toolTests) {
        const events = collect(adapter.adaptEvent({
          type: 'tool_execution_start',
          toolCallId: `call_${piName}`,
          toolName: piName,
          args: {},
        } as any));

        expect(events[0].toolName).toBe(expected);
      }
    });

    it('should emit tool_result for tool_execution_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Start tool first
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'read',
        args: { path: '/foo.ts' },
      } as any));

      // End tool
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: { content: [{ type: 'text', text: 'file contents' }] },
        isError: false,
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'call_1',
        toolName: 'Read',
        result: 'file contents',
        isError: false,
      });
    });

    it('should handle string result in tool_execution_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'command output',
        isError: false,
      } as any));

      expect(events[0].result).toBe('command output');
    });

    it('should handle error tool results', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: null,
        isError: true,
      } as any));

      expect(events[0]).toMatchObject({
        type: 'tool_result',
        isError: true,
        result: 'Tool execution failed',
      });
    });

    it('should accumulate partial output from tool_execution_update', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      } as any));

      // Partial updates
      collect(adapter.adaptEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_1',
        partialResult: { content: [{ type: 'text', text: 'line 1\n' }] },
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_1',
        partialResult: { content: [{ type: 'text', text: 'line 2\n' }] },
      } as any));

      // End — should use accumulated output
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'ignored because accumulated',
        isError: false,
      } as any));

      expect(events[0].result).toBe('line 1\nline 2\n');
    });

    it('should use description as intent for bash tools', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'npm test', description: 'Run unit tests' },
      } as any));

      expect(events[0].intent).toBe('Run unit tests');
    });

    it('should classify bash cat commands as Read tool starts', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'cat /path/to/file.ts' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('Read');
      expect(events[0].displayName).toBe('Read File');
    });

    it('should reset hasEmittedFinalText after tool_execution_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Emit final text
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'Checking...' },
      } as any));

      // Tool execution
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: {},
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 't1',
        result: 'ok',
        isError: false,
      } as any));

      // Another text after tool — should succeed
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Done!' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('Done!');
    });
  });

  // ============================================================
  // Session-level events
  // ============================================================

  describe('session events', () => {
    it('should emit status for compaction_start', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_start',
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Compacting context...',
      });
    });

    it('should emit info for successful compaction_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: { /* compaction result */ },
        aborted: false,
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'info',
        message: 'Compacted context to fit within limits',
      });
    });

    it('should emit error for failed compaction_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: 'Out of memory',
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Context compaction failed: Out of memory',
      });
    });

    it('should emit nothing for aborted compaction', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: true,
      } as any));

      expect(events).toHaveLength(0);
    });

    it('should emit status for auto_retry_start', () => {
      const events = collect(adapter.adaptEvent({
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Retrying (attempt 2/3)...',
      });
    });

    it('should emit error for failed auto_retry_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'auto_retry_end',
        success: false,
        finalError: 'Max retries exceeded',
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Retry failed: Max retries exceeded',
      });
    });

    it('should emit nothing for successful auto_retry_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'auto_retry_end',
        success: true,
      } as any));

      expect(events).toHaveLength(0);
    });

    it('should emit nothing for queue_update', () => {
      const events = collect(adapter.adaptEvent({
        type: 'queue_update',
        steering: ['Focus on tests'],
        followUp: ['Then summarize the diff'],
      } as any));

      expect(events).toHaveLength(0);
    });
  });

  // ============================================================
  // Full multi-turn flow
  // ============================================================

  describe('full multi-turn flow', () => {
    it('should handle intermediate → tool → final message flow', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // 1. Intermediate commentary
      const intermediateEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me check the file...',
        },
      } as any));

      // 2. Tool execution
      const toolStartEvents = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'read',
        args: { path: '/src/index.ts' },
      } as any));

      const toolEndEvents = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'file contents here',
        isError: false,
      } as any));

      // 3. Final response
      const finalEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'The file contains your code.',
        },
      } as any));

      // Verify complete flow
      expect(intermediateEvents[0]).toMatchObject({
        type: 'text_complete',
        isIntermediate: true,
        text: 'Let me check the file...',
      });
      expect(toolStartEvents[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Read',
      });
      expect(toolEndEvents[0]).toMatchObject({
        type: 'tool_result',
        toolName: 'Read',
      });
      expect(finalEvents[0]).toMatchObject({
        type: 'text_complete',
        isIntermediate: false,
        text: 'The file contains your code.',
      });

      // All events should have pi-turn-1 prefix
      expect(intermediateEvents[0].turnId).toMatch(/^pi-turn-1/);
      expect(toolStartEvents[0].turnId).toMatch(/^pi-turn-1/);
      expect(finalEvents[0].turnId).toMatch(/^pi-turn-1/);
    });
  });

  // ============================================================
  // Overflow recovery state machine
  // ============================================================
  //
  // The Pi SDK's _checkCompaction fires _runAutoCompaction("overflow", true)
  // on context_length_exceeded, then agent.continue() to retry. The recovered
  // turn arrives AFTER the original agent_end. The adapter holds the queue
  // open across this flow so the recovered response reaches the UI; if
  // recovery fails or no compaction events arrive, the held error is
  // surfaced and the queue terminates. See plans/fix-pi-gpt-compaction.md.

  describe('overflow recovery', () => {
    const overflowMessage = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Your input exceeds the context window of this model. Please adjust your input and try again. (context_length_exceeded)',
    };

    it('success path: holds queue open, surfaces recovered turn, completes once', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // 1. Overflow message_end — adapter swallows the error.
      const errEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: overflowMessage,
      } as any));
      expect(errEvents).toHaveLength(0);

      // 2. Original agent_end — held, no complete yielded, queue stays open.
      const heldAgentEnd = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(heldAgentEnd).toHaveLength(0);
      expect(adapter.shouldCompleteQueue(true)).toBe(false);

      // 3. compaction_start — status surfaces.
      const startEvents = collect(adapter.adaptEvent({ type: 'compaction_start' } as any));
      expect(startEvents).toMatchObject([{ type: 'status', message: 'Compacting context...' }]);

      // 4. compaction_end success — info surfaces, still no complete.
      const endEvents = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: { /* compaction result */ },
        aborted: false,
      } as any));
      expect(endEvents).toMatchObject([{ type: 'info', message: 'Compacted context to fit within limits' }]);
      expect(adapter.shouldCompleteQueue(false)).toBe(false);

      // 5. Recovered text + final agent_end — text_complete + complete arrive.
      const recoveredText = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Recovered answer' },
      } as any));
      expect(recoveredText).toMatchObject([{ type: 'text_complete', text: 'Recovered answer' }]);

      const finalAgentEnd = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(finalAgentEnd).toMatchObject([{ type: 'complete' }]);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);

      // The original context_length_exceeded never reached the UI.
      const allYields = [...errEvents, ...heldAgentEnd, ...startEvents, ...endEvents, ...recoveredText, ...finalAgentEnd];
      const errorYields = allYields.filter(e => e.type === 'error' || e.type === 'typed_error');
      expect(errorYields).toHaveLength(0);
    });

    it('failure path: drains held overflow with friendly error + complete', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      collect(adapter.adaptEvent({ type: 'message_end', message: overflowMessage } as any));
      collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      collect(adapter.adaptEvent({ type: 'compaction_start' } as any));

      const failureEvents = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: 'Out of memory during summary',
      } as any));

      expect(failureEvents).toEqual([
        { type: 'error', message: 'Context compaction failed: Out of memory during summary' },
        { type: 'complete' },
      ]);
      // Queue should terminate even though the event wasn't agent_end.
      expect(adapter.shouldCompleteQueue(false)).toBe(true);
      // Only one terminal complete — subsequent calls return false.
      expect(adapter.shouldCompleteQueue(false)).toBe(false);
    });

    it('skipped recovery: fallback timer drains held error after timeout', () => {
      jest.useFakeTimers();
      try {
        const enqueued: any[] = [];
        let completed = false;
        adapter.setOverflowFallbackHandlers(
          (event) => enqueued.push(event),
          () => { completed = true; },
        );

        collect(adapter.adaptEvent({ type: 'turn_start' } as any));
        collect(adapter.adaptEvent({ type: 'message_end', message: overflowMessage } as any));
        collect(adapter.adaptEvent({ type: 'agent_end' } as any));

        // No compaction events arrive. Advance past the 5 s fallback timeout.
        jest.advanceTimersByTime(5_000);

        expect(enqueued).toEqual([{ type: 'error', message: overflowMessage.errorMessage }]);
        expect(completed).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('non-overflow regression: rate-limit error defers and surfaces on terminal agent_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Rate limit exceeded; please try again in 30s',
        },
      } as any));

      // Retryable (non-overflow) errors are deferred, NOT held as overflow.
      expect(events).toHaveLength(0);

      // Terminal agent_end surfaces the deferred error, then completes
      // normally — overflow state stays untouched.
      const agentEndEvents = collect(adapter.adaptEvent({ type: 'agent_end', willRetry: false } as any));
      expect(agentEndEvents[0].type).toMatch(/^(error|typed_error)$/);
      expect(agentEndEvents[agentEndEvents.length - 1]).toMatchObject({ type: 'complete' });
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });

    it('SDK race signature: friendly message instead of raw stack', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({ type: 'message_end', message: overflowMessage } as any));
      collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      collect(adapter.adaptEvent({ type: 'compaction_start' } as any));

      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: "Auto-compaction failed: undefined is not an object (evaluating 'this._autoCompactionAbortController.signal')",
      } as any));

      expect(events).toEqual([
        { type: 'error', message: 'Auto-compaction hit a transient error. Try /compact manually.' },
        { type: 'complete' },
      ]);
      // The raw `_autoCompactionAbortController.signal` text is not in any yield.
      const allMessages = events.map((e: any) => e.message ?? '').join(' ');
      expect(allMessages).not.toMatch(/_autoCompactionAbortController/);
      expect(adapter.shouldCompleteQueue(false)).toBe(true);
    });
  });

  // ============================================================
  // Defense resume (pi-agent-server defense layer)
  // ============================================================
  //
  // The subprocess annotates the FIRST agent_end with defenseResumePending=true
  // when its post-stop defense queued a followUp() that continues the same turn.
  // The queue must stay open across the resumed turn (its events arrive after
  // this agent_end) and complete only on the FINAL agent_end (no flag).
  // Regression for the 2026-08-23 incident: without this hold, the resumed
  // answer landed in a closed event queue and was silently lost.

  describe('defense resume holds the queue open', () => {
    it('success path: holds on flagged agent_end, completes on final agent_end', () => {
      // First agent_end — subprocess queued a defense resume.
      const heldEvents = collect(adapter.adaptEvent({
        type: 'agent_end',
        messages: [],
        defenseResumePending: true,
      } as any));
      // No `complete` is yielded — the UI must not see a finished turn yet.
      expect(heldEvents).toHaveLength(0);
      expect(adapter.shouldCompleteQueue(true, true)).toBe(false);

      // Resumed turn streams an assistant reply.
      const resumed = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Resumed answer' },
      } as any));
      expect(resumed).toMatchObject([{ type: 'text_complete', text: 'Resumed answer' }]);
      expect(adapter.shouldCompleteQueue(false)).toBe(false);

      // Final agent_end — no flag → normal completion.
      const finalEvents = collect(adapter.adaptEvent({ type: 'agent_end', messages: [] } as any));
      expect(finalEvents).toMatchObject([{ type: 'complete' }]);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });

    it('flags only the first agent_end — a stale held flag cannot leak into the next turn', () => {
      collect(adapter.adaptEvent({ type: 'agent_end', messages: [], defenseResumePending: true } as any));
      adapter.shouldCompleteQueue(true, true);

      // A second flagged agent_end (defensive / SDK retry) keeps holding.
      expect(adapter.shouldCompleteQueue(true, true)).toBe(false);
      // Unflagged agent_end clears the hold.
      expect(adapter.shouldCompleteQueue(true, false)).toBe(true);
      // And a subsequent normal agent_end still completes (no stale hold).
      expect(adapter.shouldCompleteQueue(true, false)).toBe(true);
    });

    it('failure path: finalizeDefenseResumeHeld terminates the held queue', () => {
      collect(adapter.adaptEvent({ type: 'agent_end', messages: [], defenseResumePending: true } as any));
      expect(adapter.shouldCompleteQueue(true, true)).toBe(false);

      // followUp failed — subprocess reports resumed:false.
      adapter.finalizeDefenseResumeHeld();
      // The next event terminates the iterator (like compaction_end failure).
      expect(adapter.shouldCompleteQueue(false)).toBe(true);
      // Consumed — subsequent calls return false.
      expect(adapter.shouldCompleteQueue(false)).toBe(false);
    });

    it('regression: unflagged agent_end completes the queue as before', () => {
      // Plain turn with no defense evaluation at all.
      const events = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(events).toMatchObject([{ type: 'complete' }]);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });

    it('resetOverflowState clears the defense hold too', () => {
      collect(adapter.adaptEvent({ type: 'agent_end', messages: [], defenseResumePending: true } as any));
      adapter.shouldCompleteQueue(true, true);

      adapter.resetOverflowState();
      // Hold cleared: an unflagged agent_end completes normally.
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });
  });

  // The subprocess annotates an agent_end with queuedFollowUpPending=true when
  // the SDK still holds queued steering/followUp messages (pendingMessageCount
  // > 0). The SDK's _handlePostAgentRun calls agent.continue() AFTER that
  // agent_end — a continuation turn with no flag of its own. Regression for
  // the 2026-09-06 golden-swamp incident: steer arrived near turn end, the
  // queue completed anyway, and the continuation's events were silently lost.
  describe('queued steering/followUp continuation holds the queue open', () => {
    it('success path: holds on flagged agent_end, completes on final agent_end', () => {
      // First agent_end — steer messages are still queued.
      const heldEvents = collect(adapter.adaptEvent({
        type: 'agent_end',
        messages: [],
        queuedFollowUpPending: true,
      } as any));
      expect(heldEvents).toHaveLength(0);
      expect(adapter.shouldCompleteQueue(true, undefined, true)).toBe(false);

      // Continuation turn streams an assistant reply.
      const continued = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Continued answer' },
      } as any));
      expect(continued).toMatchObject([{ type: 'text_complete', text: 'Continued answer' }]);
      expect(adapter.shouldCompleteQueue(false)).toBe(false);

      // Final agent_end — no flag → normal completion.
      const finalEvents = collect(adapter.adaptEvent({ type: 'agent_end', messages: [] } as any));
      expect(finalEvents).toMatchObject([{ type: 'complete' }]);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });

    it('coexists with defenseResumePending — either flag holds the queue', () => {
      // Both flags on the same agent_end (defense queued a followUp AND
      // steering messages were pending). The hold must survive.
      const heldEvents = collect(adapter.adaptEvent({
        type: 'agent_end',
        messages: [],
        defenseResumePending: true,
        queuedFollowUpPending: true,
      } as any));
      expect(heldEvents).toHaveLength(0);
      expect(adapter.shouldCompleteQueue(true, true, true)).toBe(false);

      // Unflagged final agent_end completes.
      expect(adapter.shouldCompleteQueue(true, false, false)).toBe(true);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });

    it('unflagged agent_end clears the hold (no stale continuation leak)', () => {
      collect(adapter.adaptEvent({ type: 'agent_end', messages: [], queuedFollowUpPending: true } as any));
      expect(adapter.shouldCompleteQueue(true, undefined, true)).toBe(false);

      // Next turn: a plain agent_end (queue drained inside the loop) completes.
      expect(adapter.shouldCompleteQueue(true, undefined, false)).toBe(true);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });

    it('resetOverflowState clears the continuation hold too', () => {
      collect(adapter.adaptEvent({ type: 'agent_end', messages: [], queuedFollowUpPending: true } as any));
      adapter.shouldCompleteQueue(true, undefined, true);

      adapter.resetOverflowState();
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });
  });

  // ============================================================
  // Retryable error deferral (auto-retry terminal-state reporting)
  // ============================================================
  //
  // The Pi SDK's auto-retry sequence for a retryable assistant error is:
  //   message_end(stopReason:'error')
  //   → agent_end (willRetry: true — annotated by the SDK's _emit wrapper)
  //   → auto_retry_start
  //   → ...retried turn: message_end(success) ... final agent_end (willRetry: false)
  // When retries are exhausted, the LAST agent_end carries willRetry: false and
  // auto_retry_end(success: false) follows it.
  //
  // Historic bug: the adapter surfaced the error immediately on message_end,
  // so the UI (Telegram ❌) reported final failure while the SDK was still
  // retrying and the retried answer then arrived anyway.
  //
  // Fix: defer retryable errors until the terminal agent_end (willRetry: false
  // or absent) and report exactly once. User aborts (stopReason 'aborted') are
  // never deferred or recovered. See plans/termination-progress-fix.md step 1.

  describe('retryable error deferral', () => {
    const terminatedError = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'terminated',
    };

    it('success path: defers terminated error, retry succeeds, original error never surfaces', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // 1. message_end with retryable error — deferred, nothing surfaces.
      const deferred = collect(adapter.adaptEvent({
        type: 'message_end',
        message: terminatedError,
      } as any));
      expect(deferred).toHaveLength(0);

      // 2. agent_end with willRetry: true — SDK will auto-retry. Queue stays
      //    open for the retried turn; no complete is yielded.
      const retryAgentEnd = collect(adapter.adaptEvent({ type: 'agent_end', willRetry: true } as any));
      expect(retryAgentEnd).toHaveLength(0);
      expect(adapter.shouldCompleteQueue(true)).toBe(false);

      // 3. auto_retry_start — status only.
      const retryStatus = collect(adapter.adaptEvent({
        type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000,
      } as any));
      expect(retryStatus).toMatchObject([{ type: 'status', message: 'Retrying (attempt 1/3)...' }]);

      // 4. Retried turn succeeds: final text + terminal agent_end.
      const text = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Recovered answer after retry' },
      } as any));
      expect(text).toMatchObject([{ type: 'text_complete', text: 'Recovered answer after retry' }]);

      const finalAgentEnd = collect(adapter.adaptEvent({ type: 'agent_end', willRetry: false } as any));
      expect(finalAgentEnd).toMatchObject([{ type: 'complete' }]);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);

      // The original 'terminated' error must NEVER reach the UI.
      const allYields = [...deferred, ...retryAgentEnd, ...retryStatus, ...text, ...finalAgentEnd];
      const errorYields = allYields.filter((e) => e.type === 'error' || e.type === 'typed_error');
      expect(errorYields).toHaveLength(0);
    });

    it('exhaustion path: surfaces deferred error exactly once at the terminal agent_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Attempt 1 fails → willRetry true.
      collect(adapter.adaptEvent({ type: 'message_end', message: terminatedError } as any));
      collect(adapter.adaptEvent({ type: 'agent_end', willRetry: true } as any));
      collect(adapter.adaptEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3 } as any));

      // Attempt 2 also fails, retries exhausted → terminal agent_end.
      const secondFailure = collect(adapter.adaptEvent({ type: 'message_end', message: terminatedError } as any));
      expect(secondFailure).toHaveLength(0); // still deferred

      const terminalAgentEnd = collect(adapter.adaptEvent({ type: 'agent_end', willRetry: false } as any));
      // Error surfaces exactly once, then complete.
      const errorEvents = terminalAgentEnd.filter((e) => e.type === 'error' || e.type === 'typed_error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({ type: 'error', message: 'terminated' });
      expect(terminalAgentEnd[terminalAgentEnd.length - 1]).toMatchObject({ type: 'complete' });
      expect(adapter.shouldCompleteQueue(true)).toBe(true);

      // The SDK's subsequent auto_retry_end(success:false) must NOT report a
      // second error — the failure was already reported once.
      const retryEnd = collect(adapter.adaptEvent({
        type: 'auto_retry_end', success: false, attempt: 1, finalError: 'terminated',
      } as any));
      const dupErrors = retryEnd.filter((e) => e.type === 'error' || e.type === 'typed_error');
      expect(dupErrors).toHaveLength(0);
    });

    it('auto_retry_end failure after an unrelated non-retryable turn does not double-report', () => {
      // A turn that failed terminally WITHOUT deferral (e.g. auth error —
      // non-retryable) already reported via typed_error on message_end.
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const direct = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: '401 Unauthorized' },
      } as any));
      expect(direct).toHaveLength(1);
      expect(direct[0].type).toBe('typed_error');

      // A late auto_retry_end failure must not add a second error.
      const retryEnd = collect(adapter.adaptEvent({
        type: 'auto_retry_end', success: false, attempt: 1, finalError: '401 Unauthorized',
      } as any));
      expect(retryEnd.filter((e) => e.type === 'error' || e.type === 'typed_error')).toHaveLength(0);
    });

    it('user abort: stopReason aborted is never deferred or recovered', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Aborted message_end — not an error, not deferred; falls through to
      // normal text extraction (partial content still reaches the UI).
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'aborted', content: 'Partial answer' },
      } as any));
      expect(events).toMatchObject([{ type: 'text_complete', text: 'Partial answer' }]);

      // agent_end with willRetry true (defensive) still completes — aborts
      // must not hold the queue open.
      collect(adapter.adaptEvent({ type: 'agent_end', willRetry: true } as any));
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });

    it('legacy agent_end without willRetry still completes (older SDK payloads)', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({ type: 'message_end', message: terminatedError } as any));

      // No willRetry field (older payload) → treated as terminal.
      const events = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      const errorEvents = events.filter((e) => e.type === 'error' || e.type === 'typed_error');
      expect(errorEvents).toHaveLength(1);
      expect(events[events.length - 1]).toMatchObject({ type: 'complete' });
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });

    it('retryable network errors also defer (typed_error classification preserved)', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // 'fetch failed' is retryable per pi-ai; parseError classifies it as
      // network_error. Both properties must hold: deferred now, typed at terminal.
      const deferred = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'fetch failed' },
      } as any));
      expect(deferred).toHaveLength(0);

      const terminal = collect(adapter.adaptEvent({ type: 'agent_end', willRetry: false } as any));
      expect(terminal[0].type).toBe('typed_error');
      expect((terminal[0] as any).error.code).toBe('network_error');
      expect((terminal[0] as any).error.originalError).toBe('fetch failed');
      expect(terminal[terminal.length - 1]).toMatchObject({ type: 'complete' });
    });

    it('resetOverflowState clears a pending deferred error (stale terminal guard)', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({ type: 'message_end', message: terminatedError } as any));
      collect(adapter.adaptEvent({ type: 'agent_end', willRetry: true } as any));

      // Session torn down before the retry finished — no stale error may
      // leak into the next turn.
      adapter.resetOverflowState();
      const nextTurn = collect(adapter.adaptEvent({ type: 'agent_end', willRetry: false } as any));
      expect(nextTurn.filter((e) => e.type === 'error' || e.type === 'typed_error')).toHaveLength(0);
      expect(nextTurn).toMatchObject([{ type: 'complete' }]);
    });
  });
});
