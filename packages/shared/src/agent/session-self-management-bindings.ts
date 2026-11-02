/**
 * Session Self-Management Bindings
 *
 * Attaches the session-scoped tool properties (session management, tasks,
 * messaging, pages) to a SessionToolContext using
 * Object.defineProperty with non-memoized lazy getters. Each access resolves
 * the callback from the session-scoped tool callback registry at call time,
 * so late merges and callback replacements are immediately visible without
 * recreating the context.
 *
 * Used by both the Claude and Pi agent paths to ensure a single binding
 * implementation — the root cause of #511 was that PiAgent's context was
 * missing these bindings entirely.
 *
 * Design rules:
 * - Each getter calls getSessionScopedToolCallbacks() fresh — NO memoization
 * - Returns undefined when the callback is missing — NO no-ops, NO fake data
 * - getSessionInfo is the only field that wraps (for sid ?? sessionId defaulting)
 * - All other fields return the raw registry callback directly (signatures match)
 */

import type { SessionToolContext } from '@craft-agent/session-tools-core';
import { getSessionScopedToolCallbacks } from './session-scoped-tool-callback-registry.ts';

/**
 * Attach session self-management bindings to a SessionToolContext.
 *
 * Defines lazy getters for the session-management callbacks (labels, status,
 * archive, list/info, resolve helpers), messaging, and pages.
 *
 * @param context - The SessionToolContext to augment (mutated in place)
 * @param sessionId - The session ID for registry lookup and getSessionInfo defaulting
 */
export function attachSessionSelfManagementBindings(
  context: SessionToolContext,
  sessionId: string,
): void {
  // Direct pass-through bindings — signatures match, no wrapping needed.
  // Each getter resolves fresh from the registry on every access.

  Object.defineProperty(context, 'archiveSession', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.archiveSessionFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'listSessions', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.listSessionsFn;
    },
    configurable: true,
    enumerable: true,
  });

  // listBackgroundTasks defaults sid → sessionId (like getSessionInfo)
  Object.defineProperty(context, 'listBackgroundTasks', {
    get() {
      const fn = getSessionScopedToolCallbacks(sessionId)?.listBackgroundTasksFn;
      if (!fn) return undefined;
      return (sid?: string) => fn(sid ?? sessionId);
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'getBackgroundTaskOutput', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.getBackgroundTaskOutputFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'stopBackgroundTask', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.stopBackgroundTaskFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'sendAgentMessage', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.sendAgentMessageFn;
    },
    configurable: true,
    enumerable: true,
  });

  // Subscription bindings — follow / unfollow another session's turns.
  Object.defineProperty(context, 'subscribeSessionFn', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.subscribeSessionFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'unsubscribeSessionFn', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.unsubscribeSessionFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'listSubscriptionsFn', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.listSubscriptionsFn;
    },
    configurable: true,
    enumerable: true,
  });

  // Messaging gateway bindings
  Object.defineProperty(context, 'getMessagingBindings', {
    get() {
      const fn = getSessionScopedToolCallbacks(sessionId)?.getMessagingBindingsFn;
      if (!fn) return undefined;
      return (sid: string) => fn(sid ?? sessionId);
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'unbindMessagingChannel', {
    get() {
      const fn = getSessionScopedToolCallbacks(sessionId)?.unbindMessagingChannelFn;
      if (!fn) return undefined;
      return (sid: string, platform?: string) => fn(sid ?? sessionId, platform);
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'deliverFileToMessaging', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.deliverFileToMessagingFn;
    },
    configurable: true,
    enumerable: true,
  });


  Object.defineProperty(context, 'pages', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.pages;
    },
    configurable: true,
    enumerable: true,
  });

  // getSessionInfo needs wrapping to default sid → sessionId
  Object.defineProperty(context, 'getSessionInfo', {
    get() {
      const fn = getSessionScopedToolCallbacks(sessionId)?.getSessionInfoFn;
      if (!fn) return undefined;
      return (sid?: string) => fn(sid ?? sessionId);
    },
    configurable: true,
    enumerable: true,
  });
}
