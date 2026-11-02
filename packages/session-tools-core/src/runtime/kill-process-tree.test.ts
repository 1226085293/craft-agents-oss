import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { killProcessTree } from './kill-process-tree.ts';

describe('killProcessTree', () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    child = null;
  });

  it('terminates a spawned process', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });

    await new Promise<void>((resolve, reject) => {
      child!.once('spawn', resolve);
      child!.once('error', reject);
    });

    const exited = new Promise<boolean>((resolve) => {
      child!.once('exit', () => resolve(true));
      setTimeout(() => resolve(false), 3_000);
    });

    await killProcessTree(child.pid);
    expect(await exited).toBe(true);
  });
});
