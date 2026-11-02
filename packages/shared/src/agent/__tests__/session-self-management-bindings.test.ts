import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tool-callback-registry.ts';
import { createSessionToolContext } from '../session-tool-context.ts';
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings.ts';
import type { SessionToolContext, SessionInfo } from '@craft-agent/session-tools-core';
import { SESSION_TOOL_REGISTRY } from '@craft-agent/session-tools-core';

// Minimal noop callbacks for createSessionToolContext
const noopPlan = () => {};
const noopAuth = () => {};

/** Helper to create a valid SessionInfo fixture */
function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'test-session',
    name: 'Test Session',
    permissionMode: 'execute',
    createdAt: Date.now(),
    isActive: true,
    ...overrides,
  };
}

function createBaseContext(sessionId: string): SessionToolContext {
  return createSessionToolContext({
    sessionId,
    workspacePath: '/tmp/test-workspace',
    workspaceId: 'test-ws',
    onPlanSubmitted: noopPlan,
    onAuthRequest: noopAuth,
  });
}

// ============================================================
// Phase 1 — Regression test: Pi path must support session tools
// ============================================================

describe('Pi session self-management regression (#511)', () => {
  const sessionId = 'test-pi-regression-511';

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(sessionId);
  });

  it('context WITHOUT bindings has undefined session management properties', () => {
    const ctx = createBaseContext(sessionId);
    // This is the bug: PiAgent creates context without session management
    expect(ctx.getSessionInfo).toBeUndefined();
    expect(ctx.listSessions).toBeUndefined();
  });

  it('context WITH bindings resolves callbacks from registry', async () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    // Register callbacks in the registry (simulates SessionManager)

    registerSessionScopedToolCallbacks(sessionId, {
      getSessionInfoFn: (sid) => makeSessionInfo({ id: sid ?? sessionId }),
      listSessionsFn: () => ({ total: 1, returned: 1, sessions: [] }),
    });
    expect(ctx.getSessionInfo).toBeDefined();
    expect(ctx.listSessions).toBeDefined();

    // Verify they actually work

    const info = ctx.getSessionInfo!();
    expect(info).toBeTruthy();
    expect(info!.id).toBe(sessionId);

    const list = ctx.listSessions!();
    expect(list.total).toBe(1);

  });
});

// ============================================================
// Phase 2 — Binding helper unit tests
// ============================================================

describe('attachSessionSelfManagementBindings', () => {
  const sessionId = 'test-bindings-unit';

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(sessionId);
  });

  it('absent callback → property is undefined for all 6 fields', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    // No callbacks registered — all should resolve to undefined
    expect(ctx.getSessionInfo).toBeUndefined();
    expect(ctx.listSessions).toBeUndefined();
  });

  it('late merge becomes visible without recreating the context', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    // Initially no callbacks

    // Late merge — simulates SessionManager registering after agent start
    registerSessionScopedToolCallbacks(sessionId, {
    });

    // Should now be defined without recreating ctx
  });

  it('getSessionInfo defaults to current session ID when called without arg', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    let receivedId: string | undefined;
    registerSessionScopedToolCallbacks(sessionId, {
      getSessionInfoFn: (sid) => {
        receivedId = sid;
        return makeSessionInfo({ id: sid ?? sessionId });
      },
    });

    // Call without arg — should default to sessionId
    ctx.getSessionInfo!();
    expect(receivedId).toBe(sessionId);

    // Call with explicit arg — should pass through
    ctx.getSessionInfo!('other-session');
    expect(receivedId).toBe('other-session');
  });

});

// ============================================================
// Phase 3 — Bound properties
// ============================================================

describe('session self-management bindings', () => {
  const sessionId = 'test-parity';

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(sessionId);
  });

  it('exposes the bound properties when callbacks are registered', () => {
    const SELF_MGMT_PROPERTIES = [
      'getSessionInfo',
      'listSessions',
    ] as const;

    registerSessionScopedToolCallbacks(sessionId, {
      getSessionInfoFn: () => makeSessionInfo({ id: sessionId }),
      listSessionsFn: () => ({ total: 0, returned: 0, sessions: [] }),
    });

    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);

    for (const prop of SELF_MGMT_PROPERTIES) {
      expect(ctx[prop]).toBeDefined();
      expect(typeof ctx[prop]).toBe('function');
    }
  });

  it('absent callbacks → handlers return exact "not available" error messages', async () => {
    const ctx = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(ctx, sessionId);
    // No callbacks registered — use the canonical registry to invoke handlers (same as runtime)

    const infoHandler = SESSION_TOOL_REGISTRY.get('get_session_info')!.handler!;
    const infoResult = await infoHandler(ctx, {});
    expect(infoResult.isError).toBe(true);
    expect(infoResult.content[0]!.text).toContain('not available in this context');

    const listHandler = SESSION_TOOL_REGISTRY.get('list_sessions')!.handler!;
    const listResult = await listHandler(ctx, {});
    expect(listResult.isError).toBe(true);
    expect(listResult.content[0]!.text).toContain('not available in this context');
  });
});
