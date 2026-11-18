/**
 * 权限标签（渠道闸门）—— v6/v7 阶段 1 地基。
 *
 * 三方结构：
 *  - 资源侧：数据源打标签（`sources/<slug>/config.json` 的 `labels`）；缺省 = 查询时
 *    按 `['private']` 处理（自动套用，不回填配置，避免改标签时出现漏看窗口）。
 *  - 主体侧：配对记录（pairings.ts v2）声明「这个通道放行哪些标签 + 模式天花板」。
 *  - 闸本身：本文件的纯函数；SessionManager 通道唤醒路径算交集后经
 *    `options.enabledSourceSlugs` 传入（applyScope 调用方收窄，applyScope 本身不动）。
 *
 * H1 空值语义（钉死，实现者不得随手重定义）：
 *  - 记录字段缺省（老记录）= 闸未启用，行为与升级前一致（零回归）；
 *  - `gateEnabled=true` + 空 `allowedLabels` = 故意全禁（UI 红警）；
 *  - `permissionMode` 缺省 = 不设天花板（**严禁回填 'safe' 到老记录**）；
 *  - `pairedBy` 缺省（洞 3）= **写保护白名单未启用**：群内写回退现有
 *    permissionMode 门禁（升级前怎样，升级后还怎样），不是「一律拒绝」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type PairedChannelRecord,
  type PermissionModeCeiling,
} from './pairings';

/** 系统内置标签：删不掉、改不了名。 */
export const BUILTIN_PRIVATE_LABEL = 'private';

export interface PermissionLabelDef {
  name: string;
  /** 内置标签不可删除。 */
  builtin?: boolean;
}

export interface PermissionLabelsFile {
  version: 1;
  labels: PermissionLabelDef[];
}

export function permissionLabelsPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'permission-labels.json');
}

function defaultLabelFile(): PermissionLabelsFile {
  return { version: 1, labels: [{ name: BUILTIN_PRIVATE_LABEL, builtin: true }] };
}

/** 缺文件/坏文件 → 默认词表（内置 private），never throws。 */
export function loadPermissionLabels(workspaceRoot: string): PermissionLabelsFile {
  const path = permissionLabelsPath(workspaceRoot);
  if (!existsSync(path)) return defaultLabelFile();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PermissionLabelsFile>;
    const labels = Array.isArray(parsed.labels) ? parsed.labels : [];
    // 内置 private 永远在：老文件漏写也在查询时补上。
    if (!labels.some((label) => label?.name === BUILTIN_PRIVATE_LABEL)) {
      labels.push({ name: BUILTIN_PRIVATE_LABEL, builtin: true });
    }
    return { version: 1, labels };
  } catch {
    return defaultLabelFile();
  }
}

export function savePermissionLabels(workspaceRoot: string, file: PermissionLabelsFile): void {
  mkdirSync(join(workspaceRoot, 'config'), { recursive: true });
  writeFileSync(permissionLabelsPath(workspaceRoot), JSON.stringify(file, null, 2), 'utf8');
}

/** 新增标签；重名或内置 private → false（内置不写进文件，查询时自动补）。 */
export function addPermissionLabel(workspaceRoot: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === BUILTIN_PRIVATE_LABEL) return false;
  const file = loadPermissionLabels(workspaceRoot);
  if (file.labels.some((label) => label.name === trimmed)) return false;
  file.labels.push({ name: trimmed });
  savePermissionLabels(workspaceRoot, file);
  return true;
}

/**
 * 删除标签（先过 canDeletePermissionLabel：内置锁死 / 被源或通道引用阻止）。
 * @param sources 各源现标签（FolderSourceConfig.labels，缺省=没打）
 * @param channels 配对记录（allowedLabels）
 */
export function removePermissionLabel(
  workspaceRoot: string,
  name: string,
  sources: ReadonlyArray<{ slug: string; labels?: string[] }> = [],
  channels: ReadonlyArray<{ allowedLabels?: string[] }> = [],
): { ok: boolean; reason?: 'builtin' | 'in_use' | 'not_found' } {
  const check = canDeletePermissionLabel(name, sources, channels);
  if (!check.ok) return check;
  const file = loadPermissionLabels(workspaceRoot);
  const next = file.labels.filter((label) => label.name !== name);
  if (next.length === file.labels.length) return { ok: false, reason: 'not_found' };
  file.labels = next;
  savePermissionLabels(workspaceRoot, file);
  return { ok: true };
}

/**
 * saveConfig 词表闸（v7 §九③）：labels ⊆ 词表，否则拒绝。
 * UI「先建标签（sources:labels add）再打标签」是唯一合法引入新标签的路径；
 * RPC 直写词表外标签会让管理面漂移——词表 UI 看不到它、
 * canDeletePermissionLabel「被引用阻止删」也查不到它。
 */
export function assertLabelsInVocabulary(workspaceRoot: string, labels: readonly string[]): void {
  if (labels.length === 0) return;
  const known = new Set(loadPermissionLabels(workspaceRoot).labels.map((entry) => entry.name));
  const unknown = [...new Set(labels)].filter((label) => !known.has(label));
  if (unknown.length > 0) {
    throw new Error(`Unknown permission label(s): ${unknown.join(', ')}`);
  }
}

/**
 * 删除校验（纯函数）：
 *  - 内置标签锁死（reason: 'builtin'）
 *  - 有源或通道引用 → 阻止删除，防孤儿引用（reason: 'in_use'）
 * @param sources 各源的现标签（FolderSourceConfig.labels，缺省 = 没打标签）
 * @param channels 配对记录（allowedLabels）
 */
export function canDeletePermissionLabel(
  name: string,
  sources: ReadonlyArray<{ slug: string; labels?: string[] }>,
  channels: ReadonlyArray<{ allowedLabels?: string[] }>,
): { ok: boolean; reason?: 'builtin' | 'in_use' } {
  if (name === BUILTIN_PRIVATE_LABEL) return { ok: false, reason: 'builtin' };
  const inUse =
    sources.some((source) => (source.labels ?? []).includes(name)) ||
    channels.some((channel) => (channel.allowedLabels ?? []).includes(name));
  if (inUse) return { ok: false, reason: 'in_use' };
  return { ok: true };
}

/**
 * 源的有效标签集：缺省/空 = 自动套 `['private']`（不写回配置）。
 */
export function sourceLabelSet(labels?: readonly string[] | null): string[] {
  return labels && labels.length > 0 ? [...labels] : [BUILTIN_PRIVATE_LABEL];
}

/**
 * 标签闸（纯函数）：哪些源 slug 可见。
 *  - 闸未启用（gateEnabled 非 true）→ 全放行（零回归）
 *  - 闸启用 + allowedLabels 为空 → 全禁（故意，UI 红警）
 *  - 闸启用 → 源有效标签集与 allowedLabels 有交集才放行
 */
export function gateSourceSlugs(
  slugs: readonly string[],
  labelsBySlug: ReadonlyMap<string, readonly string[]> | null,
  gateEnabled: boolean,
  allowedLabels: readonly string[],
): string[] {
  if (!gateEnabled) return [...slugs];
  if (allowedLabels.length === 0) return [];
  const allowed = new Set(allowedLabels);
  return slugs.filter((slug) => {
    const declared = labelsBySlug?.get(slug);
    const effective = sourceLabelSet(declared);
    return effective.some((label) => allowed.has(label));
  });
}

/** 模式阶梯：safe（严）< ask < allow-all（松）。 */
const MODE_LADDER: readonly PermissionModeCeiling[] = ['safe', 'ask', 'allow-all'];

/**
 * 取更严（B2）：通道天花板 ∩ 助手默认。
 * 双缺省 → undefined（不设天花板）。
 */
/**
 * `a` 是否比 `b` 更严（safe < ask < allow-all；undefined/null = 无天花板，按最松算）。
 * 新钉「会话内手动收紧保护」用：唤醒重算时，当前值若是用户类来源且比重算值严 → 保持。
 */
export function isPermissionModeStricter(
  a: PermissionModeCeiling | null | undefined,
  b: PermissionModeCeiling | null | undefined,
): boolean {
  const ia = a ? MODE_LADDER.indexOf(a) : -1;
  const ib = b ? MODE_LADDER.indexOf(b) : -1;
  if (ia < 0) return false; // 无值不算「更严」
  if (ib < 0) return true;
  return ia < ib;
}

export function stricterPermissionMode(
  channel?: PermissionModeCeiling | null,
  agentDefault?: PermissionModeCeiling | null,
): PermissionModeCeiling | undefined {
  const index = (mode: PermissionModeCeiling | null | undefined): number | undefined =>
    mode === undefined || mode === null ? undefined : MODE_LADDER.indexOf(mode);
  const a = index(channel);
  const b = index(agentDefault);
  if (a === undefined) return agentDefault ?? undefined;
  if (b === undefined) return channel ?? undefined;
  return MODE_LADDER[Math.min(a, b)];
}

export interface ChannelPermission {
  /** H1：gateEnabled 缺省 = 闸关。 */
  gateEnabled: boolean;
  /** 有效放行标签（通道自身 ∪ 配对成员个人域合并，D5；闸关时仅为参考，gateSourceSlugs 直接全放行）。 */
  allowedLabels: string[];
  /** 模式天花板；缺省 = 跟随助手默认。 */
  permissionMode?: PermissionModeCeiling;
  /** 谁配对的（兑换时刻快照）；缺省 = 写保护未启用，群内写回退现有模式门禁（洞 3，对齐 H1 缺省语义）。 */
  pairedBy?: string;
}

/** 个人域的有效标签：闸开 = 放行列表；闸关 = 仅内置 private（D4「无标签源 = 仅自己」）。 */
function personalLabelSet(record: Pick<PairedChannelRecord, 'gateEnabled' | 'allowedLabels'>): string[] {
  return record.gateEnabled === true ? [...(record.allowedLabels ?? [])] : [BUILTIN_PRIVATE_LABEL];
}

/**
 * 解析「渠道 × 发信人」的有效权限（纯函数，直接吃配对记录，可单测）。
 *
 * D5 合并：群渠道里，发信人是已配对个人账号（存在 pairedBy 相同且
 * channelKind='private' 的配对渠道）时，其个人域标签合并进有效集；
 * **模式不升格**（天花板只取渠道自身的 permissionMode）。
 */
export function resolveChannelPermission(
  records: readonly PairedChannelRecord[],
  channelKey: string,
  senderId?: string,
): ChannelPermission {
  const record = records.find((entry) => entry.channelKey === channelKey && entry.pairedAt > 0);
  if (!record) return { gateEnabled: false, allowedLabels: [] };

  const gateEnabled = record.gateEnabled === true;
  let allowedLabels = gateEnabled ? [...(record.allowedLabels ?? [])] : [];
  if (gateEnabled && senderId) {
    for (const other of records) {
      if (other.channelKey === channelKey || other.pairedAt <= 0) continue;
      if (other.pairedBy !== senderId || other.channelKind !== 'private') continue;
      allowedLabels.push(...personalLabelSet(other));
    }
    allowedLabels = [...new Set(allowedLabels)];
  }

  const result: ChannelPermission = { gateEnabled, allowedLabels };
  if (record.permissionMode) result.permissionMode = record.permissionMode;
  if (record.pairedBy) result.pairedBy = record.pairedBy;
  return result;
}

/**
 * 唤醒边界收窄规格（钉 3：源 scope + 模式每次唤醒按当前配置重算）。
 *
 * 语义钉死：
 * - 本批通道都没开标签闸 → `enabledSourceSlugs: undefined` = 回落到工作区基线（放宽也生效）；
 * - 有通道开闸 → 从工作区基线逐个通道取交集（不用上次收窄值，防棘轮）；
 * - `permissionMode: null` = 回落基线模式（督导会话创建基线是 allow-all）；
 *   有天花板时取本批最严（stricter 两两合算）。
 */
export interface WakePermissionSpec {
  /** undefined = 回落工作区默认。 */
  enabledSourceSlugs?: string[];
  /** null = 回落基线模式；值 = 本次唤醒天花板。 */
  permissionMode?: PermissionModeCeiling | null;
}

/** 一次唤醒的通道事件批（backlog 项；channelKey 缺省 = 非通道事件）。 */
export type WakeChannelEvent = { channelKey?: string; senderId?: string };

/**
 * 计算唤醒收窄（纯函数）：同渠道×同发信人去重，逐通道取交集 + 最严天花板。
 * @param workspaceSourceSlugs 工作区启用源基线（getEnabledSources）
 * @param labelsBySlug 各源有效标签集（sourceLabelSet；缺省=private）
 */
export function computeWakeNarrowing(
  records: readonly PairedChannelRecord[],
  wakeEvents: readonly WakeChannelEvent[],
  workspaceSourceSlugs: readonly string[],
  labelsBySlug: ReadonlyMap<string, readonly string[]>,
): WakePermissionSpec {
  let slugs = [...workspaceSourceSlugs];
  let ceiling: PermissionModeCeiling | undefined;
  let anyGated = false;
  const seen = new Set<string>();
  for (const wakeEvent of wakeEvents) {
    if (!wakeEvent.channelKey) continue;
    const key = `${wakeEvent.channelKey}\u0000${wakeEvent.senderId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const perm = resolveChannelPermission(records, wakeEvent.channelKey, wakeEvent.senderId);
    if (!perm.gateEnabled) continue;
    anyGated = true;
    slugs = gateSourceSlugs(slugs, labelsBySlug, true, perm.allowedLabels);
    if (perm.permissionMode) ceiling = stricterPermissionMode(ceiling, perm.permissionMode);
  }
  return {
    enabledSourceSlugs: anyGated ? slugs : undefined,
    permissionMode: ceiling ?? null,
  };
}
