import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, createManagedSession } from './SessionManager.ts';
import type { ManagedSession } from './SessionManager.ts';
import { getPermissionModeDiagnostics, setPermissionMode, type PermissionMode } from '@craft-agent/shared/agent';
import type { WakePermissionSpec } from '@craft-agent/shared/events/permissions.ts';

/**
 * v7 slice B (阶段 1 验收清单第 4 条): H1 四态在 SessionManager 层直测
 * `applyWakePermissionCeiling` —— 唤醒边界权限重算的宿主侧落点。
 *
 * 轻量 harness：new SessionManager() + createManagedSession + 注入 sessions map
 * （同 auth-retry-message-reuse.test.ts 的惯例）。
 */
describe('applyWakePermissionCeiling (H1 四态, SessionManager 层)', () => {
  let tmpRoot: string;
  let sm: SessionManager;
  let managed: ManagedSession;
  // mode-manager 是进程级全局 store（按 session id 键控）：每用例唯一 id，防跨用例串味
  let seq = 0;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'craft-wake-perm-'));
    sm = new SessionManager();
    const workspace = {
      id: 'ws_test',
      name: 'Wake Perm Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    };
    managed = createManagedSession(
      { id: `sess_gate_${++seq}`, name: '督导 · 用户', role: 'supervisor' },
      workspace as never,
      { messagesLoaded: true },
    );
    managed.permissionMode = 'allow-all'; // 督导会话创建基线
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('① 老记录（闸关）回落基线：slugs 还原 + 模式回 allow-all + changedBy=channel-gate', () => {
    // 先模拟上一次开闸唤醒留下的收紧态
    managed.enabledSourceSlugs = ['co'];
    managed.permissionMode = 'safe';
    sm.applyWakePermissionCeiling(managed.id, { enabledSourceSlugs: undefined, permissionMode: null });
    expect(managed.enabledSourceSlugs).toBeUndefined();
    // 断言处放宽：上方的 `= 'safe'` 赋值让 TS 把该字段窄化成了 'safe'，
    // 方法调用（applyWakePermissionCeiling）会改它但 TS 不追踪
    expect(managed.permissionMode as PermissionMode).toBe('allow-all');
    expect(getPermissionModeDiagnostics(managed.id).lastChangedBy).toBe('channel-gate');
  });

  it('② 开闸 + 0 标签：全禁 [] 必须传达到位（不是 undefined）', () => {
    sm.applyWakePermissionCeiling(managed.id, { enabledSourceSlugs: [], permissionMode: null });
    expect(managed.enabledSourceSlugs).toEqual([]);
    // 全禁只砍源，不动模式（本条 spec 的 permissionMode=null = 模式回落）
    expect(managed.permissionMode).toBe('allow-all');
  });

  it('③ 开闸 + 有标签 + 天花板：收窄 + 最严模式落地', () => {
    sm.applyWakePermissionCeiling(managed.id, { enabledSourceSlugs: ['co'], permissionMode: 'safe' });
    expect(managed.enabledSourceSlugs).toEqual(['co']);
    expect(managed.permissionMode).toBe('safe');
  });

  it('④ 幂等：同值再应用不触发新的模式变更', () => {
    sm.applyWakePermissionCeiling(managed.id, { enabledSourceSlugs: ['co'], permissionMode: 'safe' });
    const firstAt = getPermissionModeDiagnostics(managed.id).lastChangedAt;
    sm.applyWakePermissionCeiling(managed.id, { enabledSourceSlugs: ['co'], permissionMode: 'safe' });
    expect(getPermissionModeDiagnostics(managed.id).lastChangedAt).toBe(firstAt);
  });

  it('未知会话 id 不抛（唤醒与落盘竞态的兜底）', () => {
    expect(() => sm.applyWakePermissionCeiling('sess_nope_unused', { permissionMode: null })).not.toThrow();
  });

  it('spec 类型即 WakePermissionSpec（钉 3 契约面）', () => {
    const spec: WakePermissionSpec = { enabledSourceSlugs: undefined, permissionMode: null };
    sm.applyWakePermissionCeiling(managed.id, spec);
    expect(managed.enabledSourceSlugs).toBeUndefined();
  });

  it('新钉：用户会话内手动收紧（safe）→ 唤醒回落/天花板都不覆盖', () => {
    managed.permissionMode = 'safe';
    setPermissionMode(managed.id, 'safe', { changedBy: 'user' });
    // 无天花板唤醒（null = 回落 allow-all）→ 用户 safe 更严，保持
    sm.applyWakePermissionCeiling(managed.id, { permissionMode: null });
    expect(managed.permissionMode as PermissionMode).toBe('safe');
    // 天花板 ask（比用户 safe 松）→ 保持 safe
    sm.applyWakePermissionCeiling(managed.id, { permissionMode: 'ask' });
    expect(managed.permissionMode as PermissionMode).toBe('safe');
  });

  it('新钉：唤醒收紧比用户值更严 → 允许覆盖（配置驱动收紧即时生效）', () => {
    managed.permissionMode = 'ask';
    setPermissionMode(managed.id, 'ask', { changedBy: 'user' });
    sm.applyWakePermissionCeiling(managed.id, { permissionMode: 'safe' });
    expect(managed.permissionMode as PermissionMode).toBe('safe');
  });

  it('新钉：系统/restore 来源的值不受保护（可被唤醒重算覆盖）', () => {
    managed.permissionMode = 'safe';
    setPermissionMode(managed.id, 'safe', { changedBy: 'restore' });
    sm.applyWakePermissionCeiling(managed.id, { permissionMode: null });
    expect(managed.permissionMode as PermissionMode).toBe('allow-all');
  });
});
