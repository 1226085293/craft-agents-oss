import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GLOBAL_MEMORY_DOMAIN,
  ensureAgentMemoryDomain,
  loadMemoryDomains,
  resolveReadDomains,
  resolveWriteDomain,
} from './domains.ts';
import { createTask, saveTask } from '../tasks/store.ts';

let root: string;

function agentsFile(agents: Array<{ id: string; name: string; memoryDomain?: string; assignable?: boolean }>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'agents.json'),
    JSON.stringify({ version: 1, defaults: { persona: 'd' }, agents }, null, 2),
  );
}

function addProject(slug: string): void {
  mkdirSync(join(root, 'projects', slug), { recursive: true });
  writeFileSync(join(root, 'projects', slug, 'config.json'), JSON.stringify({ slug, name: slug, createdAt: 1, updatedAt: 1 }));
}

function addTask(overrides: Record<string, unknown> = {}): string {
  const id = String(overrides.id ?? 'T-9');
  const task = createTask({
    id,
    name: 'n',
    instruction: 'i',
    supervisorSessionId: 'sup',
    toolCallId: 'tool-1',
    now: 1_000_000,
    ...overrides,
  });
  saveTask(root, task);
  return id;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-mem-route-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveWriteDomain（v7 阶段 9 写路由）', () => {
  it('无任何上下文 → global（管道会话/旧会话零回归）', () => {
    agentsFile([]);
    expect(resolveWriteDomain(root, {})).toBe(GLOBAL_MEMORY_DOMAIN);
    expect(resolveWriteDomain(root, { agentId: undefined, taskId: undefined })).toBe(GLOBAL_MEMORY_DOMAIN);
  });

  it('默认助手不算自定义角色 → global', () => {
    agentsFile([{ id: 'agent-ui', name: 'UI 工' }]);
    expect(resolveWriteDomain(root, { agentId: 'default' })).toBe(GLOBAL_MEMORY_DOMAIN);
    expect(resolveWriteDomain(root, { agentId: '不存在的角色' })).toBe(GLOBAL_MEMORY_DOMAIN);
  });

  it('自定义角色未设 memoryDomain → 个人域（slug=agentId 清洗值，幂等自动注册）', () => {
    agentsFile([{ id: 'UI 工', name: 'UI 工' }]);
    const domain = resolveWriteDomain(root, { agentId: 'UI 工' });
    expect(domain).toBe('ui'); // slug 清洗：小写 + 非 [a-z0-9-] 整段替 - + 去首尾 -
    expect(loadMemoryDomains(root, false).domains.some((d) => d.slug === 'ui' && d.kind === 'personal')).toBe(true);
    // 再调一次：幂等，不重复注册
    expect(loadMemoryDomains(root, false).domains.filter((d) => d.slug === 'ui')).toHaveLength(1);
  });

  it('自定义角色 memoryDomain 指向个人域 → 用它', () => {
    agentsFile([{ id: 'agent-ui', name: 'UI 工', memoryDomain: 'agent-ui' }]);
    ensureAgentMemoryDomain(root, 'agent-ui');
    expect(resolveWriteDomain(root, { agentId: 'agent-ui' })).toBe('agent-ui');
  });

  it('memoryDomain 指向共享（project）域 = 只读引用，写回落个人域', () => {
    addProject('craft');
    loadMemoryDomains(root, true); // 触发 project 自动注册
    agentsFile([{ id: 'agent-ui', name: 'UI 工', memoryDomain: 'craft' }]);
    expect(resolveWriteDomain(root, { agentId: 'agent-ui' })).toBe('agent-ui');
  });

  it('memoryDomain 失效引用（表里查不到）→ 回落个人域', () => {
    agentsFile([{ id: 'agent-ui', name: 'UI 工', memoryDomain: 'ghost-domain' }]);
    expect(resolveWriteDomain(root, { agentId: 'agent-ui' })).toBe('agent-ui');
  });

  it('任务临时会话：经验归发起人（v7 小项），即使会话自身 agentId=被指派人', () => {
    agentsFile([{ id: 'agent-ui', name: 'UI 工' }, { id: 'task-worker', name: '任务工' }]);
    ensureAgentMemoryDomain(root, 'agent-ui');
    ensureAgentMemoryDomain(root, 'task-worker');
    addTask({ id: 'T-1', assigneeAgentId: 'task-worker', initiatorAgentId: 'agent-ui' });
    expect(resolveWriteDomain(root, { agentId: 'task-worker', taskId: 'T-1' })).toBe('agent-ui');
  });

  it('任务无发起人 → 被指派人域', () => {
    agentsFile([{ id: 'task-worker', name: '任务工' }]);
    ensureAgentMemoryDomain(root, 'task-worker');
    addTask({ id: 'T-2', assigneeAgentId: 'task-worker' });
    expect(resolveWriteDomain(root, { agentId: 'task-worker', taskId: 'T-2' })).toBe('task-worker');
  });

  it('任务既无发起人也无指派人 → global', () => {
    agentsFile([]);
    addTask({ id: 'T-3' });
    expect(resolveWriteDomain(root, { agentId: 'default', taskId: 'T-3' })).toBe(GLOBAL_MEMORY_DOMAIN);
  });

  it('任务记录不存在（已删）→ 保守 global', () => {
    agentsFile([{ id: 'task-worker', name: '任务工' }]);
    expect(resolveWriteDomain(root, { agentId: 'task-worker', taskId: 'T-404' })).toBe(GLOBAL_MEMORY_DOMAIN);
  });

  it('发起人不是自定义角色（默认助手）→ 被指派人域', () => {
    agentsFile([{ id: 'agent-ui', name: 'UI 工' }]);
    ensureAgentMemoryDomain(root, 'agent-ui');
    addTask({ id: 'T-5', assigneeAgentId: 'agent-ui', initiatorAgentId: 'default' });
    expect(resolveWriteDomain(root, { agentId: 'agent-ui', taskId: 'T-5' })).toBe('agent-ui');
  });
});

describe('resolveReadDomains（读路由 = 写域 + 全局存量）', () => {
  it('角色会话 → [自己域, global]', () => {
    agentsFile([{ id: 'agent-ui', name: 'UI 工' }]);
    ensureAgentMemoryDomain(root, 'agent-ui');
    expect(resolveReadDomains(root, { agentId: 'agent-ui' })).toEqual(['agent-ui', GLOBAL_MEMORY_DOMAIN]);
  });

  it('无归属会话 → 只有 global（行为与升级前一致）', () => {
    agentsFile([]);
    expect(resolveReadDomains(root, {})).toEqual([GLOBAL_MEMORY_DOMAIN]);
  });

  it('任务临时会话读发起人的域 + 全局', () => {
    agentsFile([{ id: 'agent-ui', name: 'UI 工' }, { id: 'task-worker', name: '任务工' }]);
    ensureAgentMemoryDomain(root, 'agent-ui');
    addTask({ id: 'T-6', assigneeAgentId: 'task-worker', initiatorAgentId: 'agent-ui' });
    expect(resolveReadDomains(root, { agentId: 'task-worker', taskId: 'T-6' })).toEqual(['agent-ui', GLOBAL_MEMORY_DOMAIN]);
  });
});
