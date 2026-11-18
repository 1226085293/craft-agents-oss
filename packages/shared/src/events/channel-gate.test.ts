import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimChannelOwnership,
  loadPairings,
  updateChannelGate,
  type PairedChannelRecord,
} from './pairings';
import { addPermissionLabel, loadPermissionLabels, removePermissionLabel } from './permissions';

const G = 'message://telegram/-1001';
const P = 'message://telegram/8362946740';

function v1File(channels: unknown[]): string {
  return JSON.stringify({ version: 1, codes: [], channels });
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-gate-'));
  mkdirSync(join(root, 'config'), { recursive: true });
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows keeps handles briefly; leftovers are harmless.
  }
});

function seed(records: Array<Partial<PairedChannelRecord>>): void {
  writeFileSync(join(root, 'config', 'pairings.json'), v1File(records));
}

describe('updateChannelGate', () => {
  it('补丁字段生效，未出现的字段保持原值（老记录零回归）', () => {
    seed([{ channelKey: G, pairedAt: 1, agentId: 'a1', allowedLabels: ['x'] }]);
    const record = updateChannelGate(root, G, { gateEnabled: true, allowedLabels: ['company'] });
    expect(record).not.toBeNull();
    expect(record?.gateEnabled).toBe(true);
    expect(record?.allowedLabels).toEqual(['company']);
    expect(record?.agentId).toBe('a1'); // 未出现在补丁里 → 保持
  });

  it('null 显式清空（agentId）；未配对渠道返回 null', () => {
    seed([{ channelKey: G, pairedAt: 1, agentId: 'a1' }]);
    expect(updateChannelGate(root, G, { agentId: null })?.agentId).toBeUndefined();
    expect(updateChannelGate(root, 'message://telegram/-9999', { gateEnabled: true })).toBeNull();
  });

  it('写入后文件升 v2 且其他记录不受影响', () => {
    seed([
      { channelKey: G, pairedAt: 1 },
      { channelKey: P, pairedAt: 2 },
    ]);
    updateChannelGate(root, G, { permissionMode: 'safe' });
    const file = loadPairings(root);
    expect(file.version).toBe(2);
    expect(file.channels.find((entry) => entry.channelKey === G)?.permissionMode).toBe('safe');
    expect(file.channels.find((entry) => entry.channelKey === P)?.permissionMode).toBeUndefined();
  });
});

describe('claimChannelOwnership（修 2：启用写保护）', () => {
  it('同平台私聊配对存在 → pairedBy 取其 senderId', () => {
    seed([
      { channelKey: G, pairedAt: 1, channelKind: 'group' },
      { channelKey: P, pairedAt: 2, channelKind: 'private', pairedBy: 'S9' },
    ]);
    const result = claimChannelOwnership(root, G);
    expect(result).toEqual({ ok: true, pairedBy: 'S9' });
    expect(loadPairings(root).channels.find((entry) => entry.channelKey === G)?.pairedBy).toBe('S9');
  });

  it('跨平台不算（qq 私聊不能替 telegram 群认领）', () => {
    seed([
      { channelKey: G, pairedAt: 1, channelKind: 'group' },
      { channelKey: 'message://qq/8362946740', pairedAt: 2, channelKind: 'private', pairedBy: 'S9' },
    ]);
    expect(claimChannelOwnership(root, G)).toEqual({ ok: false, reason: 'no_private_pairing' });
  });

  it('未配对渠道 / 同平台无私聊 → 明确 reason', () => {
    seed([{ channelKey: P, pairedAt: 1, channelKind: 'private', pairedBy: 'S9' }]);
    expect(claimChannelOwnership(root, 'message://telegram/-777')).toEqual({ ok: false, reason: 'not_paired' });
    seed([{ channelKey: G, pairedAt: 1 }]);
    expect(claimChannelOwnership(root, G)).toEqual({ ok: false, reason: 'no_private_pairing' });
  });
});

describe('removePermissionLabel', () => {
  it('被源引用 → in_use 阻止删除', () => {
    addPermissionLabel(root, 'company');
    const result = removePermissionLabel(root, 'company', [{ slug: 's1', labels: ['company'] }], []);
    expect(result).toEqual({ ok: false, reason: 'in_use' });
    expect(loadPermissionLabels(root).labels.map((label) => label.name)).toContain('company');
  });

  it('被通道引用 → in_use 阻止删除', () => {
    addPermissionLabel(root, 'ops');
    const channels: Array<Partial<PairedChannelRecord>> = [
      { channelKey: G, pairedAt: 1, gateEnabled: true, allowedLabels: ['ops'] },
    ];
    const result = removePermissionLabel(root, 'ops', [], channels);
    expect(result).toEqual({ ok: false, reason: 'in_use' });
  });

  it('内置 private 锁死 / 无引用可删 / 不存在的 = not_found', () => {
    expect(removePermissionLabel(root, 'private')).toEqual({ ok: false, reason: 'builtin' });
    addPermissionLabel(root, 'tmp');
    expect(removePermissionLabel(root, 'tmp')).toEqual({ ok: true });
    expect(loadPermissionLabels(root).labels.map((label) => label.name)).not.toContain('tmp');
    expect(removePermissionLabel(root, 'ghost')).toEqual({ ok: false, reason: 'not_found' });
  });
});
