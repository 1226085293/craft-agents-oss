import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  };
}

/**
 * Drain-owned recovery handoff (2026-10-13, session 261008-plain-stag).
 *
 * Regression: an agent_end annotated queuedFollowUpPending=true means the
 * subprocess drains the queued guidance ITSELF (scheduleQueuedFollowUpDrain
 * → agent.continue()). The ladder's pending retry fired into that drain,
 * collided ("Agent is already processing"), and the subprocess' busy-abort
 * stamped an empty stopReason='aborted' step the whitelist refused forever —
 * the turn wedged on "Cannot retry: the current turn has no re-runnable model
 * step." with the ladder looping in the background at its rung schedule.
 *
 * Fix contract:
 *  1. agent_end(queuedFollowUpPending=true) while the ladder is active and
 *     nothing re-issued (retryResendAt===0) CANCELS the pending retry timer.
 *  2. It sets retryDrainPending = true (recovery owned by the drain).
 *  3. The drain's model events (message_update / tool_execution_start) are
 *     as live as Spontaneous recovery — they settle the row as recovered,
 *     mark the run live, and clear the drain marker.
 *  4. A re-armed ladder (new failure) RESETS retryDrainPending.
 */

function primeLadder(agent: PiAgent): void {
  (agent as any)._isProcessing = true;
  (agent as any).subprocess = { kill: () => {} };
  const armed = (agent as any).tryBeginRetryLadder('Upstream SSE protocol error', null);
  expect(armed).toBe(true);
}

function sendEvent(agent: PiAgent, event: Record<string, unknown>): void {
  (agent as any).handleLine(JSON.stringify({ type: 'event', event }));
}

describe('retry drain handoff (2026-10-13 261008-plain-stag)', () => {
  it('agent_end(queuedFollowUpPending) cancels the pending retry timer and marks drain ownership', () => {
    const agent = new PiAgent(createConfig());
    primeLadder(agent);

    // The backoff scheduled a fire (retryTimer non-null, nothing re-issued).
    expect((agent as any).retryTimer).not.toBeNull();
    expect((agent as any).retryResendAt).toBe(0);
    expect((agent as any).retryLadder.isActive).toBe(true);

    sendEvent(agent, { type: 'agent_end', queuedFollowUpPending: true, defenseVerificationPending: false });

    expect((agent as any).retryTimer).toBeNull();
    expect((agent as any).retryDrainPending).toBe(true);
    // The 'had error' marker is dropped so the drain's successful agent_end
    // completes the queue (the Spontaneous-recovery branch semantics).
    expect((agent as any).retryRunHadError).toBe(false);

    agent.destroy();
  });

  it('drain model progress settles the row as recovered and clears the drain marker', () => {
    const agent = new PiAgent(createConfig());
    primeLadder(agent);

    // Cancel the pending retry first (the queuedFollowUpPending agent_end).
    sendEvent(agent, { type: 'agent_end', queuedFollowUpPending: true });
    expect((agent as any).retryDrainPending).toBe(true);

    // Drain's model progress: a tool_execution_start proves the model is
    // running AND survives the PiEventAdapter's shape validation.
    sendEvent(agent, {
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'call_drain_progress_1',
      toolMetadata: { intent: 'Drain progress', displayName: 'Drain Progress' },
      input: { command: 'echo drained' },
    } as any);

    expect((agent as any).retryDrainPending).toBe(false);
    expect((agent as any).retryRunLive).toBe(true);
    expect((agent as any).retryRunHadError).toBe(false);
    // The row was soft-settled as recovered (idempotent with agent_end later).
    expect((agent as any).retryRunSettledAsRecovered).toBe(true);

    agent.destroy();
  });

  it('a re-armed ladder resets retryDrainPending (new failure = new recovery)', () => {
    const agent = new PiAgent(createConfig());
    primeLadder(agent);
    sendEvent(agent, { type: 'agent_end', queuedFollowUpPending: true });
    expect((agent as any).retryDrainPending).toBe(true);

    // A NEW failure arrives: the error handler re-arms the ladder.
    const rearmed = (agent as any).tryBeginRetryLadder('Upstream SSE protocol error again', null);
    expect(rearmed).toBe(true);
    expect((agent as any).retryDrainPending).toBe(false);

    agent.destroy();
  });

  it('agent_end WITHOUT queuedFollowUpPending does not touch a pending retry', () => {
    const agent = new PiAgent(createConfig());
    primeLadder(agent);

    sendEvent(agent, { type: 'agent_end', queuedFollowUpPending: false });

    // No handoff: the pending retry stays scheduled, drain marker stays off.
    expect((agent as any).retryTimer).not.toBeNull();
    expect((agent as any).retryDrainPending).toBe(false);

    agent.destroy();
  });

  it('agent_end(queuedFollowUpPending) does NOT cancel an already re-issued retry (in-flight mirror case)', () => {
    const agent = new PiAgent(createConfig());
    primeLadder(agent);

    // Simulate a retry already fired: retryResendAt set, run not yet live.
    (agent as any).retryResendAt = Date.now();
    (agent as any).clearRetryTimer();

    sendEvent(agent, { type: 'agent_end', queuedFollowUpPending: true });

    // The in-flight retry owns recovery; drain marker is NOT set (P0/P1 on
    // the subprocess side defer instead of aborting that collision).
    expect((agent as any).retryDrainPending).toBe(false);
    expect((agent as any).retryRunHadError).toBe(true);

    agent.destroy();
  });
});
