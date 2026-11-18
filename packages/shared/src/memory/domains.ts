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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspaceProjects } from '../projects/storage.ts';

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
