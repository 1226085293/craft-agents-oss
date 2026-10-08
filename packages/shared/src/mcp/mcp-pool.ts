/**
 * Centralized MCP Client Pool
 *
 * Owns all MCP source connections in the main Electron process.
 * All backends (Claude, Pi) receive proxy tool definitions
 * and route tool calls through this pool instead of managing MCP connections
 * themselves.
 *
 * Benefits:
 * - One MCP code path for all backends
 * - Shared clients across sessions (e.g., same Linear connection)
 * - No credential cache files — main process has direct access
 * - Runtime source switching without session restart
 */

import { CraftMcpClient, type McpClientConfig, type PoolCallToolOptions, type PoolClient } from './client.ts';
import { ApiSourcePoolClient } from './api-source-pool-client.ts';
import { proxyToolName } from './proxy-tool-name.ts';
import type { SdkMcpServerConfig } from '../agent/backend/types.ts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isLocalMcpEnabled } from '../workspaces/storage.ts';
import { guardLargeResult } from '../utils/large-response.ts';
import {
  saveBinaryResponse,
  detectExtensionFromMagic,
  sanitizeFilename,
} from '../utils/binary-detection.ts';

/**
 * Configuration for an in-process API source server.
 * Used by sync() to connect API sources alongside MCP sources.
 */
export interface ApiServerConfig {
  type: 'sdk';
  instance: McpServer;
}

/**
 * Proxy tool definition — the format passed to backends for registration.
 * Uses mcp__{slug}__{toolName} naming convention.
 */
export interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Result of an MCP tool call, matching the subprocess protocol format.
 */
export interface McpToolResult {
  content: string;
  isError: boolean;
  /** Source slug for error attribution (set on failure) */
  sourceSlug?: string;
}

/**
 * Convert SdkMcpServerConfig (used by backend types) to CraftMcpClient config.
 */
function sdkConfigToClientConfig(config: SdkMcpServerConfig): McpClientConfig | null {
  if (config.type === 'http' || config.type === 'sse') {
    return {
      transport: 'http',
      url: config.url,
      headers: config.headers,
    };
  }
  if (config.type === 'stdio') {
    return {
      transport: 'stdio',
      command: config.command,
      args: config.args,
      env: config.env,
    };
  }
  return null;
}

/**
 * Check if an MCP source's config has changed in a way that requires reconnection.
 * Compares auth headers (token refresh) and URL changes.
 * Ignores stdio sources since they don't use OAuth tokens.
 */
function mcpConfigChanged(oldConfig: SdkMcpServerConfig, newConfig: SdkMcpServerConfig): boolean {
  if (oldConfig.type !== newConfig.type) return true;

  if (
    (oldConfig.type === 'http' || oldConfig.type === 'sse') &&
    (newConfig.type === 'http' || newConfig.type === 'sse')
  ) {
    if (oldConfig.url !== newConfig.url) return true;
    const oldAuth = oldConfig.headers?.['Authorization'];
    const newAuth = newConfig.headers?.['Authorization'];
    if (oldAuth !== newAuth) return true;
  }

  return false;
}

export class McpClientPool {
  /** Active MCP clients keyed by source slug */
  private clients = new Map<string, PoolClient>();

  /** Configs used for active MCP connections (for change detection during sync) */
  protected activeConfigs = new Map<string, SdkMcpServerConfig>();

  /**
   * Configs of lazy sources that were synced but are not yet connected.
   * callTool() uses these to spawn the server on first tool use.
   */
  private pendingLazyConfigs = new Map<string, SdkMcpServerConfig>();

  /**
   * Config of lazy sources whose tool defs were already probed (cached).
   * Used to skip repeated probes when sync runs again with an unchanged config.
   */
  private probedLazyConfigs = new Map<string, SdkMcpServerConfig>();

  /**
   * Idle-disconnect timers for CONNECTED lazy sources (on-demand path).
   * After a tool call the source stays connected for this long; if no further
   * call arrives the process is released (defs kept, model still sees tools).
   */
  private lazyIdleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** How long a connected lazy source stays up after its last tool call. */
  private static readonly LAZY_IDLE_DISCONNECT_MS = 30_000;

  /** Cached tool lists keyed by source slug */
  private toolCache = new Map<string, Tool[]>();

  /** Proxy tool name → { slug, originalName } (e.g., "mcp__linear__createIssue" → { slug: "linear", originalName: "createIssue" }) */
  private proxyTools = new Map<string, { slug: string; originalName: string }>();

  /** Optional debug logger */
  private debugFn: ((msg: string) => void) | undefined;

  /** Workspace root path for local MCP filtering */
  private workspaceRootPath?: string;

  /** Session storage path for saving large responses */
  private sessionPath?: string;

  /** Summarize callback for large response handling */
  private summarizeCallback?: (prompt: string) => Promise<string | null>;

  /** Called after sync() connects/disconnects sources, so clients can be notified */
  onToolsChanged?: () => void;

  constructor(options?: { debug?: (msg: string) => void; workspaceRootPath?: string; sessionPath?: string }) {
    this.debugFn = options?.debug;
    this.workspaceRootPath = options?.workspaceRootPath;
    this.sessionPath = options?.sessionPath;
  }

  /**
   * Set the summarize callback for large response handling.
   * Typically called after agent creation: pool.setSummarizeCallback(agent.getSummarizeCallback())
   */
  setSummarizeCallback(fn: (prompt: string) => Promise<string | null>): void {
    this.summarizeCallback = fn;
  }

  private debug(msg: string): void {
    this.debugFn?.(`[McpClientPool] ${msg}`);
  }

  /**
   * True when this source config is marked for lazy (on-demand) connection.
   * Only stdio subprocess sources support lazy; anything else connects eagerly.
   */
  private isLazyConfig(config: SdkMcpServerConfig): boolean {
    return config.type === 'stdio' && config.lazy === true;
  }

  /**
   * Generates proxy tool definitions ALSO for lazy (not-yet-connected) sources
   * is intentionally NOT done here: lazy sources have no tool list until they
   * connect. getProxyToolDefs only covers connected sources; a lazy source's
   * first tool call is routed through on-demandConnect below, and its tools
   * appear in the pool after connection (toolsChanged notifies subprocesses).
   */

  // ============================================================
  // Connection Lifecycle
  // ============================================================

  /**
   * Register a client: connect, cache tools, build proxy mappings.
   * Shared logic for both remote MCP and in-process API sources.
   */
  protected async registerClient(slug: string, client: PoolClient): Promise<void> {
    // listTools() triggers connect() internally for both CraftMcpClient and ApiSourcePoolClient
    const tools = await client.listTools();
    this.clients.set(slug, client);
    this.registerToolDefs(slug, tools);
  }

  /**
   * Register proxy tool mappings + cache for a source's tool list.
   * Used both by registerClient (live connection) and by lazy probes
   * (definitions exposed to the model, process not kept resident).
   */
  protected registerToolDefs(slug: string, tools: Tool[]): void {
    this.toolCache.set(slug, tools);

    for (const tool of tools) {
      const proxyName = proxyToolName(slug, tool.name);
      const existing = this.proxyTools.get(proxyName);
      if (existing && existing.originalName !== tool.name) {
        // Two distinct MCP tool names sanitized to the same proxy name (e.g.
        // `pat.batch` and `pat_batch`). Keep the first; a silent overwrite would
        // route later calls to the wrong original tool (#864). Known limitation:
        // the skipped tool is not callable this session — deterministic
        // disambiguation (suffixing) is a possible follow-up if this ever hits
        // a real server. Warn loudly so a "missing" tool is diagnosable.
        console.warn(`[McpClientPool] Proxy name collision on ${proxyName} (source ${slug}): keeping ${existing.originalName}, skipping ${tool.name} — the skipped tool will not be callable`);
        this.debug(`Proxy name collision on ${proxyName}: keeping ${existing.originalName}, skipping ${tool.name}`);
        continue;
      }
      this.proxyTools.set(proxyName, { slug, originalName: tool.name });
    }

    this.debug(`Source ${slug}: ${tools.length} tools registered`);
  }

  /**
   * Probe a lazy source's tool list without keeping the server process alive.
   * Spawns the stdio subprocess, lists tools, caches the definitions, then
   * disconnects — the process exits until the first real tool call.
   */
  protected async probeLazyTools(slug: string, config: SdkMcpServerConfig): Promise<boolean> {
    const clientConfig = sdkConfigToClientConfig(config);
    if (!clientConfig) {
      this.debug(`Unknown MCP server type for ${slug}: ${(config as { type: string }).type}`);
      return false;
    }
    const client = new CraftMcpClient(clientConfig);
    try {
      const tools = await client.listTools(); // triggers connect()
      this.registerToolDefs(slug, tools);
      this.activeConfigs.set(slug, config);
      this.debug(`Lazy source ${slug} probed: ${tools.length} tools`);
      return true;
    } finally {
      await client.close().catch(() => {});
    }
  }

  /**
   * Connect to an MCP source server (remote HTTP/SSE/stdio).
   * If already connected, this is a no-op.
   */
  async connect(slug: string, config: SdkMcpServerConfig): Promise<void> {
    if (this.clients.has(slug)) return;
    const clientConfig = sdkConfigToClientConfig(config);
    if (!clientConfig) {
      this.debug(`Unknown MCP server type for ${slug}: ${(config as { type: string }).type}`);
      return;
    }
    await this.registerClient(slug, new CraftMcpClient(clientConfig));
    this.activeConfigs.set(slug, config);
  }

  /**
   * Connect to an in-process MCP server (API source) via in-memory transport.
   */
  async connectInProcess(slug: string, mcpServer: McpServer): Promise<void> {
    if (this.clients.has(slug)) return;
    await this.registerClient(slug, new ApiSourcePoolClient(mcpServer));
  }

  /**
   * Ensure one source is connected with the given config, without touching
   * other pool members (unlike sync(), which reconciles the full set).
   * Reconnects when the config changed (e.g. refreshed OAuth token), and
   * applies the same local-MCP gate as sync(): stdio configs are refused
   * when local MCP is disabled for this workspace.
   *
   * @throws Error for stdio configs while local MCP is disabled, and on
   *   connection failure (propagated from connect()).
   */
  async ensureConnected(slug: string, config: SdkMcpServerConfig): Promise<void> {
    if (config.type === 'stdio' && this.workspaceRootPath && !isLocalMcpEnabled(this.workspaceRootPath)) {
      throw new Error(`Local MCP is disabled for this workspace — cannot connect stdio source "${slug}"`);
    }

    if (this.clients.has(slug)) {
      const oldConfig = this.activeConfigs.get(slug);
      if (!oldConfig || !mcpConfigChanged(oldConfig, config)) return;
      this.debug(`Config changed for ${slug}, reconnecting with fresh credentials`);
      await this.disconnect(slug);
    }

    await this.connect(slug, config);
  }

  /**
   * Arm (or reset) the idle-disconnect timer for a connected lazy source.
   * After LAZY_IDLE_DISCONNECT_MS without another call the process is
   * released — tool definitions stay registered so the model still sees the
   * tools and the next callTool reconnects seamlessly.
   */
  private armLazyIdleDisconnect(slug: string): void {
    if (!this.clients.has(slug) || !this.pendingLazyConfigs.has(slug)) return;

    const existing = this.lazyIdleTimers.get(slug);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.lazyIdleTimers.delete(slug);
      if (this.clients.has(slug) && this.pendingLazyConfigs.has(slug)) {
        this.debug(`Lazy source ${slug}: idle ${McpClientPool.LAZY_IDLE_DISCONNECT_MS / 1000}s after last use — releasing process (defs kept)`);
        void this.disconnect(slug, true).catch(() => {});
      }
    }, McpClientPool.LAZY_IDLE_DISCONNECT_MS);
    (timer as { unref?: () => void }).unref?.();
    this.lazyIdleTimers.set(slug, timer);
  }

  private clearLazyIdleTimer(slug: string): void {
    const timer = this.lazyIdleTimers.get(slug);
    if (timer) {
      clearTimeout(timer);
      this.lazyIdleTimers.delete(slug);
    }
  }

  /**
   * Disconnect a source and (by default) remove its tools from the pool.
   *
   * @param keepDefs - When true, the proxy tool mappings + cached tool list
   *   for this slug are preserved even though the client is closed. Used by
   *   the lazy on-demand path: the model keeps seeing the tools, and the next
   *   callTool reconnects without a fresh probe.
   */
  async disconnect(slug: string, keepDefs = false): Promise<void> {
    this.clearLazyIdleTimer(slug);

    const client = this.clients.get(slug);
    if (client) {
      await client.close().catch(() => {});
      this.clients.delete(slug);
    }

    if (!keepDefs) {
      // Remove proxy tool entries for this slug
      for (const [proxyName, info] of this.proxyTools) {
        if (info.slug === slug) this.proxyTools.delete(proxyName);
      }
      this.toolCache.delete(slug);
      this.pendingLazyConfigs.delete(slug);
      this.probedLazyConfigs.delete(slug);
    }
    this.activeConfigs.delete(slug);
    this.debug(`Disconnected source: ${slug}${keepDefs ? ' (defs kept)' : ''}`);
  }

  /**
   * Disconnect all sources and clear all state.
   */
  async disconnectAll(): Promise<void> {
    for (const timer of this.lazyIdleTimers.values()) clearTimeout(timer);
    this.lazyIdleTimers.clear();

    const closePromises = Array.from(this.clients.values()).map(c => c.close().catch(() => {}));
    await Promise.all(closePromises);
    this.clients.clear();
    this.toolCache.clear();
    this.proxyTools.clear();
    this.activeConfigs.clear();
    this.pendingLazyConfigs.clear();
    this.probedLazyConfigs.clear();
    this.debug('Disconnected all MCP clients');
  }

  // ============================================================
  // Sync: Reconcile active sources
  // ============================================================

  /**
   * Sync the pool to match a desired set of MCP + API sources.
   * Connects new sources, disconnects removed ones, keeps existing ones.
   *
   * @param mcpServers - Map of slug → config for desired MCP sources
   * @param apiServers - Map of slug → config for desired API sources
   * @returns List of slugs that failed to connect
   */
  async sync(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, ApiServerConfig> = {}
  ): Promise<string[]> {
    // Filter out stdio sources when local MCP is disabled for this workspace.
    const localEnabled = !this.workspaceRootPath || isLocalMcpEnabled(this.workspaceRootPath);
    const filteredMcp: Record<string, SdkMcpServerConfig> = {};
    for (const [slug, config] of Object.entries(mcpServers)) {
      if (config.type === 'stdio' && !localEnabled) {
        this.debug(`Filtering out stdio source "${slug}" (local MCP disabled)`);
        continue;
      }
      filteredMcp[slug] = config;
    }

    // Extract McpServer instances from API configs
    const apiSlugs = new Map<string, McpServer>();
    for (const [slug, config] of Object.entries(apiServers)) {
      if (config?.type === 'sdk' && config.instance) {
        apiSlugs.set(slug, config.instance);
      }
    }

    const desiredSlugs = new Set([...Object.keys(filteredMcp), ...apiSlugs.keys()]);
    const currentSlugs = new Set(this.clients.keys());
    const failures: string[] = [];

    // Remember desired configs even for lazy (not-yet-connected) sources so
    // callTool() can connect them on first use.
    for (const [slug, config] of Object.entries(filteredMcp)) {
      if (this.isLazyConfig(config)) {
        this.pendingLazyConfigs.set(slug, config);
      } else {
        this.pendingLazyConfigs.delete(slug);
      }
    }

    // Disconnect sources no longer desired
    for (const slug of currentSlugs) {
      if (!desiredSlugs.has(slug)) {
        await this.disconnect(slug);
      }
    }

    // Connect new MCP sources + reconnect existing ones whose config changed (e.g. refreshed token)
    for (const [slug, config] of Object.entries(filteredMcp)) {
      // Lazy sources: don't keep a resident process. Probe once to learn the
      // tool definitions (so the model can call them), then disconnect — the
      // process is spawned again on first actual tool call. Skip re-probe when
      // defs are already registered with an unchanged config.
      if (!currentSlugs.has(slug) && this.isLazyConfig(config)) {
        const cached = this.toolCache.get(slug);
        const cachedConfig = this.probedLazyConfigs.get(slug);
        if (cached && cachedConfig && !mcpConfigChanged(cachedConfig, config)) {
          this.debug(`Lazy source ${slug}: using cached tool defs (${cached.length} tools)`);
          continue;
        }
        this.debug(`Lazy source ${slug}: probing tool list without keeping process`);
        try {
          const done = await this.probeLazyTools(slug, config);
          if (done) this.probedLazyConfigs.set(slug, config);
          else failures.push(slug);
        } catch (err) {
          this.debug(`Lazy probe failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`);
          failures.push(slug);
        }
        continue;
      }
      if (!currentSlugs.has(slug)) {
        try {
          await this.connect(slug, config);
        } catch (err) {
          // 单 writer 型 MCP（如 codegraph）可能正被其他会话短暂占用：延迟重试一次再放弃
          const first = err instanceof Error ? err.message : String(err);
          this.debug(`Failed to connect MCP source ${slug}: ${first}; retrying once after 1.5s`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          try {
            await this.connect(slug, config);
          } catch (err2) {
            this.debug(`Failed to connect MCP source ${slug} after retry: ${err2 instanceof Error ? err2.message : String(err2)}`);
            failures.push(slug);
          }
        }
      } else {
        const oldConfig = this.activeConfigs.get(slug);
        if (oldConfig && mcpConfigChanged(oldConfig, config)) {
          this.debug(`Config changed for ${slug}, reconnecting with fresh credentials`);
          await this.disconnect(slug);
          try {
            await this.connect(slug, config);
          } catch (err) {
            this.debug(`Failed to reconnect MCP source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
            failures.push(slug);
          }
        }
      }
    }

    // Connect new API sources
    for (const [slug, server] of apiSlugs) {
      if (!currentSlugs.has(slug)) {
        try {
          await this.connectInProcess(slug, server);
        } catch (err) {
          this.debug(`Failed to connect API source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
          failures.push(slug);
        }
      }
    }

    this.onToolsChanged?.();
    return failures;
  }

  // ============================================================
  // Tool Discovery
  // ============================================================

  /**
   * Get cached tools for a source. Returns empty array if not connected.
   */
  getTools(slug: string): Tool[] {
    return this.toolCache.get(slug) || [];
  }

  /**
   * Get all connected source slugs.
   */
  getConnectedSlugs(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Check if a source is connected.
   */
  isConnected(slug: string): boolean {
    return this.clients.has(slug);
  }

  /**
   * Generate proxy tool definitions for all connected sources (or a subset).
   * These are passed to backends for tool registration.
   */
  getProxyToolDefs(slugs?: string[]): ProxyToolDef[] {
    const targetSlugs = slugs || Array.from(this.toolCache.keys());
    const defs: ProxyToolDef[] = [];
    const seen = new Set<string>();

    for (const slug of targetSlugs) {
      const tools = this.toolCache.get(slug) || [];
      for (const tool of tools) {
        const name = proxyToolName(slug, tool.name);
        // Skip a name that collided after sanitization — keep the first, matching
        // registerClient so the emitted defs and the dispatch map stay in sync (#864).
        if (seen.has(name)) continue;
        seen.add(name);
        // Strip $schema — AJV (Pi agent) fails on unregistered meta-schema URIs.
        // Same pattern as getToolDefsAsJsonSchema() in tool-defs.ts.
        const { $schema, ...cleanSchema } = (tool.inputSchema as Record<string, unknown>) || {};
        defs.push({
          name,
          description: tool.description || `Tool from ${slug}`,
          inputSchema: Object.keys(cleanSchema).length > 0 ? cleanSchema : { type: 'object', properties: {} },
        });
      }
    }

    return defs;
  }

  // ============================================================
  // Tool Execution
  // ============================================================

  /**
   * Execute an MCP tool by its proxy name (mcp__{slug}__{toolName}).
   * Returns a result matching the subprocess protocol format.
   */
  async callTool(proxyName: string, args: Record<string, unknown>, options?: PoolCallToolOptions): Promise<McpToolResult> {
    const info = this.proxyTools.get(proxyName);
    if (!info) {
      return {
        content: `Unknown MCP proxy tool: ${proxyName}`,
        isError: true,
      };
    }

    const { slug, originalName } = info;

    let client = this.clients.get(slug);
    if (!client) {
      // On-demand connect for lazy sources: the process was not kept resident
      // during sync (see probeLazyTools). Spawn it now, forward the call.
      const lazyConfig = this.pendingLazyConfigs.get(slug);
      if (lazyConfig) {
        this.debug(`Lazy source ${slug}: connecting on demand for ${originalName}`);
        try {
          await this.connect(slug, lazyConfig);
          client = this.clients.get(slug);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: `MCP source "${slug}" failed to connect on demand: ${msg}`,
            isError: true,
            sourceSlug: slug,
          };
        }
      }
    }
    if (!client) {
      return {
        content: `MCP client for source "${slug}" is not connected.`,
        isError: true,
        sourceSlug: slug,
      };
    }

    try {
      const result = await client.callTool(originalName, args, options) as {
        content?: Array<{ type: string; text?: unknown; data?: string; mimeType?: string }>;
        isError?: boolean;
      };

      // Use it and release it: a lazy source stays up briefly after its last
      // call, then the process is disconnected (defs kept, next call reconnects).
      this.armLazyIdleDisconnect(slug);

      const contentBlocks = result.content || [];
      const parts: string[] = [];

      // 1. Process each content block — handle text, image, audio
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          // Handle non-string text fields (e.g., objects from non-conforming servers)
          if (typeof block.text === 'string') {
            parts.push(block.text);
          } else if (block.text !== undefined && block.text !== null) {
            parts.push(JSON.stringify(block.text, null, 2));
          }
        } else if ((block.type === 'image' || block.type === 'audio') && block.data && this.sessionPath) {
          // Decode base64 binary content and save to downloads/
          try {
            const buffer = Buffer.from(block.data, 'base64');
            const ext = detectExtensionFromMagic(buffer) || '.bin';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const safeName = sanitizeFilename(proxyName);
            const filename = `${safeName}_${timestamp}${ext}`;
            const saved = saveBinaryResponse(this.sessionPath, filename, buffer, block.mimeType ?? null);
            if (saved.type === 'file_download') {
              parts.push(`[${block.type.charAt(0).toUpperCase() + block.type.slice(1)} saved: ${saved.path} (${saved.sizeHuman})]`);
            }
          } catch {
            // Base64 decode failed — skip this block
          }
        }
      }

      // 2. Combine parts (fallback to JSON.stringify if no content extracted)
      const text = parts.join('\n') || JSON.stringify(result);

      // 3. Centralized binary + large response handling
      if (!result.isError && this.sessionPath) {
        const guarded = await guardLargeResult(text, {
          sessionPath: this.sessionPath,
          toolName: proxyName,
          input: args,
          summarize: this.summarizeCallback,
        });
        if (guarded) {
          return { content: guarded, isError: false };
        }
      }

      return {
        content: text,
        isError: !!result.isError,
      };
    } catch (err) {
      return {
        content: `MCP tool "${originalName}" (source: ${slug}) failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        sourceSlug: slug,
      };
    }
  }

  /**
   * Check if a tool name is an MCP proxy tool managed by this pool.
   */
  isProxyTool(toolName: string): boolean {
    return this.proxyTools.has(toolName);
  }
}
