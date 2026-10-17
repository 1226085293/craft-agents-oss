import { describe, expect, it } from 'bun:test';
import { resolveToolTimeoutMs, withToolExecutionTimeout } from '../tool-timeouts.ts';

/**
 * 2026-10-18: the main process must never await a proxy tool unbounded.
 * `browser_tool` is the shortest budget (CDP calls are expected in ms);
 * Bash/call_llm keep long budgets; an explicit `args.timeout` (seconds) wins
 * with a 60s host round-trip grace.
 */
describe('resolveToolTimeoutMs', () => {
  it('browser_tool gets the short budget', () => {
    expect(resolveToolTimeoutMs('mcp__session__call_tool', { name: 'browser_tool' })).toBe(60_000);
  });

  it('generic MCP/session tools get the default budget', () => {
    expect(resolveToolTimeoutMs('mcp__foo__bar', {})).toBe(120_000);
    expect(resolveToolTimeoutMs('mcp__session__call_tool', { name: 'tools_agent' })).toBe(120_000);
  });

  it('Bash honors args.timeout (seconds) plus the host grace', () => {
    expect(resolveToolTimeoutMs('Bash', { timeout: 30 })).toBe(90_000);
  });

  it('Bash without an explicit timeout keeps the long default', () => {
    expect(resolveToolTimeoutMs('Bash', {})).toBe(600_000);
  });

  it('call_llm keeps a long budget', () => {
    expect(resolveToolTimeoutMs('call_llm', {})).toBe(300_000);
  });

  it('explicit timeout overrides a short tool default', () => {
    expect(resolveToolTimeoutMs('mcp__session__call_tool', { name: 'browser_tool', timeout: 120 })).toBe(180_000);
  });

  it('honors a nested call_tool timeout', () => {
    expect(resolveToolTimeoutMs('mcp__session__call_tool', { name: 'browser_tool', args: { timeout: 30 } })).toBe(90_000);
  });

  it('ignores invalid explicit timeouts', () => {
    expect(resolveToolTimeoutMs('Bash', { timeout: -1 })).toBe(600_000);
    expect(resolveToolTimeoutMs('Bash', { timeout: '30' })).toBe(600_000);
  });
});


describe('withToolExecutionTimeout', () => {
  it('resolves a tool that settles within the budget', async () => {
    await expect(withToolExecutionTimeout(Promise.resolve('ok'), 1_000, 'Bash')).resolves.toBe('ok');
  });

  it('rejects a hung tool at the budget instead of waiting forever', async () => {
    const never = new Promise<never>(() => {});
    await expect(withToolExecutionTimeout(never, 20, 'Bash')).rejects.toThrow(/timed out after/);
  });

  it('clears the timer after a fast settlement (no late rejection)', async () => {
    await expect(withToolExecutionTimeout(Promise.resolve(1), 20, 'Bash')).resolves.toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
});
