import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPersonalMemoryDomain, agentDomainSlug, ensureAgentMemoryDomain, loadMemoryDomains, resolveAgentMemoryDomain, type MemoryDomainDef } from './domains.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-domains-'));
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows keeps handles briefly; leftovers are harmless.
  }
});

function addProject(slug: string): void {
  mkdirSync(join(root, 'projects', slug), { recursive: true });
  writeFileSync(
    join(root, 'projects', slug, 'config.json'),
    JSON.stringify({ slug, name: slug, createdAt: 1, updatedAt: 1 }),
  );
}

describe('ensureAgentMemoryDomain（v7 §九④ 最小动作：个人域自动注册）', () => {
  it('幂等：两次调用只落一条', () => {
    ensureAgentMemoryDomain(root, 'soft-moor');
    ensureAgentMemoryDomain(root, 'soft-moor');
    const domains = loadMemoryDomains(root, false).domains;
    const entries = domains.filter((domain) => domain.slug === 'soft-moor');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('personal');
  });

  it('slug 清洗：大小写/空格规整为小写连字符', () => {
    expect(agentDomainSlug(' Soft Moor ')).toBe('soft-moor');
    ensureAgentMemoryDomain(root, 'Soft Moor');
    expect(loadMemoryDomains(root, false).domains.some((domain) => domain.slug === 'soft-moor')).toBe(true);
  });

  it('slug 与 project 共享域撞车时保留现有项，不重复登记', () => {
    addProject('soft-moor');
    const existing = ensureAgentMemoryDomain(root, 'soft-moor');
    expect(existing?.kind).toBe('project');
    expect(loadMemoryDomains(root, false).domains.filter((domain) => domain.slug === 'soft-moor')).toHaveLength(1);
  });
});

describe('resolveAgentMemoryDomain（缺省兜底：查询时、不落库，H1 风格）', () => {
  const domains: MemoryDomainDef[] = [
    { slug: 'soft-moor', kind: 'personal' },
    { slug: 'craft', kind: 'project', path: 'projects/craft/MEMORY.md' },
  ];

  it('memoryDomain 未设 → 助手个人域 slug', () => {
    expect(resolveAgentMemoryDomain({ id: 'soft-moor' }, domains)).toBe('soft-moor');
  });

  it('显式设了且在表里 → 用它（含 project 共享域）', () => {
    expect(resolveAgentMemoryDomain({ id: 'soft-moor', memoryDomain: 'craft' }, domains)).toBe('craft');
  });

  it('显式设了但表里查不到（失效引用）→ 回落个人域，不崩', () => {
    expect(resolveAgentMemoryDomain({ id: 'soft-moor', memoryDomain: 'gone' }, domains)).toBe('soft-moor');
  });

  it('不落库：解析不碰 agents.json / 域表（纯函数，输入不变）', () => {
    const agent = { id: 'soft-moor', memoryDomain: undefined };
    resolveAgentMemoryDomain(agent, domains);
    expect(agent.memoryDomain).toBeUndefined();
  });
});

describe('loadMemoryDomains', () => {
  it('现有 project 自动注册为共享域（幂等，零搬家：path 指回 project 的 MEMORY.md）', () => {
    addProject('craft');
    addProject('ops');
    const file = loadMemoryDomains(root);
    expect(file.domains).toEqual([
      { slug: 'craft', kind: 'project', path: join(root, 'projects', 'craft', 'MEMORY.md') },
      { slug: 'ops', kind: 'project', path: join(root, 'projects', 'ops', 'MEMORY.md') },
    ]);
    // 再读一次：不重复注册
    expect(loadMemoryDomains(root).domains).toHaveLength(2);
  });

  it('无 project → 空表（文件不存在也不抛）', () => {
    expect(loadMemoryDomains(root).domains).toEqual([]);
  });

  it('坏 JSON → 空表重建（绝不把坏文件当有效域）', () => {
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'memory-domains.json'), '{not json');
    expect(loadMemoryDomains(root).domains).toEqual([]);
  });
});

describe('addPersonalMemoryDomain', () => {
  it('新增个人域（隔离域，slug 清洗为小写连字符，物理位置 memory/domains/<slug>/MEMORY.md）', () => {
    expect(addPersonalMemoryDomain(root, 'My Private 域 ')).toBe(true);
    const domain = loadMemoryDomains(root).domains.find((entry) => entry.kind === 'personal');
    expect(domain?.slug).toBe('my-private');
    expect(domain?.path).toBe(join(root, 'memory', 'domains', 'my-private', 'MEMORY.md'));
  });

  it('重名 / 空 slug → false', () => {
    addProject('craft');
    expect(addPersonalMemoryDomain(root, 'craft')).toBe(false);
    expect(addPersonalMemoryDomain(root, '   ')).toBe(false);
  });
});
