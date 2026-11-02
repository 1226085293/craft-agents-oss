import { describe, it, expect } from 'bun:test';
import { handleSendAgentMessage } from './send-agent-message.ts';
import type { SessionToolContext, SendAgentMessageResult } from '../context.ts';

function createCtx(
  result: SendAgentMessageResult,
  opts?: { name?: string },
): { ctx: SessionToolContext; calls: Array<{ sessionId: string; message: string }> } {
  const calls: Array<{ sessionId: string; message: string }> = [];
  const ctx = {
    sessionId: 'sender-1',
    getSessionInfo: () => (opts?.name ? ({ name: opts.name } as never) : null),
    sendAgentMessage: async (sessionId: string, message: string) => {
      calls.push({ sessionId, message });
      return result;
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

describe('handleSendAgentMessage delivery ack', () => {
  it('reports a delivered ack when the target was idle', async () => {
    const { ctx } = createCtx({ delivery: 'delivered', targetBusy: false });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'hi' });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res)).toContain('delivered');
  });

  it('reports a queued (busy) ack when the target was mid-turn', async () => {
    const { ctx } = createCtx({ delivery: 'queued', targetBusy: true });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'status?' });
    expect(res.isError).toBeFalsy();
    const text = JSON.stringify(res);
    expect(text).toContain('queued');
    // Must warn the sender not to assume the message was read yet.
    expect(text.toLowerCase()).toContain('do not assume it was read');
  });

  it('wraps the message with a sender envelope', async () => {
    const { ctx, calls } = createCtx({ delivery: 'delivered', targetBusy: false }, { name: 'Monitor' });
    await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'ping' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.message).toContain('sender-1');
    expect(calls[0]!.message).toContain('ping');
  });

  it('rejects a self-send', async () => {
    const { ctx } = createCtx({ delivery: 'delivered', targetBusy: false });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'sender-1', message: 'loop' });
    expect(res.isError).toBe(true);
  });
});

describe('handleSendAgentMessage session commands', () => {
  /** Mirrors the backend injection: `/stop` is a session command. */
  function asCommandAware(ctx: SessionToolContext): SessionToolContext {
    (ctx as { isSessionCommand?: (text: string) => boolean }).isSessionCommand =
      (text: string) => text.trim().toLowerCase() === '/stop';
    return ctx;
  }

  it('sends a command without the sender envelope', async () => {
    const { ctx, calls } = createCtx({ delivery: 'stopped', targetBusy: true, queueLength: 0 }, { name: 'Monitor' });
    const res = await handleSendAgentMessage(asCommandAware(ctx), { sessionId: 'target-9', message: '/stop' });

    expect(res.isError).toBeFalsy();
    // The token must stay at position 0 or the target parses it as chat text.
    expect(calls[0]!.message).toBe('/stop');
    expect(JSON.stringify(res)).toContain('Stopped');
  });

  it('reports an idle /stop as a no-op instead of claiming success', async () => {
    const { ctx } = createCtx({ delivery: 'idle', targetBusy: false }, { name: 'Monitor' });
    const res = await handleSendAgentMessage(asCommandAware(ctx), { sessionId: 'target-9', message: '/stop' });

    const text = JSON.stringify(res);
    expect(text).toContain('idle');
    expect(text).toContain('nothing was stopped');
  });

  it('warns that queued messages still run after a stop', async () => {
    const { ctx } = createCtx({ delivery: 'stopped', targetBusy: true, queueLength: 2 });
    const res = await handleSendAgentMessage(asCommandAware(ctx), { sessionId: 'target-9', message: '/stop' });

    expect(JSON.stringify(res)).toContain('2 queued message');
  });

  it('keeps the envelope for text that only looks like a command', async () => {
    const { ctx, calls } = createCtx({ delivery: 'delivered', targetBusy: false });
    const res = await handleSendAgentMessage(asCommandAware(ctx), {
      sessionId: 'target-9',
      message: '/stop the old build and restart',
    });

    expect(res.isError).toBeFalsy();
    expect(calls[0]!.message).toContain('Message from session');
  });
});
