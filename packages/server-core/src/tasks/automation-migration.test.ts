import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateAutomationCronTasks } from './automation-migration.ts';
import { TaskService } from './task-service.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'automation-migration-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function service() {
  return new TaskService({
    workspaceRoot: root,
    sessionExists: () => false,
    wakeSupervisor: () => undefined,
  });
}

function writeConfig(matchers: unknown[]) {
  writeFileSync(
    join(root, 'automations.json'),
    JSON.stringify({ automations: { SchedulerTick: matchers } }, null, 2),
    'utf-8',
  );
}

const cronMatcher = (over: Record<string, unknown> = {}) => ({
  id: 'abc123',
  name: '每日巡检',
  cron: '0 9 * * *',
  enabled: true,
  actions: [{ type: 'prompt', prompt: '检查昨天的构建' }],
  ...over,
});

describe('automation → task migration', () => {
  it('imports a cron matcher as a task with a cron trigger', () => {
    writeConfig([cronMatcher()]);
    const svc = service();

    const result = migrateAutomationCronTasks(svc, root);
    expect(result.created).toBe(1);

    const task = svc.list()[0];
    expect(task.name).toBe('每日巡检');
    expect(task.instruction).toBe('检查昨天的构建');
    expect(task.trigger).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
      enabled: true,
      sourceId: 'abc123',
    });
  });

  it('is idempotent across restarts', () => {
    writeConfig([cronMatcher()]);
    const svc = service();
    migrateAutomationCronTasks(svc, root);
    const again = migrateAutomationCronTasks(svc, root);

    expect(again.created).toBe(0);
    expect(again.skipped).toBe(1);
    expect(svc.list()).toHaveLength(1);
  });

  it('skips disabled matchers and matchers without a prompt action', () => {
    writeConfig([
      cronMatcher({ id: 'off', enabled: false }),
      cronMatcher({ id: 'hook', actions: [{ type: 'script', script: 'x.sh' }] }),
    ]);
    const result = migrateAutomationCronTasks(service(), root);
    expect(result.created).toBe(0);
  });

  it('ignores non-cron lifecycle matchers', () => {
    writeFileSync(
      join(root, 'automations.json'),
      JSON.stringify({ automations: { Stop: [{ id: 's1', matcher: '.*', actions: [{ type: 'prompt', prompt: '复盘' }] }] } }),
      'utf-8',
    );
    expect(migrateAutomationCronTasks(service(), root).created).toBe(0);
  });

  it('does nothing when there is no automations file', () => {
    expect(migrateAutomationCronTasks(service(), root)).toEqual({ created: 0, skipped: 0 });
  });
});
