import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  BUILTIN_PRIVATE_LABEL,
  addPermissionLabel,
  assertLabelsInVocabulary,
  canDeletePermissionLabel,
  computeWakeNarrowing,
  gateSourceSlugs,
  isPermissionModeStricter,
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

describe('H1 空值语义四态 + ⑤ pairedBy（阶段 1 验收标准）', () => {
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

  it('⑤ 老群无 pairedBy + 助手默认 allow-all → 写保护未启用（白名单关），写操作照旧放行（零回归）', () => {
    const records = [rec({ channelKey: G, pairedAt: 1 })]; // pairedBy 未记录
    const perm = resolveChannelPermission(records, G, 'ANYONE');
    // 白名单未启用：不拒绝任何人的写（拒绝/escalation 规则挂阶段 2，本层不得引入全禁语义）
    expect(perm.pairedBy).toBeUndefined();
    expect(perm.gateEnabled).toBe(false);
    expect(perm.permissionMode).toBeUndefined();
    // 源全放行 + 模式回退助手默认 = 升级前行为
    expect(gateSourceSlugs(['a', 'b'], new Map(), perm.gateEnabled, perm.allowedLabels)).toEqual(['a', 'b']);
    expect(stricterPermissionMode(perm.permissionMode, 'allow-all')).toBe('allow-all');
  });
});

describe('isPermissionModeStricter（新钉：会话内手动收紧保护）', () => {
  it('更严值 = true（safe 最严；无值不算更严）', () => {
    expect(isPermissionModeStricter('safe', 'ask')).toBe(true);
    expect(isPermissionModeStricter('safe', 'allow-all')).toBe(true);
    expect(isPermissionModeStricter('safe', undefined)).toBe(true);
    expect(isPermissionModeStricter('ask', 'allow-all')).toBe(true);
  });

  it('更松/相等/无值 = false', () => {
    expect(isPermissionModeStricter('allow-all', 'safe')).toBe(false);
    expect(isPermissionModeStricter('ask', 'safe')).toBe(false);
    expect(isPermissionModeStricter('safe', 'safe')).toBe(false);
    expect(isPermissionModeStricter(undefined, 'safe')).toBe(false);
    expect(isPermissionModeStricter(null, 'safe')).toBe(false);
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

  it('钉 2：首写升 v2 —— 老记录字段保持「不存在」（不补默认值、不写 null）', () => {
    writeFileSync(
      join(root, 'config', 'pairings.json'),
      JSON.stringify({ version: 1, codes: [], channels: [{ channelKey: G, pairedAt: 1700000000000 }] }),
    );
    markChannelPaired(root, P, 2); // 触发一次 save
    const raw = JSON.parse(readFileSync(join(root, 'config', 'pairings.json'), 'utf8')) as {
      version: number;
      channels: Array<Record<string, unknown>>;
    };
    expect(raw.version).toBe(2);
    const legacy = raw.channels.find((entry) => entry.channelKey === G);
    expect(legacy).toBeDefined();
    for (const key of ['permissionMode', 'allowedLabels', 'gateEnabled', 'agentId', 'pairedBy']) {
      expect(legacy).not.toHaveProperty(key);
    }
    // 再读一次：老记录仍是闸关
    expect(resolveChannelPermission(loadPairings(root).channels, G).gateEnabled).toBe(false);
  });
});

describe('computeWakeNarrowing（钉 3 唤醒边界）', () => {
  const labels = new Map<string, string[]>([
    ['s1', ['company']],
    ['s2', ['private']],
    ['s3', []], // 没打标 → 自动 private
  ]);
  const baseline = ['s1', 's2', 's3'];

  it('本批无开闸渠道 → 回落基线（undefined + null）', () => {
    const records = [rec({ channelKey: G, pairedAt: 1 })]; // 老记录 = 闸关
    expect(computeWakeNarrowing(records, [{ channelKey: G, senderId: 'S' }], baseline, labels)).toEqual({
      enabledSourceSlugs: undefined,
      permissionMode: null,
    });
  });

  it('单渠道开闸 → 从基线取交集 + 天花板', () => {
    const records = [rec({ channelKey: G, gateEnabled: true, allowedLabels: ['company'], permissionMode: 'safe' })];
    const spec = computeWakeNarrowing(records, [{ channelKey: G, senderId: 'OTHER' }], baseline, labels);
    expect(spec.enabledSourceSlugs).toEqual(['s1']);
    expect(spec.permissionMode).toBe('safe');
  });

  it('开闸 + 0 标签 → 全禁（[]，不是 undefined）', () => {
    const records = [rec({ channelKey: G, gateEnabled: true, allowedLabels: [] })];
    expect(computeWakeNarrowing(records, [{ channelKey: G }], baseline, labels).enabledSourceSlugs).toEqual([]);
  });

  it('一批两个渠道 → 交集 + 最严天花板', () => {
    const G2 = 'message://telegram/-999';
    const records = [
      rec({ channelKey: G, gateEnabled: true, allowedLabels: ['company', 'private'] }),
      rec({ channelKey: G2, gateEnabled: true, allowedLabels: ['private'], permissionMode: 'ask' }),
    ];
    const spec = computeWakeNarrowing(records, [{ channelKey: G }, { channelKey: G2 }], baseline, labels);
    // G 放行 ['company','private'] → s1,s2,s3（s3 无标签=私有）全过；G2 只放行 ['private'] → s2,s3
    expect(spec.enabledSourceSlugs).toEqual(['s2', 's3']);
    expect(spec.permissionMode).toBe('ask');
  });

  it('D5：配对成员的个人域标签在唤醒时并入', () => {
    const records = [
      rec({ channelKey: G, gateEnabled: true, allowedLabels: ['public'] }),
      rec({ channelKey: P, pairedBy: 'S', channelKind: 'private' }),
    ];
    const spec = computeWakeNarrowing(records, [{ channelKey: G, senderId: 'S' }], baseline, labels);
    // 有效放行 = ['public','private'] → s2/s3（private）过
    expect(spec.enabledSourceSlugs).toEqual(['s2', 's3']);
  });
});

describe('assertLabelsInVocabulary（saveConfig 词表闸，v7 §九③）', () => {
  it('词表内标签（含内置 private）放行', () => {
    addPermissionLabel(root, 'company');
    expect(() => assertLabelsInVocabulary(root, ['company', BUILTIN_PRIVATE_LABEL])).not.toThrow();
  });

  it('空列表放行（= 清除标签，不是打标签）', () => {
    expect(() => assertLabelsInVocabulary(root, [])).not.toThrow();
  });

  it('词表外标签拒绝且报错点名', () => {
    addPermissionLabel(root, 'company');
    expect(() => assertLabelsInVocabulary(root, ['ghost-label'])).toThrow('ghost-label');
  });

  it('重复/混合未知标签各报一次', () => {
    expect(() => assertLabelsInVocabulary(root, ['ghost', 'ghost', 'phantom'])).toThrow('ghost, phantom');
  });
});
