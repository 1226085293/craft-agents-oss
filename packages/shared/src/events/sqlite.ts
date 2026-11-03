/**
 * Minimal synchronous SQLite facade.
 *
 * The Event Center store runs in two runtimes:
 * - Electron main process (Node 22.21) → `node:sqlite` (built in, no flag)
 * - `bun test` → `bun:sqlite` (Bun does not implement `node:sqlite`)
 *
 * Both expose a synchronous prepare/run/get/all API, so one thin interface is
 * enough. Resolution is done through `createRequire` at runtime, which keeps
 * bundlers from trying to resolve `bun:sqlite` in the Electron build.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createRequire } from 'node:module';

export interface SqliteRunResult {
  changes: number | bigint;
}

export interface SqliteStatement {
  run(...params: any[]): SqliteRunResult;
  get(...params: any[]): unknown;
  all(...params: any[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/**
 * Base for `createRequire`. The Electron main bundle is CJS, where
 * `import.meta.url` is empty ("empty-import-meta" warning at build time and a
 * broken require at runtime), so fall back to __filename and finally cwd.
 */
function requireBase(): string {
  try {
    const metaUrl = (import.meta as { url?: string }).url;
    if (metaUrl) return metaUrl;
  } catch {
    // `import.meta` is not available in CJS builds.
  }
  const filename = (globalThis as { __filename?: string }).__filename;
  if (filename) return filename;
  return `${process.cwd()}/`;
}

const nodeRequire = createRequire(requireBase());

function runningUnderBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

/** Open a database. `:memory:` is supported by both runtimes. */
export function openSqlite(path: string): SqliteDatabase {
  if (runningUnderBun()) {
    const { Database } = nodeRequire('bun:sqlite') as { Database: new (p: string) => SqliteDatabase };
    return new Database(path);
  }
  const { DatabaseSync } = nodeRequire('node:sqlite') as {
    DatabaseSync: new (p: string) => SqliteDatabase;
  };
  return new DatabaseSync(path);
}
