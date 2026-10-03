import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const configDir = mkdtempSync(join(tmpdir(), 'skill-read-usage-'))
const sessionManagerUrl = new URL('./SessionManager.ts', import.meta.url).href
const usageUrl = new URL('../../../shared/src/usage/index.ts', import.meta.url).href

describe('SessionManager skill Read usage tracking', () => {
  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true })
  })

  it('counts each successful skill-file Read and ignores failures and ordinary files', () => {
    const script = `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { tmpdir } from 'node:os';
      import { SessionManager, createManagedSession } from ${JSON.stringify(sessionManagerUrl)};
      import { getUsageStats } from ${JSON.stringify(usageUrl)};

      const workspaceRootPath = join(tmpdir(), 'skill-read-usage-workspace');
      const workingDirectory = join(workspaceRootPath, 'project');
      const skillFile = join(workingDirectory, '.agents', 'skills', 'demo', 'references', 'guide.md');
      const ordinaryFile = join(workingDirectory, 'README.md');
      mkdirSync(join(workingDirectory, '.agents', 'skills', 'demo', 'references'), { recursive: true });
      writeFileSync(skillFile, 'skill reference');
      writeFileSync(ordinaryFile, 'ordinary file');

      const manager = Object.create(SessionManager.prototype);
      manager.pendingDeltas = new Map();
      manager.deltaFlushTimers = new Map();
      manager.sendEvent = () => {};
      manager.persistSession = () => {};
      manager.flushSession = async () => {};
      manager.monotonic = () => Date.now();
      manager.getBrowserPaneManagerForSession = () => undefined;

      const managed = createManagedSession({
        id: 'skill-read-usage-session',
        workingDirectory,
        messagesLoaded: true,
      }, {
        id: 'w',
        slug: 'w',
        name: 'Test',
        rootPath: workspaceRootPath,
        createdAt: Date.now(),
      });
      const fire = (event) => manager.processEvent(managed, event);
      const readStart = (toolUseId, filePath) => fire({
        type: 'tool_start',
        toolName: 'Read',
        toolUseId,
        input: { file_path: filePath },
      });
      const readResult = (toolUseId, result, isError) => fire({
        type: 'tool_result',
        toolName: 'Read',
        toolUseId,
        result,
        isError,
      });

      await readStart('success-1', skillFile);
      await readResult('success-1', 'contents', false);
      await readResult('success-1', 'duplicate result', false);
      await readStart('failure-1', skillFile);
      await readResult('failure-1', 'Error: file read failed', true);
      await readStart('success-2', skillFile);
      await readResult('success-2', 'contents again', false);
      await readStart('ordinary-1', ordinaryFile);
      await readResult('ordinary-1', 'ordinary contents', false);

      console.log(JSON.stringify(getUsageStats({ workspaceId: 'w' })));
    `
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: process.cwd(),
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    const outputLines = result.stdout.toString().trim().split(/\r?\n/)
    const statsLine = outputLines.find(line => line.startsWith('{"sources"'))
    expect(statsLine).toBeDefined()
    const stats = JSON.parse(statsLine!) as {
      skills: Record<string, { useCount: number; lastUsedAt: number }>
    }
    expect(stats.skills.demo?.useCount).toBe(2)
    expect(stats.skills.demo?.lastUsedAt).toBeTypeOf('number')
    expect(stats.skills.readme).toBeUndefined()
  }, 15_000)
})
