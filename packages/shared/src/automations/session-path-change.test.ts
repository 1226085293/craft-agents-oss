/**
 * SessionPathChange payload contract.
 *
 * Creation and deletion are carried by the paths: `oldPath === null` means
 * something was created, `newPath === null` means it was deleted. Matchers must
 * still be able to catch a deletion, hence the oldPath fallback in getMatchValue.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutomationSystem } from './automation-system.ts';
import { getMatchValue } from './utils.ts';

describe('SessionPathChange', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-path-change-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const createSystem = () => new AutomationSystem({
    workspaceRootPath: tempDir,
    workspaceId: 'test-workspace',
  });

  it('should report a created session with an empty oldPath', async () => {
    const system = createSystem();
    const emitSpy = spyOn(system.eventBus, 'emit');

    await system.emitSessionPathChange({
      subject: 'session',
      sessionId: 'session-1',
      sessionName: 'New chat',
      changeType: 'folder',
      oldPath: null,
      newPath: 'folder:f-1',
      workingDirectory: '/tmp/work',
    });

    expect(emitSpy).toHaveBeenCalledWith('SessionPathChange', expect.objectContaining({
      workspaceId: 'test-workspace',
      subject: 'session',
      sessionId: 'session-1',
      changeType: 'folder',
      oldPath: null,
      newPath: 'folder:f-1',
      workingDirectory: '/tmp/work',
    }));

    await system.dispose();
  });

  it('should report a deleted session with an empty newPath', async () => {
    const system = createSystem();
    const emitSpy = spyOn(system.eventBus, 'emit');

    await system.emitSessionPathChange({
      subject: 'session',
      sessionId: 'session-1',
      changeType: 'project',
      oldPath: 'project:p-1',
      newPath: null,
    });

    expect(emitSpy).toHaveBeenCalledWith('SessionPathChange', expect.objectContaining({
      subject: 'session',
      changeType: 'project',
      oldPath: 'project:p-1',
      newPath: null,
    }));

    await system.dispose();
  });

  it('should report folder creation and deletion with subject "folder"', async () => {
    const system = createSystem();
    const emitSpy = spyOn(system.eventBus, 'emit');

    await system.emitSessionPathChange({
      subject: 'folder',
      changeType: 'folder',
      oldPath: null,
      newPath: 'folder:f-2',
    });
    await system.emitSessionPathChange({
      subject: 'folder',
      changeType: 'folder',
      oldPath: 'folder:f-2',
      newPath: null,
    });

    expect(emitSpy).toHaveBeenNthCalledWith(1, 'SessionPathChange', expect.objectContaining({
      subject: 'folder',
      oldPath: null,
      newPath: 'folder:f-2',
    }));
    expect(emitSpy).toHaveBeenNthCalledWith(2, 'SessionPathChange', expect.objectContaining({
      subject: 'folder',
      oldPath: 'folder:f-2',
      newPath: null,
    }));

    await system.dispose();
  });

  it('should match deletions against the oldPath', async () => {
    // Creation/move matches on newPath, deletion falls back to oldPath so a
    // single matcher can track one folder across its whole lifecycle.
    expect(getMatchValue('SessionPathChange', { newPath: 'folder:f-1', oldPath: null })).toBe('folder:f-1');
    expect(getMatchValue('SessionPathChange', { newPath: null, oldPath: 'folder:f-1' })).toBe('folder:f-1');
    expect(getMatchValue('SessionPathChange', { newPath: null, oldPath: null })).toBe('');
  });
});
