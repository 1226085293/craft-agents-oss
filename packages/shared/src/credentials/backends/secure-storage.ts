/**
 * Secure Storage Backend
 *
 * Stores credentials in an encrypted file at ~/.craft-agent/credentials.enc
 * Uses AES-256-GCM for authenticated encryption.
 *
 * Encryption key is derived from OS-native hardware UUID using PBKDF2:
 * - macOS: IOPlatformUUID (tied to logic board, never changes)
 * - Windows: MachineGuid from registry (set at OS install)
 * - Linux: /var/lib/dbus/machine-id (set at OS install)
 *
 * This is more stable than the previous hostname-based derivation, which could
 * change with network/DHCP. Legacy credentials are auto-migrated on first load.
 *
 * File format:
 *   [Header - 64 bytes]
 *   ├── Magic: "CRAFT01\0" (8 bytes)
 *   ├── Flags: uint32 LE (4 bytes) - reserved for future use
 *   ├── Salt: 32 bytes (PBKDF2 salt)
 *   ├── Reserved: 20 bytes
 *   [Encrypted Payload]
 *   ├── IV: 12 bytes (random per write)
 *   ├── Auth Tag: 16 bytes (GCM authentication)
 *   └── Ciphertext: variable (encrypted JSON)
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHash,
} from 'crypto';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, copyFileSync, openSync, closeSync, statSync } from 'fs';
import { hostname, userInfo, homedir } from 'os';
import { join, dirname } from 'path';

import type { CredentialBackend } from './types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';
import { credentialIdToAccount, accountToCredentialId } from '../types.ts';

// File location
const CREDENTIALS_DIR = join(homedir(), '.craft-agent');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.enc');
/**
 * 解析出的机器标识落盘位置。一经确定就不再变——它是加密密钥的种子，
 * 每次重启重新解析等于可能换一把钥匙。
 */
const MACHINE_ID_FILE = join(CREDENTIALS_DIR, '.machine-id');
/** 写入锁：避免多个实例「整份覆盖写」互相抹掉条目。 */
const LOCK_FILE = `${CREDENTIALS_FILE}.lock`;
/**
 * 锁等待上限。比必很短：本模块可能在 Electron 主进程同步路径上调用，
 * 同步睡眠会阻塞事件循环；而写入已改成“锁内重载再合并”，少拿一次锁也不会丢数据。
 */
const LOCK_TIMEOUT_MS = 1000;
/** 超过这个年龄的锁视为进程崩溃遗留，可以接管。 */
const LOCK_STALE_MS = 15000;

/** 同步睡眠，供同步路径上的锁重试使用。 */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

// File format constants
const MAGIC_BYTES = Buffer.from('CRAFT01\0');
const HEADER_SIZE = 64;
const MAGIC_SIZE = 8;
const FLAGS_SIZE = 4;
const SALT_SIZE = 32;
const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const KEY_SIZE = 32;

// PBKDF2 iterations (balance security vs startup time)
const PBKDF2_ITERATIONS = 100000;

/**
 * Get stable machine identifier using OS-native hardware UUID.
 * This is far more stable than hostname which can change with network/DHCP.
 * Falls back to username + homedir if hardware UUID unavailable.
 */
function getFallbackMachineId(): string {
  return `${userInfo().username}:${homedir()}`;
}

/** 从操作系统解析机器标识。解析失败返回 null——绝不在这里静默兜底。 */
function resolveOsMachineId(): string | null {
  try {
    if (process.platform === 'darwin') {
      // macOS: IOPlatformUUID - tied to logic board, never changes
      const output = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } else if (process.platform === 'win32') {
      // Windows: MachineGuid from registry - set at OS install
      const output = execSync(
        'reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match?.[1]) return match[1];
    } else {
      // Linux: dbus machine-id - set at OS install
      const machineIdPath = '/var/lib/dbus/machine-id';
      const altPath = '/etc/machine-id';
      if (existsSync(machineIdPath)) {
        return readFileSync(machineIdPath, 'utf-8').trim();
      } else if (existsSync(altPath)) {
        return readFileSync(altPath, 'utf-8').trim();
      }
    }
  } catch {
    // 解析失败交给调用方处理
  }
  return null;
}

/**
 * 机器标识：加密密钥的种子，必须跟进程、跟重启都稳定。
 *
 * 历史故障：`reg query` 偶发失败时这里静默退回 `用户名:home`，等于换了一把
 * 钥匙——于是同一份 credentials.enc 时而「能解开」时而「损坏」，被隔离删除，
 * 凭证反复丢失。所以现在：落盘值优先；否则现场解析并落盘；两者都失败才用
 * 兜底值（且不落盘，留待下次取回真标识）；兜底键同时作为解密候选之一。
 */
function getStableMachineId(): string {
  try {
    if (existsSync(MACHINE_ID_FILE)) {
      const persisted = readFileSync(MACHINE_ID_FILE, 'utf-8').trim();
      if (persisted) return persisted;
    }
  } catch {
    // 读不到就当没有，继续解析
  }

  const resolved = resolveOsMachineId();
  if (resolved) {
    try {
      mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(MACHINE_ID_FILE, resolved, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      // 落盘失败不致命：本次仍用解析值
    }
    return resolved;
  }

  return getFallbackMachineId();
}

/** Internal credential store structure */
interface CredentialStore {
  version: 1;
  credentials: Record<string, StoredCredential>;
  metadata: {
    createdAt: number;
    updatedAt: number;
  };
}

export class SecureStorageBackend implements CredentialBackend {
  readonly name = 'secure-storage';
  readonly priority = 100;

  private cachedStore: CredentialStore | null = null;
  private encryptionKey: Buffer | null = null;
  /** 缓存密钥对应的 salt（hex）。salt 变了必须重新派生，否则会写出解不开的文件。 */
  private encryptionKeySalt: string | null = null;
  private salt: Buffer | null = null;
  /** 上次读/写磁盘时文件的 mtime：用于发现其它实例的写入并重载。 */
  private loadedMtimeMs: number | null = null;
  /** 重入计数：已持锁时的嵌套调用不再重复加锁。 */
  private lockDepth = 0;

  async isAvailable(): Promise<boolean> {
    // File backend is always available - we can always write to filesystem
    return true;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = await this.loadStore();
    if (!store) return null;

    const key = credentialIdToAccount(id);
    return store.credentials[key] || null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    const key = credentialIdToAccount(id);
    // 写前在锁内重新读盘：只改这一条，避免把其它实例刚写的条目整份覆盖掉
    this.mutateStoreSync((store) => {
      store.credentials[key] = credential;
    });
  }

  async delete(id: CredentialId): Promise<boolean> {
    return this.deleteSync(id);
  }

  deleteSync(id: CredentialId): boolean {
    const key = credentialIdToAccount(id);
    let removed = false;
    this.mutateStoreSync((store) => {
      if (!(key in store.credentials)) return false;
      delete store.credentials[key];
      removed = true;
      return true;
    });
    return removed;
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = await this.loadStore();
    if (!store) return [];

    const ids = Object.keys(store.credentials)
      .map(accountToCredentialId)
      .filter((id): id is CredentialId => id !== null);

    if (!filter) return ids;

    return ids.filter((id) => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.workspaceId && id.workspaceId !== filter.workspaceId) return false;
      if (filter.name && id.name !== filter.name) return false;
      return true;
    });
  }

  // ============================================================
  // Private Methods
  // ============================================================

  private async loadStore(): Promise<CredentialStore | null> {
    return this.loadStoreSync();
  }

  private loadStoreSync(): CredentialStore | null {
    // 缓存前先看文件是否被动过（其它实例写入 / 外部恢复），变了就重载
    if (this.cachedStore) {
      if (!this.hasFileChanged()) return this.cachedStore;
      this.resetCache();
    }

    if (!existsSync(CREDENTIALS_FILE)) {
      this.loadedMtimeMs = null;
      return null;
    }

    let fileData: Buffer;
    try {
      fileData = readFileSync(CREDENTIALS_FILE);
    } catch {
      return null;
    }

    const mtimeMs = this.currentMtimeMs();

    // 文件过短 / 魔数不对：隔离（改名，不删除）
    if (fileData.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
      this.handleCorruptedFile('too-small', fileData.length);
      return null;
    }

    if (!fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
      this.handleCorruptedFile('bad-magic', fileData.length);
      return null;
    }

    // Parse header
    // const flags = fileData.readUInt32LE(MAGIC_SIZE); // Reserved for future use
    const salt = fileData.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE);
    this.salt = salt;

    // Extract encrypted data
    const encryptedData = fileData.subarray(HEADER_SIZE);

    // 依次尝试候选键：稳定键 → 兜底键(用户名:home) → 旧版 v1。
    // 历史上兜底键与稳定键相互误判“损坏”，把能解开的文件隔离删除；
    // 现在两者都试，且用非稳定键解开后立即重写成稳定键（自愈）。
    for (const attempt of this.getCandidateKeys(salt)) {
      const store = this.tryDecrypt(encryptedData, attempt.derive());
      if (!store) continue;

      this.cachedStore = store;
      this.loadedMtimeMs = mtimeMs;

      if (attempt.kind !== 'stable') {
        // Migration: 用稳定键重写，避免下次换环境时再次误判
        this.withLock(() => this.saveStoreSync(store));
      }
      return store;
    }

    // 所有候选键都解不开：隔离（改名，不删除）
    this.handleCorruptedFile('no-key-decrypts', fileData.length);
    return null;
  }

  /** 文件是否在本次加载之后被改过（mtime 变化或文件消失）。 */
  private hasFileChanged(): boolean {
    if (!existsSync(CREDENTIALS_FILE)) return true;
    const mtime = this.currentMtimeMs();
    if (mtime === null || this.loadedMtimeMs === null) return true;
    return mtime !== this.loadedMtimeMs;
  }

  private currentMtimeMs(): number | null {
    try {
      return statSync(CREDENTIALS_FILE).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * 解密候选键。
   * stable：落盘/解析出的机器标识（正常路径）
   * fallback：用户名:home（`reg query` 失败时历史上写出过的文件）
   * legacy：旧版 v1 派生（hostname 参与）
   */
  private getCandidateKeys(
    salt: Buffer
  ): Array<{ kind: 'stable' | 'fallback' | 'legacy'; derive: () => Buffer }> {
    const attempts: Array<{
      kind: 'stable' | 'fallback' | 'legacy';
      derive: () => Buffer;
    }> = [{ kind: 'stable', derive: () => this.getEncryptionKey(salt) }];

    const fallbackId = getFallbackMachineId();
    if (fallbackId !== getStableMachineId()) {
      attempts.push({ kind: 'fallback', derive: () => this.deriveKeyFrom(fallbackId, salt) });
    }
    attempts.push({ kind: 'legacy', derive: () => this.getLegacyEncryptionKey(salt) });

    return attempts;
  }

  /**
   * Attempt to decrypt data with given key.
   * Returns parsed store on success, null on failure.
   */
  private tryDecrypt(encryptedData: Buffer, key: Buffer): CredentialStore | null {
    try {
      const iv = encryptedData.subarray(0, IV_SIZE);
      const authTag = encryptedData.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
      const ciphertext = encryptedData.subarray(IV_SIZE + AUTH_TAG_SIZE);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch {
      return null;
    }
  }

  private saveStoreSync(store: CredentialStore): void {
    // Ensure directory exists
    if (!existsSync(CREDENTIALS_DIR)) {
      mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
    }

    // Use existing salt or generate new one
    const salt = this.salt || randomBytes(SALT_SIZE);
    this.salt = salt;

    // Get encryption key
    const key = this.getEncryptionKey(salt);

    // Serialize payload
    const plaintext = Buffer.from(JSON.stringify(store), 'utf8');

    // Generate new IV for each write (critical for GCM security)
    const iv = randomBytes(IV_SIZE);

    // Encrypt
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Build header
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC_BYTES.copy(header, 0);
    header.writeUInt32LE(0, MAGIC_SIZE); // Flags (reserved)
    salt.copy(header, MAGIC_SIZE + FLAGS_SIZE);

    // Combine all parts
    const fileData = Buffer.concat([header, iv, authTag, ciphertext]);

    // Write atomically: write to a temp file first, then rename over the
    // target. A crash/force-kill mid-write leaves the original file intact
    // instead of a half-written corrupted file (which previously caused the
    // credential store to be silently deleted on next load).
    const tmpFile = `${CREDENTIALS_FILE}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpFile, fileData, { mode: 0o600 });
    renameSync(tmpFile, CREDENTIALS_FILE);
    this.cachedStore = store;
    this.loadedMtimeMs = this.currentMtimeMs();
  }

  private getEncryptionKey(salt: Buffer): Buffer {
    const saltHex = salt.toString('hex');
    if (this.encryptionKey && this.encryptionKeySalt === saltHex) return this.encryptionKey;

    // 密钥必须与 salt 一一对应。历史上这里无条件返回缓存值，salt 变了也照用，
    // 会写出「文件头 salt 与密文密钥不匹配」的文件——下次启动就成了“损坏”。
    this.encryptionKey = this.deriveKeyFrom(getStableMachineId(), salt);
    this.encryptionKeySalt = saltHex;
    return this.encryptionKey;
  }

  /** v2 派生：sha256(机器标识 + 'craft-agent-v2') 作为 PBKDF2 口令。 */
  private deriveKeyFrom(machineId: string, salt: Buffer): Buffer {
    // This is far more stable than hostname which can change with network/DHCP
    const seed = createHash('sha256')
      .update(machineId)
      .update('craft-agent-v2') // Bumped version for new key derivation
      .digest();

    // Derive key using PBKDF2
    return pbkdf2Sync(seed, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
  }

  /**
   * Legacy key derivation for migration from v1 (included hostname).
   * Used to decrypt credentials from older versions before re-encrypting with stable key.
   */
  private getLegacyEncryptionKey(salt: Buffer): Buffer {
    const legacyMachineId = createHash('sha256')
      .update(hostname())
      .update(userInfo().username)
      .update(homedir())
      .update('craft-agent-v1')
      .digest();

    return pbkdf2Sync(legacyMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
  }

  /**
   * 隔离无法解密的文件：**改名保留，绝不删除**。
   * 历史上就是 key 漂移造成误判，旧实现 copy 后 unlink，把仍能救回的文件删了。
   */
  private handleCorruptedFile(reason: string, size: number): void {
    if (existsSync(CREDENTIALS_FILE)) {
      const backupPath = `${CREDENTIALS_FILE}.bak-corrupted-${Date.now()}`;
      try {
        renameSync(CREDENTIALS_FILE, backupPath);
      } catch {
        // 改名失败（被其它进程占用等）：至少复制一份，原文件保持不动
        try {
          copyFileSync(CREDENTIALS_FILE, backupPath);
        } catch {
          // best-effort
        }
      }
      // 只记录判定依据与大小，不含任何密钥内容
      console.warn(`[credentials] quarantined store (${reason}, ${size}B)`);
    }
    this.resetCache();
  }

  /** 清空所有进程内缓存（含 salt 对应的密钥）。 */
  private resetCache(): void {
    this.cachedStore = null;
    this.encryptionKey = null;
    this.encryptionKeySalt = null;
    this.salt = null;
    this.loadedMtimeMs = null;
  }

  /** Clear cached data (for testing or forced refresh) */
  clearCache(): void {
    this.resetCache();
  }

  // ============================================================
  // Locking + read-merge-write
  // ============================================================

  /**
   * 在锁内完成「重载 → 修改 → 写回」。
   * 这是多实例（打包版 + dev 版同时跑）不再互相抹掉条目的关键：
   * 写之前一定从磁盘取最新内容，只改动本次涉及的那一条。
   */
  private mutateStoreSync(mutate: (store: CredentialStore) => boolean | void): void {
    this.withLock(() => {
      this.resetCache();
      const loaded = this.loadStoreSync();

      // 在副本上改动：写盘失败时，内存缓存里不能出现「磁盘上并不存在」的幻影条目。
      // cachedStore 由 loadStoreSync 设置为 loaded，只有 saveStoreSync 成功后才换成 draft。
      const draft: CredentialStore = loaded
        ? {
            ...loaded,
            credentials: { ...loaded.credentials },
            metadata: { ...loaded.metadata },
          }
        : this.emptyStore();

      const changed = mutate(draft);
      if (changed === false) return;

      draft.metadata.updatedAt = Date.now();
      this.saveStoreSync(draft);
    });
  }

  private emptyStore(): CredentialStore {
    const now = Date.now();
    return { version: 1, credentials: {}, metadata: { createdAt: now, updatedAt: now } };
  }

  /** 可重入的写入锁；取不到锁时继续执行（宁可不加锁，也不卡死调用方）。 */
  private withLock<T>(fn: () => T): T {
    if (this.lockDepth > 0) {
      this.lockDepth++;
      try {
        return fn();
      } finally {
        this.lockDepth--;
      }
    }

    const release = this.acquireLockSync();
    this.lockDepth = 1;
    try {
      return fn();
    } finally {
      this.lockDepth--;
      release?.();
    }
  }

  /**
   * 取写入锁（文件锁）。失败返回 null——调用方继续执行而不阻塞。
   * 超过 LOCK_STALE_MS 的锁视为进程崩溃遗留，可直接接管。
   */
  private acquireLockSync(): (() => void) | null {
    if (!existsSync(CREDENTIALS_DIR)) {
      try {
        mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
      } catch {
        // 目录建不出来时下游写盘会报错，这里不额外处理
      }
    }

    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(LOCK_FILE, 'wx');
        closeSync(fd);
        return () => {
          try {
            unlinkSync(LOCK_FILE);
          } catch {
            // 已被接管或释放
          }
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') return null;

        // 接管陈旧锁
        try {
          if (Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(LOCK_FILE);
            continue;
          }
        } catch {
          continue; // 锁刚被释放，立刻重试
        }

        if (Date.now() >= deadline) return null;
        sleepSync(20);
      }
    }
  }
}
