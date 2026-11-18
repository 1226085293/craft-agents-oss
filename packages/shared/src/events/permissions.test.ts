import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_PRIVATE_LABEL,
  addPermissionLabel,
  canDeletePermissionLabel,
  gateSourceSlugs,
  loadPermissionLabels,
  resolveChannelPermission,
  sourceLabelSet,
  stricterPermissionMode,
} from './permissions';
import { loadPairings, markChannelPaired, redeemPairingCode, generatePairingCode } from './pairings';
import type { PairedChannelRecord } from './pairings';

const G = 'message://telegram/-10012345';
const P = 'message://telegram/8362946740';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-permissions-'));
  mkdirSync(join(root, 'config'), { recursive: true });
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows keeps handles briefly; leftovers are harmless.
  }
});

const rec = (partial: Partial<PairedChannelRecord> & Pick<PairedChannelRecord, 'channelKey'>): PairedChannelRecord => ({
  pairedAt: 1,
  ...partial,
});

describe('H1 空值语义四态（阶段 1 验收标准）', () => {
  it('① 老记录字段全缺 → 闸关，行为与升级前一致（全放行）', () => {
    const records = [rec({ channelKey: G })];
    const perm = resolveChannelPermission(records, G, 'someone');
    expect(perm.gateEnabled).toBe(false);
    // 闸关：源全放行，不管标签
    expect(gateSourceSlugs(['a', 'b', 'c'], new Map(), perm.gateEnabled, perm.allowedLabels)).toEqual(['a', 'b', 'c']);
    // 天花板：缺省 → 不设天花板，现有 allow-all 不受影响
    expect(stricterPermissionMode(perm.permissionMode, 'allow-all')).toBe('allow-all');
  });

  it('② gateEnabled=true + 0 标签 → 全禁', () => {
    const records = [rec({ channelKey: G, gateEnabled: true, allowedLabels: [] })];
    const perm = resolveChannelPermission(records, G);
    expect(perm.gateEnabled).toBe(true);
    expect(perm.allowedLabels).toEqual([]);
    const slugs = gateSourceSlugs(['a', 'b'], new Map([['a', ['company']]]), perm.gateEnabled, perm.allowedLabels);
    expect(slugs).toEqual([]);
  });

  it('③ gateEnabled=true + 有标签 → 只放行交集（无标签源按私有）', () => {
    const records = [rec({ channelKey: G, gateEnabled: true, allowedLabels: ['company'] })];
    const perm = resolveChannelPermission(records, G);
    const labels = new Map<string, string[]>([
      ['a', ['company']],
      ['b', ['private']],
      ['c', []], // 没打标签 → 自动套 private
    ]);
    expect(gateSourceSlugs(['a', 'b', 'c'], labels, perm.gateEnabled, perm.allowedLabels)).toEqual(['a']);
    // 放行 'private' 时，c（无标签=私有）也过
    expect(gateSourceSlugs(['a', 'b', 'c'], labels, true, ['private'])).toEqual(['b', 'c']);
  });

  it('④ permissionMode 缺省 → 不设天花板；设了取更严', () => {
    expect(stricterPermissionMode(undefined, 'allow-all')).toBe('allow-all');
    expect(stricterPermissionMode('safe', 'allow-all')).toBe('safe');
    expect(stricterPermissionMode('ask', 'allow-all')).toBe('ask');
    expect(stricterPermissionMode(undefined, undefined)).toBeUndefined();
    expect(stricterPermissionMode('allow-all', 'safe')).toBe('safe');
  });
});

describe('D5 个人域合并（模式不升格）', () => {
  it('发信人=配对个人账号 → 个人域标签并入有效集', () => {
    const records = [
      rec({ channelKey: G, gateEnabled: true, allowedLabels: ['public'], pairedBy: 'U1' }),
      // 8362946740 是 sender S 的私聊，闸关 → 个人域 = 内置 private
      rec({ channelKey: P, pairedBy: 'S', channelKind: 'private' }),
    ];
    const perm = resolveChannelPermission(records, G, 'S');
    expect(perm.allowedLabels.sort()).toEqual(['private', 'public']);
    // 天花板仍是群自己的（这里缺省 = 无天花板）
    expect(perm.permissionMode).toBeUndefined();
  });

  it('其他成员 → 只有群渠道自身的标签', () => {
    const records = [
      rec({ channelKey: G, gateEnabled: true, allowedLabels: ['public'], pairedBy: 'U1' }),
      rec({ channelKey: P, pairedBy: 'S', channelKind: 'private' }),
    ];
    expect(resolveChannelPermission(records, G, 'OTHER').allowedLabels).toEqual(['public']);
  });

  it('群渠道开了闸时，个人域取其放行列表而非内置 private', () => {
    const records = [
      rec({ channelKey: G, gateEnabled: true, allowedLabels: [] }),
      rec({ channelKey: P, pairedBy: 'S', channelKind: 'private', gateEnabled: true, allowedLabels: ['private', 'company'] }),
    ];
    expect(resolveChannelPermission(records, G, 'S').allowedLabels.sort()).toEqual(['company', 'private']);
  });
});

describe('标签词表', () => {
  it('缺文件 → 默认内置 private', () => {
    const file = loadPermissionLabels(root);
    expect(file.labels.map((l) => l.name)).toEqual([BUILTIN_PRIVATE_LABEL]);
    expect(file.labels[0]?.builtin).toBe(true);
  });

  it('新增/重名/内置 private 拒绝写入', () => {
    expect(addPermissionLabel(root, 'company')).toBe(true);
    expect(addPermissionLabel(root, 'company')).toBe(false);
    expect(addPermissionLabel(root, 'private')).toBe(false);
    const file = loadPermissionLabels(root);
    expect(file.labels.map((l) => l.name)).toContain('company');
  });

  it('删除校验：内置锁死 / 被引用阻止', () => {
    const sources = [
      { slug: 'a', labels: ['company'] },
      { slug: 'b' },
    ];
    const channels = [rec({ channelKey: G, gateEnabled: true, allowedLabels: ['company', 'ops'] })];
    expect(canDeletePermissionLabel('private', sources, channels)).toEqual({ ok: false, reason: 'builtin' });
    expect(canDeletePermissionLabel('company', sources, channels)).toEqual({ ok: false, reason: 'in_use' });
    expect(canDeletePermissionLabel('ops', sources, channels)).toEqual({ ok: false, reason: 'in_use' });
    expect(canDeletePermissionLabel('unused', sources, channels)).toEqual({ ok: true });
  });
});

describe('sourceLabelSet', () => {
  it('缺省/空 → 自动套 private；已打标原样', () => {
    expect(sourceLabelSet(undefined)).toEqual([BUILTIN_PRIVATE_LABEL]);
    expect(sourceLabelSet([])).toEqual([BUILTIN_PRIVATE_LABEL]);
    expect(sourceLabelSet(['company'])).toEqual(['company']);
  });
});

describe('pairings v2（v1 老文件零回归 + 身份快照）', () => {
  it('v1 老文件读入：记录不回填、闸关', () => {
    writeFileSync(
      join(root, 'config', 'pairings.json'),
      JSON.stringify({ version: 1, codes: [], channels: [{ channelKey: G, pairedAt: 1700000000000 }] }, null, 2),
    );
    const file = loadPairings(root);
    const record = file.channels.find((entry) => entry.channelKey === G);
    expect(record).toBeDefined();
    expect(record?.gateEnabled).toBeUndefined();
    expect(record?.pairedBy).toBeUndefined();
    expect(resolveChannelPermission(file.channels, G).gateEnabled).toBe(false);
  });

  it('markChannelPaired 带 pairedBy 写入快照', () => {
    markChannelPaired(root, P, 1, 'S');
    const record = loadPairings(root).channels.find((entry) => entry.channelKey === P);
    expect(record?.pairedBy).toBe('S');
    expect(record?.gateEnabled).toBeUndefined();
  });

  it('redeemPairingCode 带身份快照（pairedBy/channelKind）', () => {
    const { code } = generatePairingCode(root);
    const result = redeemPairingCode(root, code, G, undefined, 'U1', 'group');
    expect(result).toEqual({ ok: true });
    const record = loadPairings(root).channels.find((entry) => entry.channelKey === G);
    expect(record?.pairedBy).toBe('U1');
    expect(record?.channelKind).toBe('group');
  });
});
