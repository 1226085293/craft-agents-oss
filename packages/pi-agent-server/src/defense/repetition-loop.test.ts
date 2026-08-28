import { describe, expect, it } from 'bun:test';
import { DefenseEvaluator } from './evaluator.ts';
import { detectRepetitionLoop, extractAssistantText } from './repetition-detector.ts';

/**
 * Regression contract for the 2026-08-28 incident.
 *
 * A session (260828-lively-robin) investigating the session-list scrolling
 * bug ended with a 213,508-character final reply of which ~115K characters
 * (54%) were 874 exact copies of one sentence:
 *   "Let me just search for the function definition. Let me find the file.
 *    Let me search for it. Let me look at the definition."
 *
 * The reply carried visible text, so empty-terminal-response and silent-stop
 * detection both missed it and the stop was classified as normal. Fix: detect
 * a degeneration loop on the FINAL assistant message and treat it as an
 * early-stop signal that must trigger an automatic resume.
 */

const LOOP_SENTENCE =
  'Let me just search for the function definition. Let me find the file. Let me search for it. Let me look at the definition.';

function buildLoopText(repeats = 874): string {
  return Array(repeats).fill(LOOP_SENTENCE).join('\n\n');
}

// ---------- detector unit tests ----------

describe('detectRepetitionLoop (heuristic)', () => {
  it('flags the incident-shaped output (874 repeats, 213K chars)', () => {
    expect(detectRepetitionLoop(buildLoopText())).toBe(true);
  });

  it('flags a smaller but still pathological loop', () => {
    expect(detectRepetitionLoop(buildLoopText(30))).toBe(true);
  });

  it('flags a sentence-level loop with no newlines', () => {
    const text = Array(30).fill(LOOP_SENTENCE).join(' ');
    expect(detectRepetitionLoop(text)).toBe(true);
  });

  it('does NOT flag healthy long prose with unique sentences', () => {
    let text = '';
    for (let i = 0; i < 400; i++) {
      text += `Paragraph ${i} explains a distinct aspect of the scroll fix. The panel resolves the latest session through resolveAutoSelection, then updates the focused route atom synchronously. `;
    }
    expect(text.length).toBeGreaterThan(5000);
    expect(detectRepetitionLoop(text)).toBe(false);
  });

  it('does NOT flag a long code dump with unique lines', () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(`const handler${i} = (ctx: Context, opts: Options) => { return dispatch(ctx, opts, ${i}); };`);
    }
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(1500);
    expect(detectRepetitionLoop(text)).toBe(false);
  });

  it('does NOT flag short output (below the length floor)', () => {
    expect(detectRepetitionLoop(LOOP_SENTENCE.repeat(3))).toBe(false);
  });

  it('does NOT flag outputs with repeated short structural lines', () => {
    // Many identical short closing lines are normal in generated code/tables.
    const text = Array(200).fill('  });').join('\n');
    expect(detectRepetitionLoop(text)).toBe(false);
  });

  // ---- tail-weighted regression tests (2026-08-28 real incident) ----

  it('flags a reply that is half work, half loop at the end (real-incident shape)', () => {
    // Reconstructs the real incident: 84K unique work + 115K loop (57.8%
    // loop of whole — below 60% so Strategy A misses it). The tail (last
    // 50%) is pure loop → Strategy B catches it.
    const work = Array(800)
      .fill(0)
      .map(
        (_, i) =>
          `Investigation step ${i}: verified the navigation flow and route atom updates for the session list panel.`,
      )
      .join('\n');
    const text = work + '\n' + buildLoopText(874);
    expect(text.length).toBeGreaterThan(1500);
    // Strategy A: whole-text line-level should miss
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length >= 40);
    const seen = new Set<string>();
    let dup = 0, total = 0;
    for (const l of lines) { total += l.length; if (seen.has(l)) dup += l.length; else seen.add(l); }
    expect(dup / total).toBeLessThan(0.6); // confirms Strategy A would miss
    expect(detectRepetitionLoop(text)).toBe(true); // but total detector catches it
  });

  it('does NOT flag a reply that is half work, half unique prose at the end', () => {
    // Unique tail (no repeats) → tail ratio stays low → false.
    const work = Array(400).fill(0).map((_, i) => `Analysis step ${i}: verifying the session flow.`).join('\n');
    const tail = Array(400).fill(0).map((_, i) => `Conclusion step ${i}: all checks passed for the route atom.`).join('\n');
    const text = work + '\n' + tail;
    expect(text.length).toBeGreaterThan(1500);
    expect(detectRepetitionLoop(text)).toBe(false);
  });

  it('does NOT flag a reply ending with a long unique code block', () => {
    // Unique analysis followed by a single large code block (not repeated).
    const work = 'Analysis of the session list scroll behavior.\n'.repeat(100);
    const codeBlock = Array(200)
      .fill(0)
      .map((_, i) => `function handleUpdate${i}(ctx: Context) { return dispatch(ctx, { type: 'UPDATE', payload: ${i} }); }`)
      .join('\n');
    const text = work + '\n' + codeBlock;
    expect(text.length).toBeGreaterThan(3000);
    expect(detectRepetitionLoop(text)).toBe(false);
  });

  it('extractAssistantText pulls only text blocks from mixed content', () => {
    const content = [
      { type: 'thinking', thinking: 'hidden' },
      { type: 'text', text: 'visible part one' },
      { type: 'toolCall', id: 'x', name: 'bash', arguments: {} },
      { type: 'text', text: 'visible part two' },
    ];
    expect(extractAssistantText(content)).toBe('visible part one\nvisible part two');
  });
});

// ---------- evaluator integration ----------

/** Build an evaluator primed with a read-only tool chain (like the incident). */
function incidentEvaluator(): DefenseEvaluator {
  const e = new DefenseEvaluator({ enabled: true });
  e.recordToolCall({ type: 'bash', command: 'ls /tmp/project' });
  e.recordToolCall({ type: 'read', output: 'file contents' });
  return e;
}

/** Mirrors the extraction + repetition-detection logic in pi-agent-server/src/index.ts. */
function scan(evaluator: DefenseEvaluator, endMessages: unknown[]) {
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
  const lastText = lastAssistant ? extractAssistantText(lastAssistant.content) : '';
  const hasRepetitionLoop = lastText.length > 0 && detectRepetitionLoop(lastText);
  return evaluator.evaluate({ hasVisibleText: anyText, aborted, endsWithEmptyResponse, hasRepetitionLoop });
}

describe('repetition-loop defense (2026-08-28 incident)', () => {
  it('resumes when the final reply is a degeneration loop despite visible text', () => {
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: '让我继续查看 handleSelectSession 的实现' }], stopReason: 'toolUse' },
      { role: 'toolResult', content: [{ type: 'text', text: 'const handleSelectSession = ...' }] },
      { role: 'assistant', content: [{ type: 'text', text: buildLoopText() }], stopReason: 'stop', usage: { output: 49451 } },
    ]);
    expect(result.shouldResume).toBe(true);
    expect(result.resumeMessage).toContain('REPETITION LOOP');
  });

  it('does NOT resume on a healthy long final reply', () => {
    const e = incidentEvaluator();
    const healthy = Array(300)
      .fill(0)
      .map((_, i) => `Step ${i} verified a distinct aspect of the navigation flow and confirmed the route atom updates synchronously.`)
      .join(' ');
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: 'checking next step' }], stopReason: 'toolUse' },
      { role: 'assistant', content: [{ type: 'text', text: healthy }], stopReason: 'stop', usage: { output: 6000 } },
    ]);
    expect(result.shouldResume).toBe(false);
    expect(result.state).toBe('done');
  });

  it('does NOT resume after a user abort even if the reply was a loop', () => {
    const e = incidentEvaluator();
    const result = scan(e, [
      { role: 'assistant', content: [{ type: 'text', text: 'working...' }], stopReason: 'toolUse' },
      { role: 'assistant', content: [{ type: 'text', text: buildLoopText() }], stopReason: 'aborted', usage: { output: 1000 } },
    ]);
    expect(result.shouldResume).toBe(false);
  });

  it('guardrail: consecutive identical loop stops fail instead of looping forever', () => {
    const e = incidentEvaluator();
    const first = scan(e, [{ role: 'assistant', content: [{ type: 'text', text: buildLoopText() }], stopReason: 'stop', usage: { output: 5000 } }]);
    expect(first.shouldResume).toBe(true);

    // Simulate the resumed turn stopping with a loop again (same context).
    e.recordToolCall({ type: 'bash', command: 'ls /tmp/project' });
    e.recordToolCall({ type: 'read', output: 'file contents' });
    const second = scan(e, [{ role: 'assistant', content: [{ type: 'text', text: buildLoopText() }], stopReason: 'stop', usage: { output: 5000 } }]);
    expect(second.shouldResume).toBe(false);
    expect(second.state).toBe('failed');
  });

  it('empty-response and repetition-loop signals are independent branches', () => {
    // A loop reply must NOT be conflated with the empty-response message.
    const e = incidentEvaluator();
    const result = scan(e, [{ role: 'assistant', content: [{ type: 'text', text: buildLoopText() }], stopReason: 'stop', usage: { output: 5000 } }]);
    expect(result.resumeMessage).toContain('REPETITION LOOP');
    expect(result.resumeMessage).not.toContain('EMPTY response');
  });
});
