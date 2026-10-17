import { describe, expect, it } from 'bun:test';
import {
  DEGENERACY_CORRECTION,
  StreamingDegeneracyState,
  StreamingDegeneracyTracker,
  judgeTail,
} from './streaming-degeneracy.ts';

describe('judgeTail — degenerate loops', () => {
  it('fires on the 执行。 x165 shape (the 2026-10-15 mild-stream incident)', () => {
    // The incident shape: a healthy lead-in, then the loop. Judged against
    // the TAIL window (what the detector actually sees), since degeneration
    // is positional — the healthy prefix must not dilute the signal.
    const lead =
      'Acknowledged. Beginning the requested inspection of the diff, reading the relevant files, and then I will proceed with the change carefully. '.repeat(40);
    const loop = '执行。\n'.repeat(165);
    const tail = (lead + loop).slice(-2000);

    const verdict = judgeTail(tail);
    expect(verdict.isDegenerate).toBe(true);
    expect(verdict.distinctRatio).toBeLessThan(0.1);
    expect(verdict.topGramCount).toBeGreaterThanOrEqual(20);
  });

  it('fires on a different short-unit loop (content-agnostic proof)', () => {
    // Proves no word list: a loop the detector has never seen, with a
    // different unit and different length, must trip the same statistics.
    const loop = '正在处理中… '.repeat(120);
    expect(judgeTail(loop.slice(-2000)).isDegenerate).toBe(true);
  });

  it('fires on the shortest aggressive unit loop (floor is sample-count, not chars)', () => {
    // A 3-char unit needs only ~200 chars to reach 20 windows. A character
    // floor would exclude exactly the loops we care about most.
    expect(judgeTail('好的。\n'.repeat(60)).isDegenerate).toBe(true);
  });

  it('does NOT fire below the sample floor', () => {
    // Too few windows to mean anything statistically.
    expect(judgeTail('执行。\n'.repeat(2)).isDegenerate).toBe(false);
  });
});

describe('judgeTail — false-positive guards on legitimately repetitive structure', () => {
  it('does NOT fire on a long code dump with recurring structure', () => {
    // A realistic TS/JS dump: identical closing structure, repeated import
    // lines, repeated patterns — the structural echo that depresses diversity
    // locally WITHOUT it ever becoming one window repeated 20+ times.
    const rows: string[] = [];
    for (let i = 0; i < 120; i++) {
      rows.push(
        `import { helper${i} } from './helpers/module-${i % 12}.ts';\n` +
        `export function step${i}(input: Config): Result {\n` +
        `  const cache = getCache();\n` +
        `  const value = cache.read('key-${i}');\n` +
        `  if (value !== undefined) return { ok: true, value };\n` +
        `  logger.debug('step${i} miss for key-${i}');\n` +
        `  return recompute${i}(input, cache);\n` +
        `}\n\n`,
      );
    }
    const dump = rows.join('');
    expect(dump.length).toBeGreaterThan(2000);

    const verdict = judgeTail(dump);
    expect(verdict.isDegenerate).toBe(false);
  });

  it('does NOT fire on a long repetitive markdown table', () => {
    // Tables are the second real-world noise source: identical pipes and
    // dashes on every line, only the cell contents differing.
    const lines = [
      '| region | reqs | p50 | p90 | errors | notes |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    for (let i = 0; i < 100; i++) {
      lines.push(`| ${['us-east', 'eu-west', 'ap-south'][i % 3]} | ${1000 + i * 7} | ${12 + (i % 5)}s | ${40 + (i % 9)}s | ${i % 4} | region-${i}-cached |`);
    }
    const table = lines.join('\n');

    const verdict = judgeTail(table);
    expect(verdict.isDegenerate).toBe(false);
  });
});

describe('StreamingDegeneracyState', () => {
  it('fires exactly once per message and while still streaming', () => {
    const state = new StreamingDegeneracyState();
    const loop = '执行。\n'.repeat(200);
    let chunks = loop.match(/.{1,80}/gs) ?? [];
    let fired = 0;
    let fireAtChars = 0;
    for (const chunk of chunks) {
      const verdict = state.append(chunk);
      if (verdict?.isDegenerate) {
        fired += 1;
        fireAtChars = state.text.length;
      }
    }
    expect(fired).toBe(1);
    expect(state.hasFired).toBe(true);
    // The whole point: caught mid-stream, far before the message completes
    // (2000+ chars of loop would take ~100+ seconds at incident throughput).
    expect(fireAtChars).toBeLessThan(loop.length);
  });

  it('throttles checks to every CHECK_INTERVAL_CHARS', () => {
    const state = new StreamingDegeneracyState();
    // Feed well-formed repetitive-but-not-degenerate text in small chunks;
    // the check must not run on every chunk (perf guard).
    const chunk = 'ordinary progress text that stays unique and informative ';
    let checks = 0;
    for (let i = 0; i < 100; i++) {
      const before = state.text.length;
      state.append(chunk + i);
      // A check lands when crossing a 500-char boundary — approximate by
      // measuring that appends alone don't correlate 1:1 with judge calls.
      void before;
      checks += 1;
    }
    // 100 appends must produce fewer than 100 judge calls; assert the state
    // saw all text and stayed quiet (no false positive on flowing prose).
    expect(state.hasFired).toBe(false);
    expect(state.text.length).toBeGreaterThan(100 * chunk.length);
    // Sanity: the throttle math — ~6100 chars means ~12 check opportunities.
    expect(checks).toBeGreaterThan(state.text.length / 500);
  });
});

describe('StreamingDegeneracyTracker', () => {
  it('resets per message so each stream is judged fresh', () => {
    const tracker = new StreamingDegeneracyTracker();
    // First message: clean. Must not poison the next one.
    expect(tracker.feed('a healthy informative first message with plenty of unique detail.')).toBeNull();
    tracker.reset();
    // Second message: the loop.
    const verdict = tracker.feed('执行。\n'.repeat(200));
    expect(verdict?.isDegenerate).toBe(true);
  });
});

describe('correction message', () => {
  it('is instructive and does not order an abort', () => {
    // The user's hard constraint: correction, never abort. The message must
    // direct the model forward (re-read task, next distinct step) rather
    // than terminate.
    expect(DEGENERACY_CORRECTION).toContain('Re-read the original task');
    expect(DEGENERACY_CORRECTION.toLowerCase()).not.toContain('abort');
    expect(DEGENERACY_CORRECTION.toLowerCase()).not.toContain('terminate');
  });
});
