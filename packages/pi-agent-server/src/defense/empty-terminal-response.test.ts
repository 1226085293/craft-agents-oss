import { describe, expect, it } from 'bun:test';
import { DefenseEvaluator } from './evaluator.ts';

/**
 * Regression contract for the 2026-08-22 incident.
 *
 * A session investigating the defense module itself died silently: its final
 * model call returned an EMPTY completion (content=[], stopReason="stop",
 * usage.output=0) from the upstream gateway. The run-wide silent-stop scan
 * saw earlier progress text (`anyText=true`) and classified the stop as
 * normal — no resume, user left hanging.
 *
 * Fix: anchor strictly on the LAST assistant message and treat any clean
 * stop (stopReason=stop|length) whose final message carries NO visible text
 * block as a fault that must trigger an automatic resume — empty content,
 * or thinking-only content (thinking blocks are invisible to the user).
 *
 * 2026-10-01 incidents (261001-ready-sunset / 261001-calm-pond): both
 * sessions ended with a CLEAN stop whose final assistant message carried
 * ONLY a thinking block (output=363 / 1442, zero visible text). The old
 * rule "thinking-only + stop is a deliberate finish" let them pass as
 * state=done — the user saw a progress note and then nothing.
 */

/** Build an evaluator primed with a read-only tool chain (like the incident). */
function incidentEvaluator(): DefenseEvaluator {
  const e = new DefenseEvaluator({ enabled: true });
  e.recordToolCall({ type: 'bash', command: 'ls /tmp/project' });
  e.recordToolCall({ type: 'read' , output: 'file contents' });
  return e;
}

const EMPTY_FINAL = { role: 'assistant', content: [], stopReason: 'stop', usage: { output: 0 } };

function scan(evaluator: DefenseEvaluator, endMessages: unknown[]) {
  // Mirrors the extraction logic in pi-agent-server/src/index.ts.
  let anyText = false;
  let aborted = false;
  let lastAssistant: { content?: unknown; stopReason?: string; usage?: { output?: number }; errorMessage?: string } | null = null;
  for (const raw of endMessages) {
    const m = raw as { role?: string; content?: unknown; stopReason?: string; usage?: { output?: number }; errorMessage?: string };
    if (m?.role !== 'assistant') continue;
    lastAssistant = m;
    if (m.stopReason === 'aborted') aborted = true;
    if (Array.isArray(m.content)) {
      const hasText = m.content.some(
        (c) => (c as { type?: string })?.type === 'text' && String((c as { text?: string }).text ?? '').trim().length > 0,
      );
      if (hasText) anyText = true;
    }
  }
  let endsWithEmptyResponse = false;
  let truncatedFinal = false;
  if (lastAssistant) {
    const hasVisibleTextBlock = Array.isArray(lastAssistant.content)
      && lastAssistant.content.some(
        (c) => (c as { type?: string })?.type === 'text'
          && String((c as { text?: unknown }).text ?? '').trim().length > 0,
      );
    const cleanStop = lastAssistant.stopReason === 'stop' || lastAssistant.stopReason === 'length';
    // ANY clean stop without a visible text block in the final message is
    // an empty delivery (empty content OR thinking-only content).
    endsWithEmptyResponse = cleanStop && !hasVisibleTextBlock;
    // Mirrors pi-agent-server/src/index.ts: a max_tokens truncation
    // (stopReason='length') cuts the final off — including the partial-text
    // case that endsWithEmptyResponse cannot see (it needs NO visible block).
    truncatedFinal = lastAssistant.stopReason === 'length';
  }
  const hasFinalText = !!lastAssistant
    && (lastAssistant.stopReason === 'stop' || lastAssistant.stopReason === 'length')
    && Array.isArray(lastAssistant.content)
    && lastAssistant.content.some(
      (c) => (c as { type?: string })?.type === 'text'
        && String((c as { text?: unknown }).text ?? '').trim().length > 0,
    );
  return evaluator.evaluate({
    hasVisibleText: anyText,
    hasFinalText,
    stopReason: lastAssistant?.stopReason,
    aborted,
    endsWithEmptyResponse,
    truncatedFinal,
  });
}

describe('empty terminal response defense (2026-08-22 incidents)', () => {
  it('resumes when the final message is an empty completion despite earlier visible text', () => {
    // Incident #1: progress text mid-run, then an empty final reply (stop + 0 tokens).
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: '继续查看 followUp 实现' }], stopReason: 'toolUse' },
      { role: 'toolResult', content: [{ type: 'text', text: '81: _followUpMessages...' }] },
      EMPTY_FINAL,
    ]);
    expect(result.shouldResume).toBe(true);
    expect(result.resumeMessage).toContain('EMPTY response');
  });

  it('resumes when reasoning burns the whole budget (stopReason=length, empty content)', () => {
    // Incident #2: 8192 output tokens all consumed by invisible reasoning →
    // finish_reason=length with NO visible content blocks.
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: '最后查一下 Windows UI 相关的提交' }], stopReason: 'toolUse' },
      { role: 'toolResult', content: [{ type: 'text', text: 'feature-flags.ts...' }] },
      { role: 'assistant', content: [], stopReason: 'length', usage: { input: 680, output: 8192 } },
    ]);
    expect(result.shouldResume).toBe(true);
    expect(result.resumeMessage).toContain('EMPTY response');
  });

  it('resumes when reasoning burns the budget invisibly (stopReason=length, thinking-only content)', () => {
    // 2026-08-28 incident: the final assistant message carried ONLY a
    // thinking block (content.length===1) so the old no-blocks check
    // missed it entirely. With stopReason=length the budget died before
    // any visible text was emitted — an infrastructure fault that must
    // trigger an automatic resume.
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: '让我检查关键前提' }], stopReason: 'toolUse' },
      { role: 'toolResult', content: [{ type: 'text', text: 'messageCount: number' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'OK so the sessionMetaMapAtom is populated with messageCount...' }], stopReason: 'length', usage: { input: 108881, output: 0 } },
    ]);
    expect(result.shouldResume).toBe(true);
    expect(result.resumeMessage).toContain('EMPTY response');
  });

  it('does NOT resume on a healthy short final reply', () => {
    const e = incidentEvaluator();
    const result = scan(e, [EMPTY_FINAL, { role: 'assistant', content: [{ type: 'text', text: '完成。' }], stopReason: 'stop', usage: { output: 3 } }]);
    expect(result.shouldResume).toBe(false);
    expect(result.state).toBe('done');
  });

  it('does NOT resume when the final message carries tool calls (loop continues)', () => {
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: 'checking next step' }], stopReason: 'toolUse' },
      { role: 'assistant', content: [], stopReason: 'stop', usage: { output: 0 } },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'bash', arguments: {} }], stopReason: 'toolUse', usage: { output: 42 } },
    ]);
    expect(result.shouldResume).toBe(false);
  });

  it('resumes when the final message is thinking-only on a clean stop (2026-10-01 incidents)', () => {
    // 261001-ready-sunset (out=363) / 261001-calm-pond (out=1442): a
    // stopReason="stop" whose final message carries ONLY a thinking block.
    // The thinking block is invisible to the user, so the delivery is
    // empty and must trigger a resume — the old "deliberate reasoning-only
    // finish" rule hung real sessions.
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: 'progress note' }], stopReason: 'toolUse' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }], stopReason: 'stop', usage: { output: 1442 } },
    ]);
    expect(result.shouldResume).toBe(true);
    expect(result.resumeMessage).toContain('EMPTY response');
  });

  it('does NOT resume after a user abort even if the final reply was empty', () => {
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: 'working...' }], stopReason: 'toolUse' },
      { role: 'assistant', content: [], stopReason: 'aborted', usage: { output: 0 } },
    ]);
    expect(result.shouldResume).toBe(false);
  });

  it('treats empty content with missing usage as pathological (provider omitted usage)', () => {
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: 'step 1 done' }], stopReason: 'toolUse' },
      { role: 'assistant', content: [], stopReason: 'stop' },
    ]);
    expect(result.shouldResume).toBe(true);
  });

  it('guardrail: consecutive identical empty-response stops fail instead of looping forever', () => {
    const e = incidentEvaluator();
    const first = scan(e, [EMPTY_FINAL]);
    expect(first.shouldResume).toBe(true);

    // Simulate the resumed turn stopping empty again (same context hash).
    e.recordToolCall({ type: 'bash', command: 'ls /tmp/project' });
    e.recordToolCall({ type: 'read', output: 'file contents' });
    const second = scan(e, [EMPTY_FINAL]);
    expect(second.shouldResume).toBe(false);
    expect(second.state).toBe('failed');
  });

  it('backward compatible: legacy two-field payload still works (no empty signal)', () => {
    const e = new DefenseEvaluator({ enabled: true });
    const result = e.evaluate({ hasVisibleText: true, aborted: false });
    expect(result.shouldResume).toBe(false);
  });

  it('a lone write (rm) on a short turn no longer routes to verification (S1 removed)', () => {
    const e = new DefenseEvaluator({ enabled: true });
    e.recordToolCall({ type: 'bash', command: 'rm /tmp/f.txt' }); // bash:write per WRITE_CMDS
    const result = scan(e, [{ role: 'assistant', content: [{ type: 'text', text: 'done writing' }], stopReason: 'stop', usage: { output: 5 } }]);
    // The write-without-readback signal is gone: only a forced long turn
    // reaches the verification class now. A short write-only turn with a
    // clean final reply is delivered as-is — no verification, no resume.
    expect(result.shouldResume).toBe(false);
    expect(result.verifyRequired).not.toBe(true);
  });

  it('a long turn without a final visible reply resumes without entering verification', () => {
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1 });
    e.recordToolCall({ type: 'read' });
    const result = scan(e, [{
      role: 'assistant',
      content: [{ type: 'text', text: 'Checking the final item.' }, { type: 'toolCall', name: 'read' }],
      stopReason: 'toolUse',
    }]);
    expect(result.verifyRequired).not.toBe(true);
    expect(result.shouldResume).toBe(true);
  });

  it('does not evaluate an upstream assistant error as a verification candidate', () => {
    const e = new DefenseEvaluator({ enabled: true, verifyMinSteps: 1 });
    e.recordToolCall({ type: 'bash', command: 'rm /tmp/f.txt' });
    const result = scan(e, [{
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'stream disconnected before completion',
    }]);
    expect(result.verifyRequired).not.toBe(true);
    expect(result.shouldResume).toBe(false);
    expect(result.evaluated).toBe(false);
  });
});

/**
 * Regression contract for the 2026-10-01 truncated-but-non-empty incident
 * (261001-active-eclipse): a final assistant reply hit the max_tokens cap
 * (stopReason='length') AFTER emitting partial visible text, so it was cut
 * off mid-sentence (`...用户要的是"连`) and delivered as-is. The old 5
 * signals all read false for it — endsWithEmptyResponse needs NO visible
 * block, the write signals need a write — so the truncation went unseen.
 * Fix: stopReason='length' is now a standalone early-stop signal.
 */
describe('truncated-but-non-empty final (2026-10-01 incident)', () => {
  it('resumes when a final reply hit max_tokens (length) with partial visible text', () => {
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: '让我检查关键前提' }], stopReason: 'toolUse' },
      { role: 'toolResult', content: [{ type: 'text', text: 'line 42: ...' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '真相大白。日志 12:56:34…用户要的是"连' }],
        stopReason: 'length',
        usage: { input: 4000, output: 8192 },
      },
    ]);
    expect(result.shouldResume).toBe(true);
    expect(result.resumeMessage).toContain('CUT OFF by the output token limit');
    expect(result.reason).toContain('truncatedFinal');
  });

  it('does NOT flag a healthy stop final (no truncation) with visible text', () => {
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: '分析完成，结论如下：' }], stopReason: 'stop', usage: { output: 120 } },
    ]);
    expect(result.shouldResume).toBe(false);
    expect(result.state).toBe('done');
  });

  it('does NOT resume after a user abort even when the final was truncated', () => {
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: '好的，我来看看这个问题。' }], stopReason: 'stop', usage: { output: 50 } },
      { role: 'assistant', content: [{ type: 'text', text: '继续…用户要的是"' }], stopReason: 'aborted', usage: { output: 30 } },
    ]);
    expect(result.shouldResume).toBe(false);
  });
});
