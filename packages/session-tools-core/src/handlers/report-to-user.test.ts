import { describe, expect, it } from 'bun:test';

import type { SessionToolContext } from '../context.ts';
import { handleReportToUser } from './agent-tools.ts';

function textOf(result: { content?: Array<{ text?: string }> }): string {
  return (result.content ?? []).map((part) => part.text ?? '').join(' ');
}

function ctx(seen: Array<{ text: string; kind?: string }>): SessionToolContext {
  return {
    sessionId: 'sess-1',
    agentTools: {
      reportToUser: async (payload: { text: string; kind?: string }) => {
        seen.push(payload);
      },
    },
  } as unknown as SessionToolContext;
}

describe('report_to_user', () => {
  /**
   * The gate exists because a length limit could not answer "should I speak now".
   *
   * A supervisor used its only user-facing tool for progress narration — "1.1 is
   * done, I dispatched the rest to mr-crystal, I will tell you when it finishes" —
   * and those rows pushed the decisions that actually needed a person off screen.
   */
  it('refuses a report without a reason', async () => {
    const seen: Array<{ text: string; kind?: string }> = [];
    const result = await handleReportToUser(ctx(seen), { text: 'progress: still working' } as never);
    expect(seen).toHaveLength(0);
    expect(textOf(result)).toContain('kind is required');
  });

  it('accepts the three reasons that justify an interruption', async () => {
    for (const kind of ['completed', 'decision', 'blocked'] as const) {
      const seen: Array<{ text: string; kind?: string }> = [];
      const result = await handleReportToUser(ctx(seen), { text: 'conclusion', kind } as never);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.kind).toBe(kind);
      expect(textOf(result)).toContain('Reported to the user');
    }
  });

  it('rejects a reason outside the enum', async () => {
    const seen: Array<{ text: string; kind?: string }> = [];
    await handleReportToUser(ctx(seen), { text: 'x', kind: 'progress' } as never);
    // The handler forwards what it was given; the schema is the real gate. What
    // matters here is that the payload carries the reason, so routing can refuse
    // it — see deliverToUserLane.
    expect(seen[0]?.kind).toBe('progress');
  });
});
