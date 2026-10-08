/**
 * MCP client using official @modelcontextprotocol/sdk
 * Supports both HTTP and stdio transports for remote and local MCP servers
 */

import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * HTTP transport config for remote MCP servers
 */
export interface HttpMcpClientConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * Stdio transport config for local MCP servers (spawns subprocess)
 */
export interface StdioMcpClientConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Unified config supporting both transport types
 */
export type McpClientConfig = HttpMcpClientConfig | StdioMcpClientConfig;

/**
 * Sensitive environment variables that should NOT be passed to MCP subprocesses.
 * These could contain API keys, tokens, or credentials that MCP servers don't need
 * and shouldn't have access to.
 * NOTE: This list is duplicated in packages/session-tools-core/src/handlers/transform-data.ts (BLOCKED_ENV_VARS).
 * If you add a new entry here, update it there too.
 */
const BLOCKED_ENV_VARS = [
  // Craft Agent auth (set by the app itself)
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',

  // AWS credentials
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',

  // Common API keys/tokens
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
];

/**
 * Per-call options for PoolClient.callTool.
 * Forwarded to the MCP SDK's RequestOptions so aborts become protocol-level
 * cancellation notifications instead of orphaned in-flight requests.
 */
export interface PoolCallToolOptions {
  /** Cancels the in-flight request when aborted */
  signal?: AbortSignal;
  /** Request timeout in ms (SDK default applies when omitted) */
  timeoutMs?: number;
}

/**
 * Interface for clients managed by McpClientPool.
 * Both CraftMcpClient (remote MCP sources) and ApiSourcePoolClient (API sources) implement this.
 */
export interface PoolClient {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: PoolCallToolOptions): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Kill a subprocess and its ENTIRE descendant tree.
 *
 * The MCP SDK's StdioClientTransport.close() only terminates the direct
 * child (SIGTERM/SIGKILL on a single PID). Sources that spawn nested
 * processes — e.g. codegraph's npm-shim → rust kernel, or chrome-devtools-mcp
 * spawned through cmd.exe → node → telemetry watchdog — leave every
 * grandchild orphaned after close. Over hours of reload storms those orphans
 * accumulate into tens of node.exe processes eating hundreds of MB each.
 *
 * Windows: `taskkill /T /F` recursively terminates the whole tree.
 * POSIX: walk `ps` output and signal descendants leaf-first.
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve());
      return;
    }

    // POSIX fallback: collect descendants via ps, kill leaf-first then root.
    execFile('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], (err, stdout) => {
      if (err) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        resolve();
        return;
      }
      const children = new Map<number, number[]>();
      for (const line of stdout.split('\n')) {
        const [pidStr, ppidStr] = line.trim().split(/\s+/) ?? [];
        const p = parseInt(pidStr ?? '', 10);
        const pp = parseInt(ppidStr ?? '', 10);
        if (Number.isNaN(p) || Number.isNaN(pp)) continue;
        const list = children.get(pp) ?? [];
        list.push(p);
        children.set(pp, list);
      }
      const order: number[] = [];
      const stack = [pid];
      while (stack.length) {
        const cur = stack.pop()!;
        order.push(cur);
        for (const c of children.get(cur) ?? []) stack.push(c);
      }
      for (const p of order.reverse()) {
        try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ }
      }
      resolve();
    });
  });
}

export class CraftMcpClient {
  private client: Client;
  private transport: Transport;
  private stdioTransport: StdioClientTransport | null = null;
  /** PID of the spawned stdio subprocess (set after spawn; used for tree-kill). */
  private stdioPid: number | null = null;
  private connected = false;

  constructor(config: McpClientConfig) {
    this.client = new Client({
      name: 'craft-agent',
      version: '1.0.0',
    });

    // Create transport based on config type
    if (config.transport === 'stdio') {
      // Stdio transport for local MCP servers - merge with process env,
      // but filter out sensitive credentials to prevent leaking secrets to subprocesses
      const processEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
          processEnv[key] = value;
        }
      }
      const stdioTransport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...processEnv, ...config.env },
      });
      this.stdioTransport = stdioTransport;
      this.transport = stdioTransport;
    } else {
      // HTTP transport for remote MCP servers
      this.transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: {
            headers: config.headers,
          },
        }
      );
    }
  }

  async listTools(): Promise<Tool[]> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.listTools();
    return result.tools;
  }

  /**
   * Returns server name/version reported during the MCP handshake.
   * Available after `connect()` resolves; undefined otherwise.
   */
  getServerInfo(): { name: string; version: string } | undefined {
    const info = this.client.getServerVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  }

  async callTool(name: string, args: Record<string, unknown>, options?: PoolCallToolOptions): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
    return result;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    // For stdio transports, continuously capture the spawned subprocess PID
    // from the moment the SDK starts it. The SDK's internal close() (fired on
    // handshake failure) nulls out its `_process` reference immediately, so by
    // the time our catch runs the pid is gone — and with it any chance to
    // tree-kill grandchildren (shim → kernel / cmd → node → watchdog).
    const pidCapture = this.stdioTransport
      ? (async () => {
          for (let i = 0; i < 200 && !this.stdioPid; i++) {
            const pid = this.stdioTransport!.pid;
            if (pid) {
              this.stdioPid = pid;
              return;
            }
            await new Promise((r) => setTimeout(r, 25));
          }
        })()
      : Promise.resolve();

    try {
      await this.client.connect(this.transport);
    } catch (error) {
      // Handshake/initialize failed: the SDK's internal close() only kills the
      // direct child — nested grandchildren survive. Kill the full tree
      // (harmless no-op if the capture never found a PID).
      await pidCapture;
      await this.killStdioTree();
      throw error;
    }

    await pidCapture;
    // Session established — ensure the real subprocess PID is recorded.
    this.stdioPid = this.stdioTransport?.pid ?? this.stdioPid;

    // Verify connection works by listing tools
    try {
      await this.client.listTools();
    } catch (error) {
      await this.killStdioTree();
      await this.client.close();
      throw new Error(
        `MCP connection failed health check: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.connected = true;
  }

  /**
   * Kill the stdio subprocess and its entire descendant tree (if any).
   * No-op for non-stdio (HTTP) transports or when nothing was spawned.
   */
  private async killStdioTree(): Promise<void> {
    const pid = this.stdioPid;
    this.stdioPid = null;
    if (pid) {
      await killProcessTree(pid);
    }
  }

  /**
   * Close the connection and ensure the spawned subprocess tree is fully
   * terminated (grandchildren included — see killProcessTree).
   */
  async close(): Promise<void> {
    // Kill the full subprocess tree first; SDK close() alone would only kill
    // the direct child and orphan any nested node processes.
    await this.killStdioTree();
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}
