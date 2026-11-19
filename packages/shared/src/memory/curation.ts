/**
 * 策展（M7b「做梦」策展步，v6 记忆体系 §M7b）：
 * 整理管线晋升之后，把某域的条目池蒸馏进该域的 L1 笔记（MEMORY.md 自动策展区）
 * 与 L2 百科页（memory/wiki/<域>/<主题>.md），并给出剪枝建议。
 *
 * 规则（按 v6 M7b）：
 * - 一页一写手：一个域一轮一次 LLM 调用（该域唯一写手，串行）
 * - 关键数据原样引用：提示词要求关键数字/路径/命令 verbatim，不许改写
 * - 低风险自动并入：策展只写机器管理内容（L1 标记区 / L2 wiki 文件 /
 *   剪枝条目进回收站可恢复）；手写内容永不触碰 → 不存在敏感确认分支
 *   （v6 ⑦ 草稿区"敏感等确认"针对的是不可逆操作；本管线操作全部可逆）
 * - LLM 失败/坏回复 → 保留旧文件（策展失败不能毁掉已有策展成果），原子写
 *
 * M7b 五件事落点：① 对账修错（规则 1 提示词）② 补百科（L2 页）
 * ③ 精简索引（L1 保持首屏索引 + 上限）④ 按 mattersMost 生长（规则 4）
 * ⑤ 剪枝（prune → 宿主移 trash）。
 * 未做（backlog，如实标注）：L0 全文索引对账机制（对账发生在 L1/L2 与条目池之间）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadMemoryDomains } from './domains.ts';
import type { MemoryEntry } from './types.ts';

/** L1 笔记自动策展区标记（标记外的手写内容永不触碰）。 */
export const L1_CURATION_START = '<!-- craft:curated:start -->';
export const L1_CURATION_END = '<!-- craft:curated:end -->';

/** L2 百科页单页上限（机器整页写，克制篇幅）。 */
export const WIKI_PAGE_MAX_CHARS = 2000;
/** L1 自动策展区上限。 */
export const L1_AUTO_SECTION_MAX_CHARS = 6000;
/** 单轮喂给策展的原料条目上限（按注入次数/新鲜度取 top）。 */
export const CURATION_ENTRY_LIMIT = 40;
/** 单条策展输入的截断长度。 */
export const CURATION_ENTRY_MAX_CHARS = 400;

export interface CurationWikiPage {
  /** kebab 主题名（wiki 文件名，不含扩展名）。 */
  page: string;
  content: string;
}

export interface CurationProposal {
  /** L1 自动策展区新内容；null = 不变。 */
  l1?: string | null;
  wiki?: CurationWikiPage[];
  /** 剪枝：已被策展覆盖/推翻的原料条目 id（宿主负责移入 trash，可恢复）。 */
  prune?: string[];
}

export interface CurateDomainResult {
  /** 是否产生了实际写操作（无变化 = false）。 */
  changed: boolean;
  pruned: string[];
  wikiPages: string[];
  error?: string;
}

/** 域 L2 百科目录：memory/wiki/<slug>/（本模块是唯一写手）。 */
export function domainWikiDir(workspaceRoot: string, slug: string): string {
  return join(workspaceRoot, 'memory', 'wiki', slug);
}

/** 读 L1 文件当前自动策展区内容（无标记 = ''）。 */
export function readL1AutoSection(l1Content: string): string {
  const start = l1Content.indexOf(L1_CURATION_START);
  const end = l1Content.indexOf(L1_CURATION_END);
  if (start < 0 || end < start) return '';
  return l1Content.slice(start + L1_CURATION_START.length, end).trim();
}

/** 读域 L2 百科页（文件名 → 内容，按名排序；单页损坏不阻塞）。 */
export function readWikiPages(workspaceRoot: string, slug: string): Map<string, string> {
  const dir = domainWikiDir(workspaceRoot, slug);
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    try {
      out.set(file.replace(/\.md$/, ''), readFileSync(join(dir, file), 'utf8'));
    } catch {
      // 单页损坏：跳过该页，不阻塞策展
    }
  }
  return out;
}

function atomicWriteText(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-curation`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

/**
 * 写入/替换 L1 域文件的自动策展区（标记外内容原样保留）。
 * 域未注册/无 path → false。
 */
export function writeL1AutoSection(workspaceRoot: string, slug: string, autoSection: string): boolean {
  const def = loadMemoryDomains(workspaceRoot, false).domains.find((d) => d.slug === slug);
  if (!def?.path) return false;
  const current = existsSync(def.path) ? readFileSync(def.path, 'utf8') : '';
  const section = `\n${autoSection.trim()}\n`;
  const start = current.indexOf(L1_CURATION_START);
  const end = current.indexOf(L1_CURATION_END);
  let next: string;
  if (start >= 0 && end > start) {
    next = `${current.slice(0, start)}${L1_CURATION_START}${section}${L1_CURATION_END}${current.slice(end + L1_CURATION_END.length)}`;
  } else {
    const base = current.trim();
    next = `${base ? `${base}\n\n` : ''}${L1_CURATION_START}${section}${L1_CURATION_END}\n`;
  }
  atomicWriteText(def.path, next);
  return true;
}

/** 策展输入：条目按「时间·来源·类型」小头格式（v6 L1 规则：条目加小头）。 */
export function buildCurationPrompt(input: {
  domainSlug: string;
  mattersMost?: string;
  l1Auto: string;
  wiki: CurationWikiPage[];
  entries: MemoryEntry[];
}): string {
  const raw = input.entries
    .map(
      (e) =>
        `- [${e.id}] ${String(e.createdAt ?? '').slice(0, 10)} source=${e.sourceSessionId || 'unknown'} ${e.type} injected=${e.injectedCount ?? 0} :: ${e.content.slice(0, CURATION_ENTRY_MAX_CHARS)}`,
    )
    .join('\n');
  return [
    `你是记忆域 "${input.domainSlug}" 的策展人（本轮该域唯一写手）。`,
    input.mattersMost ? `\n生长指引（这个角色的"什么最重要"）：${input.mattersMost}` : '',
    `\n## L1 笔记·自动策展区（现状）${input.l1Auto ? `\n${input.l1Auto}` : '\n（空）'}`,
    `\n## L2 百科页（现状）${input.wiki.length ? `\n${input.wiki.map((p) => `### ${p.page}\n${p.content}`).join('\n')}` : '\n（无）'}`,
    `\n## 新原料条目（id · 时间 · 来源 · 类型 · 注入次数 :: 内容）`,
    raw,
    ``,
    `按以下五条策展（M7b）：`,
    `1. 对账修错：新原料与 L1/L2 冲突或更正旧内容时修正——关键数据（数字、路径、命令、名称）必须原样引用，不许改写`,
    `2. 补百科：同主题条目归纳成 L2 页（一页一主题；page 用 kebab-case 英文主题名；页内可用「相关: <page名>」链接其他页）`,
    `3. 精简索引：L1 保持「首屏索引」定位——结论 + 指向 L2 页的指针，不做流水摘要`,
    `4. 按「什么最重要」生长：优先组织符合生长指引的条目`,
    `5. 剪枝：已被 L1/L2 完全覆盖或推翻的原料，把其 id 放进 prune（系统移入回收站，可恢复）`,
    ``,
    `只回复 JSON（不要 markdown 围栏、不要评论）：`,
    `{"l1":"<L1 自动策展区新文本；无改动填 null>","wiki":[{"page":"<topic-slug>","content":"<页 markdown>"}],"prune":["<entry id>"]}`,
    `wiki 只放本轮新建/修改的页；无改动对应字段填 null / []。`,
  ].join('\n');
}

/** 解析 LLM 策展回复（容忍围栏；语义严格——结构不认识 → null = 保留旧版）。 */
export function parseCurationReply(raw: string): CurationProposal | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  let l1: string | null | undefined;
  if (parsed.l1 === null) l1 = null;
  else if (typeof parsed.l1 === 'string') l1 = parsed.l1;
  const wiki: CurationWikiPage[] = [];
  if (Array.isArray(parsed.wiki)) {
    for (const item of parsed.wiki) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { page?: unknown }).page === 'string' &&
        typeof (item as { content?: unknown }).content === 'string'
      ) {
        wiki.push({ page: (item as { page: string }).page, content: (item as { content: string }).content });
      }
    }
  }
  const prune: string[] = [];
  if (Array.isArray(parsed.prune)) {
    for (const id of parsed.prune) if (typeof id === 'string') prune.push(id);
  }
  if (l1 === undefined && wiki.length === 0 && prune.length === 0) return null;
  return { l1, wiki, prune };
}

/**
 * 对一个域执行策展：L1 区更新 + L2 页写 + 剪枝建议。
 * 剪枝的落库（移 trash）由宿主执行——这里只返回 id（写全局池是宿主的事）。
 */
export async function curateDomainMemory(
  workspaceRoot: string,
  slug: string,
  entries: MemoryEntry[],
  evaluate: (prompt: string) => Promise<string>,
): Promise<CurateDomainResult> {
  if (!entries.length) return { changed: false, pruned: [], wikiPages: [] };
  const def = loadMemoryDomains(workspaceRoot, false).domains.find((d) => d.slug === slug);
  if (!def) return { changed: false, pruned: [], wikiPages: [], error: 'domain-not-registered' };

  const l1File = def.path && existsSync(def.path) ? readFileSync(def.path, 'utf8') : '';
  const l1Auto = readL1AutoSection(l1File);
  const wikiNow = readWikiPages(workspaceRoot, slug);
  const selected = [...entries]
    .sort(
      (a, b) =>
        (b.injectedCount ?? 0) - (a.injectedCount ?? 0) ||
        String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')),
    )
    .slice(0, CURATION_ENTRY_LIMIT);

  const prompt = buildCurationPrompt({
    domainSlug: slug,
    mattersMost: def.mattersMost,
    l1Auto,
    wiki: [...wikiNow.entries()].map(([page, content]) => ({ page, content })),
    entries: selected,
  });

  let raw: string;
  try {
    raw = await evaluate(prompt);
  } catch (error) {
    // 策展失败保留旧文件（不能毁掉已有策展成果）
    return { changed: false, pruned: [], wikiPages: [], error: `llm-failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!raw || !raw.trim()) return { changed: false, pruned: [], wikiPages: [], error: 'empty-reply' };
  const proposal = parseCurationReply(raw);
  if (!proposal) return { changed: false, pruned: [], wikiPages: [], error: 'unparseable' };

  let changed = false;
  const validIds = new Set(selected.map((e) => e.id));

  if (typeof proposal.l1 === 'string' && proposal.l1.slice(0, L1_AUTO_SECTION_MAX_CHARS) !== l1Auto) {
    if (writeL1AutoSection(workspaceRoot, slug, proposal.l1.slice(0, L1_AUTO_SECTION_MAX_CHARS))) changed = true;
  }

  const wikiPages: string[] = [];
  for (const page of proposal.wiki ?? []) {
    // 保留 Unicode 字母/数字（主题名可以是中文）；只挡路径危险字符。
    const file = page.page
      .replace(/[^\p{L}\p{N}-]/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .slice(0, 40);
    if (!file) continue;
    const content = page.content.slice(0, WIKI_PAGE_MAX_CHARS);
    if (wikiNow.get(file) === content) continue; // 内容未变不重写
    atomicWriteText(join(domainWikiDir(workspaceRoot, slug), `${file}.md`), content);
    wikiPages.push(file);
    changed = true;
  }

  const pruned = (proposal.prune ?? []).filter((id) => validIds.has(id));
  if (pruned.length) changed = true;

  return { changed, pruned, wikiPages };
}
