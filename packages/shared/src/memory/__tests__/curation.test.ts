import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  curateDomainMemory,
  parseCurationReply,
  readL1AutoSection,
  readWikiPages,
  L1_CURATION_START,
  L1_CURATION_END,
  domainWikiDir,
} from '../curation.ts';
import { ensureAgentMemoryDomain, loadMemoryDomains, saveMemoryDomains, readDomainMemoryFile } from '../domains.ts';
import type { MemoryEntry } from '../types.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-curation-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(id: string, content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    type: 'factual',
    content,
    sourceSessionId: 's-1',
    confidence: 0.9,
    createdAt: '2026-11-19T00:00:00.000Z',
    injectedCount: 0,
    ...overrides,
  };
}

function regDomain(slug: string): string {
  // 注册表只登记 path，不建目录（生产里目录由首次写时建）；测试直接写文件前先建好。
  ensureAgentMemoryDomain(root, slug);
  const def = loadMemoryDomains(root, false).domains.find((d) => d.slug === slug);
  if (!def?.path) return '';
  mkdirSync(join(root, 'memory', 'domains', slug), { recursive: true });
  return def.path;
}

describe('curateDomainMemory（M7b 策展）', () => {
  it('无条目 → 不调 LLM、不写盘', async () => {
    regDomain('dom-a');
    let called = 0;
    const r = await curateDomainMemory(root, 'dom-a', [], async () => {
      called++;
      return '{}';
    });
    expect(called).toBe(0);
    expect(r.changed).toBe(false);
  });

  it('未注册域 → 不调 LLM，error=domain-not-registered', async () => {
    let called = 0;
    const r = await curateDomainMemory(root, 'ghost', [entry('e1', 'x')], async () => {
      called++;
      return '{}';
    });
    expect(called).toBe(0);
    expect(r.error).toBe('domain-not-registered');
  });

  it('正常路径：L1 自动区写入（手写部分保留）、L2 页写入、prune 只接受本次输入内的 id', async () => {
    const domainFile = regDomain('dom-b');
    writeFileSync(domainFile, '# dom-b 手写区\n手写内容必须存活\n');
    const r = await curateDomainMemory(
      root,
      'dom-b',
      [entry('e1', '原料 A'), entry('e2', '原料 B')],
      async () =>
        JSON.stringify({
          l1: '结论 A（源自原料）\n结论 B（源自原料）',
          wiki: [{ page: '主题甲', content: '# 主题甲\n正文' }],
          prune: ['e1', 'unknown-id'],
        }),
    );
    expect(r.changed).toBe(true);
    expect(r.pruned).toEqual(['e1']); // 输入外的 id 被滤掉
    const file = readFileSync(domainFile, 'utf8');
    expect(file).toContain('手写内容必须存活'); // 手写部分保留
    expect(readL1AutoSection(file)).toBe('结论 A（源自原料）\n结论 B（源自原料）');
    expect(r.wikiPages).toEqual(['主题甲']);
    expect(readWikiPages(root, 'dom-b').get('主题甲')).toBe('# 主题甲\n正文');
  });

  it('LLM 失败 → 旧文件保留，error 前缀 llm-failed', async () => {
    const domainFile = regDomain('dom-c');
    writeFileSync(domainFile, `${L1_CURATION_START}\n旧版\n${L1_CURATION_END}`);
    const r = await curateDomainMemory(root, 'dom-c', [entry('e1', 'A')], async () => {
      throw new Error('boom');
    });
    expect(r.changed).toBe(false);
    expect(r.error?.startsWith('llm-failed')).toBe(true);
    expect(readFileSync(domainFile, 'utf8')).toContain('旧版'); // 未被破坏
  });

  it('LLM 回复无法解析 → 保留旧版（宁缺毋滥）', async () => {
    const domainFile = regDomain('dom-d');
    writeFileSync(domainFile, `${L1_CURATION_START}\n旧版\n${L1_CURATION_END}`);
    const r = await curateDomainMemory(root, 'dom-d', [entry('e1', 'A')], async () => '没法解析的散文');
    expect(r.changed).toBe(false);
    expect(r.error).toBe('unparseable');
  });

  it('无变化（l1 相同 + wiki 相同 + 无剪枝）→ changed=false 不重写', async () => {
    const domainFile = regDomain('dom-e');
    const sameL1 = '相同区';
    writeFileSync(domainFile, `${L1_CURATION_START}\n${sameL1}\n${L1_CURATION_END}`);
    const wikiDir = domainWikiDir(root, 'dom-e');
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, 'topic-x.md'), '页内容');
    const r = await curateDomainMemory(
      root,
      'dom-e',
      [entry('e1', 'A')],
      async () => JSON.stringify({ l1: sameL1, wiki: [{ page: 'topic-x', content: '页内容' }], prune: [] }),
    );
    expect(r.changed).toBe(false);
  });

  it('mattersMost 进提示词；条目带 id·时间·来源小头（L1 规则）', async () => {
    regDomain('dom-f');
    const file = loadMemoryDomains(root, false);
    file.domains.find((d) => d.slug === 'dom-f')!.mattersMost = '界面一致性';
    saveMemoryDomains(root, file);
    let prompt = '';
    await curateDomainMemory(
      root,
      'dom-f',
      [entry('e9', '某条内容')],
      async (p) => {
        prompt = p;
        return '{"l1":null,"wiki":[],"prune":[]}';
      },
    );
    expect(prompt).toContain('界面一致性');
    expect(prompt).toContain('[e9]');
    expect(prompt).toContain('source=s-1');
  });
});

describe('parseCurationReply', () => {
  it('容忍 markdown 围栏', () => {
    const p = parseCurationReply('```json\n{"l1":"x","wiki":[],"prune":[]}\n```');
    expect(p?.l1).toBe('x');
  });

  it('不认识的 JSON 结构 → null（保留旧版）', () => {
    expect(parseCurationReply('{"foo": 1}')).toBeNull();
    expect(parseCurationReply('完全没有 json')).toBeNull();
  });
});

describe('readDomainMemoryFile（L3 注入：L1+L2 聚合）', () => {
  it('聚合 L1 域文件 + L2 wiki 页（按名排序）；无内容域返空串', () => {
    const domainFile = regDomain('dom-g');
    writeFileSync(domainFile, '# g\n手写 L1');
    const wikiDir = domainWikiDir(root, 'dom-g');
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, 'b.md'), '百科页 B');
    writeFileSync(join(wikiDir, 'a.md'), '百科页 A');
    const out = readDomainMemoryFile(root, 'dom-g');
    expect(out).toContain('手写 L1');
    expect(out).toContain('百科页 A');
    expect(out).toContain('百科页 B');
    expect(out.indexOf('百科页 A')).toBeLessThan(out.indexOf('百科页 B')); // 按文件名排序
    expect(readDomainMemoryFile(root, 'no-such-domain')).toBe('');
  });
});
