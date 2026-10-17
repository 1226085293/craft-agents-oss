/**
 * McpClientPool.ensureConnected: single-source connect/reconnect semantics —
 * connect once, no-op on unchanged config, reconnect on credential change,
 * and the local-MCP gate for stdio configs (same gate sync() applies).
 */

import { describe, test, expect } from 'bun:test';
import { McpClientPool } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

class TestPool extends McpClientPool {
  connectCalls: Array<{ slug: string; config: SdkMcpServerConfig }> = [];
  closedSlugs: string[] = [];

  override async connect(slug: string, config: SdkMcpServerConfig): Promise<void> {
    this.connectCalls.push({ slug, config });
    const self = this;
    const fake: PoolClient = {
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      close: async () => { self.closedSlugs.push(slug); },
    };
    await this.registerClient(slug, fake);
    this.activeConfigs.set(slug, config);
  }
}

function httpConfig(token: string): SdkMcpServerConfig {
  return { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: `Bearer ${token}` } };
}

describe('McpClientPool.ensureConnected', () => {
  test('connects an absent source once', async () => {
    const pool = new TestPool();
    await pool.ensureConnected('craft', httpConfig('a'));
    expect(pool.connectCalls.length).toBe(1);
    expect(pool.isConnected('craft')).toBe(true);
  });

  test('is a no-op when already connected with an unchanged config', async () => {
    const pool = new TestPool();
    await pool.ensureConnected('craft', httpConfig('a'));
    await pool.ensureConnected('craft', httpConfig('a'));
    expect(pool.connectCalls.length).toBe(1);
    expect(pool.closedSlugs).toEqual([]);
  });

  test('reconnects when the auth header changed (token refresh)', async () => {
    const pool = new TestPool();
    await pool.ensureConnected('craft', httpConfig('a'));
    await pool.ensureConnected('craft', httpConfig('b'));
    expect(pool.connectCalls.length).toBe(2);
    expect(pool.closedSlugs).toEqual(['craft']);
    expect(pool.isConnected('craft')).toBe(true);
  });

  test('does not touch other pool members', async () => {
    const pool = new TestPool();
    await pool.ensureConnected('one', httpConfig('a'));
    await pool.ensureConnected('two', httpConfig('x'));
    await pool.ensureConnected('one', httpConfig('b')); // reconnect 'one' only
    expect(pool.isConnected('two')).toBe(true);
    expect(pool.closedSlugs).toEqual(['one']);
  });

  test('refuses stdio configs when local MCP is disabled for the workspace', async () => {
    const prev = process.env.CRAFT_LOCAL_MCP_ENABLED;
    process.env.CRAFT_LOCAL_MCP_ENABLED = 'false';
    try {
      const pool = new TestPool({ workspaceRootPath: '/tmp/ws-does-not-exist' });
      const stdio: SdkMcpServerConfig = { type: 'stdio', command: 'echo', args: [] };
      await expect(pool.ensureConnected('local', stdio)).rejects.toThrow(/Local MCP is disabled/);
      expect(pool.connectCalls.length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.CRAFT_LOCAL_MCP_ENABLED;
      else process.env.CRAFT_LOCAL_MCP_ENABLED = prev;
    }
  });
});

describe('McpClientPool.getProxyToolSlugs', () => {
  class ToolsPool extends McpClientPool {
    override async connect(slug: string, config: SdkMcpServerConfig): Promise<void> {
      const fake: PoolClient = {
        listTools: async () => [
          { name: 'search_code', description: 'd', inputSchema: { type: 'object' } },
          { name: 'pat.batch', description: 'd', inputSchema: { type: 'object' } },
        ],
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
      await this.registerClient(slug, fake);
      this.activeConfigs.set(slug, config);
    }
  }

  test('maps proxy tool names (incl. sanitized) to source slugs', async () => {
    const pool = new ToolsPool();
    await pool.connect('github', httpConfig('a'));
    const map = pool.getProxyToolSlugs();
    expect(map.get('mcp__github__search_code')).toBe('github');
    expect(map.get('mcp__github__pat_batch')).toBe('github');
    expect(map.size).toBe(2);
  });

  test('drops mappings when a source is disconnected without keeping defs', async () => {
    const pool = new ToolsPool();
    await pool.connect('github', httpConfig('a'));
    await pool.disconnect('github');
    expect(pool.getProxyToolSlugs().size).toBe(0);
  });

  test('keeps defs (and mappings) on idle-style disconnectAll(true)', async () => {
    const pool = new ToolsPool();
    await pool.connect('github', httpConfig('a'));
    await pool.disconnectAll(true);
    expect(pool.isConnected('github')).toBe(false);
    // Defs survive so the model keeps seeing the tools and lazy sources can reconnect.
    expect(pool.getProxyToolDefs().length).toBe(2);
    expect(pool.getProxyToolSlugs().get('mcp__github__search_code')).toBe('github');
  });

  test('clears everything on plain disconnectAll()', async () => {
    const pool = new ToolsPool();
    await pool.connect('github', httpConfig('a'));
    await pool.disconnectAll();
    expect(pool.getProxyToolDefs().length).toBe(0);
    expect(pool.getProxyToolSlugs().size).toBe(0);
  });
});
