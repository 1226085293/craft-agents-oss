/**
 * 记忆域（v6/v7 切片 C 最小版）：`config/memory-domains.json` + 现有 project 自动注册。
 *
 * 本切片只解决「表存在、下拉有数据可选」：
 * - `kind='project'`：共享域，slug = project slug，path 指回 `projects/<slug>/MEMORY.md`（零搬家）
 * - `kind='personal'`：隔离域（助手专属，可写），物理位置 `memory/domains/<slug>/MEMORY.md`
 *
 * 域解析逻辑（L1 按域分家 / L3 注入预算 / 助手 memoryDomain 接线）是阶段 4
 * （M7a/M7b）的事——那些逻辑读这张表，不另起炉灶。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspaceProjects } from '../projects/storage.ts';
import { loadTask } from '../tasks/store.ts';
import { loadAgents } from '../agents/storage.ts';
import type { AgentProfile } from '../agents/types.ts';

export interface MemoryDomainDef {
  slug: string;
  kind: 'personal' | 'project';
  /** 域文件物理位置（project 域指回 project 的 MEMORY.md，零搬家） */
  path?: string;
  /** 「什么最重要」指令（dreaming 目标化生长用，阶段 8） */
  mattersMost?: string;
}

export interface MemoryDomainsFile {
  version: 1;
  domains: MemoryDomainDef[];
}

export function memoryDomainsPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'memory-domains.json');
}

function defaultFile(): MemoryDomainsFile {
  return { version: 1, domains: [] };
}

/**
 * 读域表；现有 project 自动注册为共享域（幂等，零搬家——path 指回
 * `projects/<slug>/MEMORY.md`，不复制内容）。首次发现新 project 时落盘。
 */
export function loadMemoryDomains(workspaceRoot: string, persistRegistration = true): MemoryDomainsFile {
  const path = memoryDomainsPath(workspaceRoot);
  let file: MemoryDomainsFile;
  if (!existsSync(path)) {
    file = defaultFile();
  } else {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemoryDomainsFile>;
      file = { version: 1, domains: Array.isArray(parsed.domains) ? parsed.domains : [] };
    } catch {
      file = defaultFile();
    }
  }
  const known = new Set(file.domains.map((domain) => domain.slug));
  let registered = false;
  for (const project of loadWorkspaceProjects(workspaceRoot)) {
    // loadWorkspaceProjects enumerates projects/<dir>/ dirs: the memory file lives
    // in the folder itself, so use folderPath (robust even if config.slug drifted).
    const slug = project.config.slug || project.folderPath.split(/[\\/]/).pop();
    if (!slug || known.has(slug)) continue;
    file.domains.push({
      slug,
      kind: 'project',
      path: join(project.folderPath, 'MEMORY.md'),
    });
    registered = true;
  }
  if (registered && persistRegistration) {
    saveMemoryDomains(workspaceRoot, file);
  }
  return file;
}

export function saveMemoryDomains(workspaceRoot: string, file: MemoryDomainsFile): void {
  mkdirSync(join(workspaceRoot, 'config'), { recursive: true });
  writeFileSync(memoryDomainsPath(workspaceRoot), JSON.stringify(file, null, 2), 'utf8');
}

// ============================================================================
// 托管记忆写路由（v7 阶段 9）：会话的记忆写进哪个域（对称地、能读哪些域）。
//
// 语义（钉死）：
// - 显式创建的自定义角色（agents[] 里未删的行）→ 自己的域：
//   memoryDomain 设了且指向个人域 → 用它；设了共享（project）域 = 只读引用，
//   写回落个人域；未设 → 个人域（slug=agentId 清洗值，幂等自动注册）。
// - 任务临时会话（taskId）→ 「经验归发起人」：initiatorAgentId（自定义角色）
//   → 发起人的域；无发起人 → 被指派人域；都无 → global。
// - 默认助手 / 管道会话 / 未知 agentId → 'global'（共享池：存量条目与主助手
//   的经验本来就属于全局，升级零回归）。
// ============================================================================

/** 全局共享池的域 slug（MemoryEntry.domain 缺省即 global，零重写存量）。 */
export const GLOBAL_MEMORY_DOMAIN = 'global';

/** 按 id 查自定义角色（agents[] 未删行；默认助手不算自定义角色 → null）。 */
function findCustomAgent(workspaceRoot: string, agentId: string | undefined | null): AgentProfile | null {
  if (!agentId) return null;
  const file = loadAgents(workspaceRoot);
  return file.agents.find((agent) => agent.id === agentId && !agent.deletedAt) ?? null;
}

/** 自定义角色的写域（目标域不在表里时幂等注册；共享域写回落个人域）。 */
function agentWriteDomain(workspaceRoot: string, agent: AgentProfile): string {
  const domains = loadMemoryDomains(workspaceRoot).domains;
  const personalSlug = agentDomainSlug(agent.id);
  const explicit = agent.memoryDomain
    ? domains.find((domain) => domain.slug === agent.memoryDomain)
    : undefined;
  const target = explicit?.kind === 'personal' ? explicit.slug : personalSlug;
  if (target === personalSlug) {
    ensureAgentMemoryDomain(workspaceRoot, agent.id);
  } else {
    addPersonalMemoryDomain(workspaceRoot, target);
  }
  return target;
}

/**
 * 写路由：该会话的记忆落哪个域。
 * @param ctx.agentId 会话的 agent（临时任务会话自身的 agentId=assignee，但
 *   只要带 taskId 就走任务分支——经验归发起人，v7 小项拍板）
 * @param ctx.taskId 临时任务会话的任务 id
 */
export function resolveWriteDomain(
  workspaceRoot: string,
  ctx: { agentId?: string | null; taskId?: string | null },
): string {
  if (ctx.taskId) {
    const task = loadTask(workspaceRoot, ctx.taskId);
    const initiator = task?.initiatorAgentId ? findCustomAgent(workspaceRoot, task.initiatorAgentId) : null;
    if (initiator) return agentWriteDomain(workspaceRoot, initiator);
    const assignee = task?.assigneeAgentId ? findCustomAgent(workspaceRoot, task.assigneeAgentId) : null;
    if (assignee) return agentWriteDomain(workspaceRoot, assignee);
    return GLOBAL_MEMORY_DOMAIN;
  }
  const agent = findCustomAgent(workspaceRoot, ctx.agentId);
  return agent ? agentWriteDomain(workspaceRoot, agent) : GLOBAL_MEMORY_DOMAIN;
}

/** 读路由：该会话能读哪些域 = [自己的写域, 'global']（去重；写域=global 时只有 global）。 */
export function resolveReadDomains(
  workspaceRoot: string,
  ctx: { agentId?: string | null; taskId?: string | null },
): string[] {
  const write = resolveWriteDomain(workspaceRoot, ctx);
  return write === GLOBAL_MEMORY_DOMAIN ? [GLOBAL_MEMORY_DOMAIN] : [write, GLOBAL_MEMORY_DOMAIN];
}

/**
 * 域知识注入预算（v6 L3：各域首屏索引 ≤25KB/200 行，先到先截）。
 * L1 = 域 MEMORY.md 全文（手写 + 自动策展区都是合法内容）；
 * L2 = memory/wiki/<域>/*.md 百科页（M7b 策展产物）；百科+搜索并用：
 * 条目检索（embedding 门）不动，这里补上百科的注入面。
 */
export const DOMAIN_MEMORY_INJECTION_MAX_CHARS = 25_000;
export const DOMAIN_MEMORY_INJECTION_MAX_LINES = 200;

/**
 * 读域知识注入内容（L3 注入）：L1 域文件 + L2 百科页聚合，按 25KB/200 行预算截断。
 * 两部分都缺失/空 → 返 ''（调用方跳过注入块）。全局池不在此列：
 * 全局 MEMORY.md 是存量策展产物（wiki 浏览），不进注入。
 */
export function readDomainMemoryFile(workspaceRoot: string, slug: string): string {
  const parts: string[] = [];
  const def = loadMemoryDomains(workspaceRoot, false).domains.find((domain) => domain.slug === slug);
  if (def?.path && existsSync(def.path)) {
    try {
      parts.push(readFileSync(def.path, 'utf8').trim());
    } catch {
      // 单文件损坏不阻塞
    }
  }
  const wikiDir = join(workspaceRoot, 'memory', 'wiki', slug);
  if (existsSync(wikiDir)) {
    for (const file of readdirSync(wikiDir)
      .filter((f) => f.endsWith('.md'))
      .sort()) {
      try {
        parts.push(`## ${file.replace(/\.md$/, '')}\n${readFileSync(join(wikiDir, file), 'utf8').trim()}`);
      } catch {
        // 单页损坏不阻塞
      }
    }
  }
  let content = parts.filter(Boolean).join('\n\n').trim();
  if (!content) return '';
  // 预算（v6 L3：≤25KB/200 行）
  const lines = content.split('\n');
  let truncated = false;
  if (lines.length > DOMAIN_MEMORY_INJECTION_MAX_LINES) {
    content = lines.slice(0, DOMAIN_MEMORY_INJECTION_MAX_LINES).join('\n');
    truncated = true;
  }
  if (content.length > DOMAIN_MEMORY_INJECTION_MAX_CHARS) {
    content = content.slice(0, DOMAIN_MEMORY_INJECTION_MAX_CHARS);
    truncated = true;
  }
  return truncated ? `${content}\n…（超注入预算截断，完整内容见记忆 wiki）` : content;
}

/** 新增个人域（助手专属、隔离）。slug 清洗为小写连字符；重名 → false。 */
export function addPersonalMemoryDomain(workspaceRoot: string, slug: string): boolean {
  const cleaned = agentDomainSlug(slug);
  if (!cleaned) return false;
  const file = loadMemoryDomains(workspaceRoot);
  if (file.domains.some((domain) => domain.slug === cleaned)) return false;
  file.domains.push({
    slug: cleaned,
    kind: 'personal',
    path: join(workspaceRoot, 'memory', 'domains', cleaned, 'MEMORY.md'),
  });
  saveMemoryDomains(workspaceRoot, file);
  return true;
}

/** 个人域 slug 清洗（小写连字符；与 addPersonalMemoryDomain 同一规则）。 */
export function agentDomainSlug(agentId: string): string {
  return agentId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 自动注册助手的个人域（幂等；v7 §九④ 最小动作）。
 * 每个助手一个可写个人域（slug=agentId 清洗值，path 在 memory/domains/<slug>/MEMORY.md）；
 * 同 slug 已被任何 kind 的域占用（如同名 project 共享域）→ 保留现有项，不重复登记。
 */
export function ensureAgentMemoryDomain(
  workspaceRoot: string,
  agentId: string,
): MemoryDomainDef | null {
  const slug = agentDomainSlug(agentId);
  if (!slug) return null;
  const file = loadMemoryDomains(workspaceRoot);
  const existing = file.domains.find((domain) => domain.slug === slug);
  if (existing) return existing;
  const def: MemoryDomainDef = {
    slug,
    kind: 'personal',
    path: join(workspaceRoot, 'memory', 'domains', slug, 'MEMORY.md'),
  };
  file.domains.push(def);
  saveMemoryDomains(workspaceRoot, file);
  return def;
}

/**
 * 解析助手生效记忆域（v7 §九④ 缺省兜底，H1 风格「查询时兜底、不落库」）：
 *  - memoryDomain 显式设了且在域表里 → 用它
 *  - 未设 / 表里查不到（失效引用）→ 助手个人域 slug
 * 不写回 agents.json；域文件读写接线（L1 分家/L3 注入）是阶段 4 的事。
 */
export function resolveAgentMemoryDomain(
  agent: { id: string; memoryDomain?: string },
  domains: readonly MemoryDomainDef[],
): string {
  if (agent.memoryDomain && domains.some((domain) => domain.slug === agent.memoryDomain)) {
    return agent.memoryDomain;
  }
  return agentDomainSlug(agent.id);
}
