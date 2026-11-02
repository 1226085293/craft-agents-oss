import { execFile } from 'node:child_process';

export interface KillProcessTreeResult {
  ok: boolean;
  error?: string;
}

/**
 * Terminate a process and all of its descendants.
 *
 * Windows: taskkill /T /F handles the process tree and detached shims.
 * POSIX: take a ps snapshot, then signal descendants leaf-first before the root.
 *
 * This is best-effort by nature: a process that has already exited, a PID that
 * was reused, a protected process, or a child that detached from the tree may
 * survive. Callers should still force-settle their own lifecycle after the
 * grace period.
 */
export function killProcessTree(pid: number | undefined): Promise<KillProcessTreeResult> {
  return new Promise((resolve) => {
    if (!pid) {
      resolve({ ok: true });
      return;
    }

    if (process.platform === 'win32') {
      execFile(
        'taskkill',
        ['/T', '/F', '/PID', String(pid)],
        { windowsHide: true },
        (error, _stdout, stderr) => {
          resolve(error
            ? { ok: false, error: (stderr || error.message || 'taskkill failed').trim() }
            : { ok: true });
        },
      );
      return;
    }

    execFile('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], (err, stdout) => {
      if (err) {
        try {
          process.kill(pid, 'SIGKILL');
          resolve({ ok: true });
        } catch {
          resolve({ ok: false, error: err.message });
        }
        return;
      }

      const children = new Map<number, number[]>();
      for (const line of stdout.split('\n')) {
        const [pidStr, ppidStr] = line.trim().split(/\s+/) ?? [];
        const current = Number.parseInt(pidStr ?? '', 10);
        const parent = Number.parseInt(ppidStr ?? '', 10);
        if (Number.isNaN(current) || Number.isNaN(parent)) continue;
        const list = children.get(parent) ?? [];
        list.push(current);
        children.set(parent, list);
      }

      const order: number[] = [];
      const stack = [pid];
      while (stack.length > 0) {
        const current = stack.pop()!;
        order.push(current);
        for (const child of children.get(current) ?? []) stack.push(child);
      }

      let failure: string | undefined;
      for (const current of order.reverse()) {
        try {
          process.kill(current, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            failure = error instanceof Error ? error.message : String(error);
          }
        }
      }
      resolve(failure ? { ok: false, error: failure } : { ok: true });
    });
  });
}
