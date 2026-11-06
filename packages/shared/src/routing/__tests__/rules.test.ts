import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatRouteInstruction, getRoutesPath, loadRoutes, matchRoute, ruleParallelism, type RouteRule } from '../rules.ts';

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-routes-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const rule = (overrides: Partial<RouteRule> = {}): RouteRule => ({
  name: 'QQ 邮箱的账单',
  when: { source: 'qqmail-idle', types: ['mail.received'], textMatch: '账单|发票' },
  to: { agentId: 'agt_finance' },
  ask: '按财务流程处理',
  ...overrides,
});

const event = (overrides: Partial<Parameters<typeof matchRoute>[0]> = {}) => ({
  source: 'qqmail-idle',
  type: 'mail.received',
  title: '新的账单',
  summary: '本月账单已出',
  ...overrides,
});

describe('route matching', () => {
  it('matches on source, type and text', () => {
    const decision = matchRoute(event(), [rule()]);
    expect(decision.kind).toBe('match');
    if (decision.kind === 'match') expect(decision.rule.name).toBe('QQ 邮箱的账单');
  });

  it('ignores an event from another source', () => {
    expect(matchRoute(event({ source: 'github' }), [rule()]).kind).toBe('ignore');
  });

  it('returns unknown when the source matches but the text does not', () => {
    // This is the hand-off signal: code cannot tell, so the supervisor decides.
    expect(matchRoute(event({ title: '团建通知', summary: '' }), [rule()]).kind).toBe('unknown');
  });

  it('matches with no text filter at all', () => {
    const decision = matchRoute(event(), [rule({ when: { source: 'qqmail-idle' } })]);
    expect(decision.kind).toBe('match');
  });

  it('honours the first matching rule in order', () => {
    const first = rule({ name: '第一条' });
    const second = rule({ name: '第二条' });
    const decision = matchRoute(event(), [first, second]);
    expect(decision.kind === 'match' && decision.rule.name).toBe('第一条');
  });

  it('ignores an event as soon as the type does not match', () => {
    expect(matchRoute(event({ type: 'mail.sent' }), [rule()]).kind).toBe('ignore');
  });
});

describe('routes file', () => {
  it('loads valid rules and drops malformed entries', () => {
    const ws = workspace();
    writeFileSync(
      getRoutesPath(ws),
      JSON.stringify([
        { name: 'ok', when: { source: 's' }, to: { agentId: 'a' } },
        { name: 'no target', when: { source: 's' }, to: {} },
        { when: { source: 's' }, to: { agentId: 'a' } },
        'nonsense',
      ]),
      'utf-8',
    );
    const rules = loadRoutes(ws);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.name).toBe('ok');
  });

  it('returns no rules for a missing or corrupt file', () => {
    const ws = workspace();
    expect(loadRoutes(ws)).toEqual([]);
    writeFileSync(getRoutesPath(ws), '{ oops', 'utf-8');
    expect(loadRoutes(ws)).toEqual([]);
  });
});

describe('instruction', () => {
  it('uses the rule ask when present', () => {
    expect(formatRouteInstruction(rule())).toBe('按财务流程处理');
  });

  it('falls back to the rule name', () => {
    expect(formatRouteInstruction(rule({ ask: undefined }))).toContain('QQ 邮箱的账单');
  });

  it('carries cwd and skills into the instruction', () => {
    const text = formatRouteInstruction({
      name: 'issue-triage',
      when: { source: 'github' },
      to: { agentId: 'triager', cwd: 'E:/repos/app', skills: ['triage', 'git'] },
      ask: '分诊这个 issue',
    });
    expect(text).toContain('E:/repos/app');
    expect(text).toContain('triage、git');
  });

  it('omits the cwd/skills lines when the rule does not set them', () => {
    const text = formatRouteInstruction(rule());
    expect(text).not.toContain('工作目录');
    expect(text).not.toContain('必须遵循的技能');
  });
});

describe('parallelism', () => {
  it('defaults to one so a rule never fans out by accident', () => {
    expect(ruleParallelism(rule())).toBe(1);
  });

  it('honours an explicit parallel value', () => {
    expect(ruleParallelism({ ...rule(), to: { agentId: 'a', parallel: 3 } })).toBe(3);
  });

  it('floors fractions and rejects nonsense', () => {
    expect(ruleParallelism({ ...rule(), to: { agentId: 'a', parallel: 2.7 } })).toBe(2);
    expect(ruleParallelism({ ...rule(), to: { agentId: 'a', parallel: 0 } })).toBe(1);
    expect(ruleParallelism({ ...rule(), to: { agentId: 'a', parallel: -5 } })).toBe(1);
  });
});
