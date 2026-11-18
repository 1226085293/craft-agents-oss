import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPersonalMemoryDomain, loadMemoryDomains } from './domains.ts';

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
