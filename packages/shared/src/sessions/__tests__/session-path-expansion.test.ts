import { describe, expect, it } from 'bun:test';
import {
  makeSessionPathPortable,
  expandSessionPath,
  expandSessionPathInMemory,
} from '../jsonl.ts';

const TOKEN = '{{SESSION_PATH}}';

// Windows-style session directory (native separators).
const winSessionDir = 'C:\\Users\\12260\\.craft-agent\\workspaces\\my-workspace\\sessions\\261013-mild-stream';
// Unix-style session directory.
const unixSessionDir = '/home/alice/.craft-agent/workspaces/my-workspace/sessions/261013-mild-stream';

describe('expandSessionPath (raw JSON domain)', () => {
  it('expands Windows tokens to a consistent all-backslash path after JSON.parse', () => {
    // In-memory content the model wrote: native backslashes.
    const content = `${TOKEN}\\plans\\llm-management-redesign.md`;
    const jsonLine = JSON.stringify({ content });

    const expanded = expandSessionPath(jsonLine, winSessionDir);
    const parsed = JSON.parse(expanded) as { content: string };

    expect(parsed.content).toBe(
      'C:\\Users\\12260\\.craft-agent\\workspaces\\my-workspace\\sessions\\261013-mild-stream\\plans\\llm-management-redesign.md'
    );
    // No mixed separators: every separator on Windows is a backslash.
    expect(parsed.content.includes('/')).toBe(false);
  });

  it('round-trips: portable tokenization then expansion restores the native path', () => {
    const content = `Successfully wrote to ${winSessionDir}\\plans\\llm-management-redesign.md`;
    const jsonLine = JSON.stringify({ content });

    const portable = makeSessionPathPortable(jsonLine, winSessionDir);
    expect(portable).toContain(TOKEN);
    expect(portable).not.toContain(winSessionDir);

    const back = JSON.parse(expandSessionPath(portable, winSessionDir)) as { content: string };
    expect(back.content).toBe(content);
  });

  it('expands Unix tokens without any change in separator style', () => {
    const content = `${TOKEN}/plans/llm-management-redesign.md`;
    const jsonLine = JSON.stringify({ content });

    const parsed = JSON.parse(expandSessionPath(jsonLine, unixSessionDir)) as { content: string };
    expect(parsed.content).toBe('/home/alice/.craft-agent/workspaces/my-workspace/sessions/261013-mild-stream/plans/llm-management-redesign.md');
  });

  it('leaves lines without the token untouched', () => {
    const jsonLine = JSON.stringify({ content: 'no tokens here' });
    expect(expandSessionPath(jsonLine, winSessionDir)).toBe(jsonLine);
  });
});

describe('expandSessionPathInMemory (runtime string domain)', () => {
  it('inserts the session dir as-is, keeping native separators', () => {
    const value = `${TOKEN}\\plans\\llm-management-redesign.md`;
    const out = expandSessionPathInMemory(value, winSessionDir);
    expect(out).toBe(
      'C:\\Users\\12260\\.craft-agent\\workspaces\\my-workspace\\sessions\\261013-mild-stream\\plans\\llm-management-redesign.md'
    );
    // No JSON-escaping artifacts (no doubled backslashes).
    expect(out.includes('\\\\')).toBe(false);
  });

  it('leaves values without the token untouched', () => {
    expect(expandSessionPathInMemory('plain path', winSessionDir)).toBe('plain path');
  });
});
