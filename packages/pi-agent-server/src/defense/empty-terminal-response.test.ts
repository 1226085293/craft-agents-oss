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
 * Fix: anchor strictly on the LAST assistant message and treat the strict
 * triple (stopReason=stop + no content blocks + 0 output tokens) as an
 * infrastructure fault that must trigger an automatic resume.
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
  let lastAssistant: { content?: unknown; stopReason?: string; usage?: { output?: number } } | null = null;
  for (const raw of endMessages) {
    const m = raw as { role?: string; content?: unknown; stopReason?: string; usage?: { output?: number } };
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
  if (lastAssistant) {
    const hasVisibleTextBlock = Array.isArray(lastAssistant.content)
      && lastAssistant.content.some(
        (c) => (c as { type?: string })?.type === 'text'
          && String((c as { text?: unknown }).text ?? '').trim().length > 0,
      );
    const cleanStop = lastAssistant.stopReason === 'stop' || lastAssistant.stopReason === 'length';
    if (lastAssistant.stopReason === 'length') {
      endsWithEmptyResponse = !hasVisibleTextBlock;
    } else {
      const noContentBlocks = !Array.isArray(lastAssistant.content) || lastAssistant.content.length === 0;
      endsWithEmptyResponse = cleanStop && noContentBlocks;
    }
  }
  return evaluator.evaluate({ hasVisibleText: anyText, aborted, endsWithEmptyResponse });
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

  it('does NOT resume when the final message has thinking-only content', () => {
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: 'progress note' }], stopReason: 'toolUse' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }], stopReason: 'stop', usage: { output: 10 } },
    ]);
    expect(result.shouldResume).toBe(false);
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

  it('write-without-readback still resumes independently of the empty-response signal', () => {
    const e = new DefenseEvaluator({ enabled: true });
    e.recordToolCall({ type: 'bash', command: 'rm /tmp/f.txt' }); // bash:write per WRITE_CMDS
    const result = scan(e, [{ role: 'assistant', content: [{ type: 'text', text: 'done writing' }], stopReason: 'stop', usage: { output: 5 } }]);
    expect(result.shouldResume).toBe(true);
    expect(result.resumeMessage).not.toContain('EMPTY response'); // different reason branch
  });
});
