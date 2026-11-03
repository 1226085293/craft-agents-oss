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

const nodeRequire = createRequire(import.meta.url);

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
