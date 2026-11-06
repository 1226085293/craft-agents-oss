import { describe, expect, it } from 'bun:test';

import {
  canStartAnother,
  machineConcurrency,
  resolveConcurrency,
  WORKERS_PER_CORE,
} from '../concurrency.ts';

describe('concurrency governor', () => {
  it('is unlimited when nothing is configured', () => {
    const verdict = resolveConcurrency({ cpuCount: 8 });
    expect(verdict.limit).toBe(Number.POSITIVE_INFINITY);
    expect(verdict.source).toBe('none');
    expect(verdict.reason).toContain('未配置');
  });

  it('uses the provider limit when the model declares one', () => {
    // One key allows 4 in-flight requests; the box can host 16.
    const verdict = resolveConcurrency({ modelConcurrency: 4, usableKeys: 1, cpuCount: 8 });
    expect(verdict.limit).toBe(4);
    expect(verdict.source).toBe('model');
  });

  it('multiplies by the keys the strategy can use', () => {
    const verdict = resolveConcurrency({ modelConcurrency: 2, usableKeys: 3, cpuCount: 32 });
    expect(verdict.limit).toBe(6);
  });

  it('lets the machine win when it is the tighter limit', () => {
    const verdict = resolveConcurrency({ modelConcurrency: 100, usableKeys: 1, cpuCount: 2 });
    expect(verdict.source).toBe('machine');
    expect(verdict.limit).toBe(2 * WORKERS_PER_CORE);
  });

  it('backs off as load rises', () => {
    expect(machineConcurrency(8, 0)).toBe(16);
    expect(machineConcurrency(8, 5)).toBe(8); // half loaded → one per core
    expect(machineConcurrency(8, 9)).toBe(4); // saturated → half the cores
  });

  it('honours an explicit override above everything', () => {
    const verdict = resolveConcurrency({
      modelConcurrency: 1,
      usableKeys: 1,
      cpuCount: 2,
      configured: 10,
    });
    expect(verdict.limit).toBe(10);
    expect(verdict.reason).toContain('手动');
  });

  it('treats a zero or negative provider limit as "no limit declared"', () => {
    expect(resolveConcurrency({ modelConcurrency: 0, cpuCount: 4 }).source).toBe('none');
    expect(resolveConcurrency({ modelConcurrency: -3, cpuCount: 4 }).source).toBe('none');
  });

  it('answers the scheduler question without arithmetic at the call site', () => {
    expect(canStartAnother(5, { limit: Number.POSITIVE_INFINITY, source: 'none', reason: '' })).toBe(true);
    expect(canStartAnother(2, { limit: 3, source: 'model', reason: '' })).toBe(true);
    expect(canStartAnother(3, { limit: 3, source: 'model', reason: '' })).toBe(false);
  });

  it('falls back to one worker when the CPU count is nonsense', () => {
    expect(machineConcurrency(0)).toBe(1);
    expect(machineConcurrency(Number.NaN)).toBe(1);
  });
});
