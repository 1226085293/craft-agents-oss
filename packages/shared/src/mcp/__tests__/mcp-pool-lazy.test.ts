/**
 * McpClientPool lazy source support: sync() must NOT keep a resident process
 * for lazy stdio sources (tool definitions registered via probe, process
 * spawned again on first callTool), and callTool() must connect on demand.
 */

import { describe, test, expect } from 'bun:test';
import { McpClientPool } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

const lazyConfig: SdkMcpServerConfig = {
  type: 'stdio',
  command: 'someserver',
  args: ['--autoConnect'],
  lazy: true,
};

const eagerConfig: SdkMcpServerConfig = {
  type: 'stdio',
  command: 'eagercmd',
  args: [],
};

function stubTools(): Tool[] {
  return [
    { name: 'do_thing', description: 'does a thing', inputSchema: { type: 'object', properties: {} } },
    { name: 'read_state', description: 'reads state', inputSchema: { type: 'object', properties: {} } },
  ];
}

class LazyTestPool extends McpClientPool {
  connectCalls: Array<{ slug: string; config: SdkMcpServerConfig }> = [];
  probeCounts: Map<string, number> = new Map();
  toolCalls: string[] = [];

  override async connect(slug: string, config: SdkMcpServerConfig): Promise<void> {
    this.connectCalls.push({ slug, config });
    const self = this;
    const fake: PoolClient = {
      listTools: async () => stubTools(),
      callTool: async (name: string) => {
        self.toolCalls.push(`${slug}:${name}`);
        return { content: [{ type: 'text', text: `ok ${name}` }] };
      },
      close: async () => {},
    };
    await this.registerClient(slug, fake);
    this.activeConfigs.set(slug, config);
  }

  /** Test override: register tool defs without spawning a real process. */
  override async probeLazyTools(slug: string, _config: SdkMcpServerConfig): Promise<boolean> {
    this.probeCounts.set(slug, (this.probeCounts.get(slug) ?? 0) + 1);
    this.registerToolDefs(slug, stubTools());
    return true;
  }
}

describe('McpClientPool lazy sources', () => {
  test('sync() does not keep a client for a lazy source but registers tool defs', async () => {
    const pool = new LazyTestPool();
    await pool.sync({ chrome: lazyConfig });
    expect(pool.isConnected('chrome')).toBe(false);          // no resident process
    expect(pool.connectCalls.length).toBe(0);                // nothing spawned
    expect(pool.probeCounts.get('chrome')).toBe(1);          // probed once for defs
    expect(pool.getProxyToolDefs(['chrome']).length).toBe(2); // model can see tools
  });

  test('repeat sync() does not re-probe an already-registered lazy source', async () => {
    const pool = new LazyTestPool();
    await pool.sync({ chrome: lazyConfig });
    await pool.sync({ chrome: lazyConfig });
    expect(pool.probeCounts.get('chrome')).toBe(1); // defs cached, no extra probe
    expect(pool.isConnected('chrome')).toBe(false);
  });

  test('callTool() connects a lazy source on demand and forwards the call', async () => {
    const pool = new LazyTestPool();
    await pool.sync({ chrome: lazyConfig });
    const result = await pool.callTool('mcp__chrome__do_thing', {});
    expect(pool.connectCalls.length).toBe(1);               // spawned on first use
    expect(pool.isConnected('chrome')).toBe(true);          // now resident
    expect(pool.toolCalls).toEqual(['chrome:do_thing']);
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('ok do_thing');
  });

  test('subsequent callTool() reuses the now-resident connection', async () => {
    const pool = new LazyTestPool();
    await pool.sync({ chrome: lazyConfig });
    await pool.callTool('mcp__chrome__do_thing', {});
    await pool.callTool('mcp__chrome__read_state', {});
    expect(pool.connectCalls.length).toBe(1);               // connected only once
    expect(pool.toolCalls).toEqual(['chrome:do_thing', 'chrome:read_state']);
  });

  test('eager sources are still connected at sync time', async () => {
    const pool = new LazyTestPool();
    await pool.sync({ chrome: lazyConfig, code: eagerConfig });
    expect(pool.isConnected('chrome')).toBe(false);
    expect(pool.isConnected('code')).toBe(true);            // eager unchanged
    expect(pool.connectCalls.map(c => c.slug)).toEqual(['code']);
  });

  test('callTool() arms the lazy idle-disconnect timer after use', async () => {
    const pool = new LazyTestPool() as any;
    await pool.sync({ chrome: lazyConfig });
    await pool.callTool('mcp__chrome__do_thing', {});
    expect(pool.lazyIdleTimers.has('chrome')).toBe(true); // timer armed
    // Re-arm on second call (timer reset, not duplicated)
    await pool.callTool('mcp__chrome__read_state', {});
    expect(pool.lazyIdleTimers.has('chrome')).toBe(true);
    expect(pool.lazyIdleTimers.size).toBe(1);
  });

  test('disconnect(keepDefs=true) releases process but keeps tool defs', async () => {
    const pool = new LazyTestPool();
    await pool.sync({ chrome: lazyConfig });
    await pool.callTool('mcp__chrome__do_thing', {});
    await pool.disconnect('chrome', true); // idle release path
    expect(pool.isConnected('chrome')).toBe(false);          // process released
    expect(pool.getProxyToolDefs(['chrome']).length).toBe(2); // defs still visible
    // Next call reconnects on demand (no re-probe needed: defs cached)
    const before = pool.probeCounts.get('chrome');
    const result = await pool.callTool('mcp__chrome__read_state', {});
    expect(pool.isConnected('chrome')).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(pool.toolCalls).toContain('chrome:read_state');
    expect(pool.probeCounts.get('chrome')).toBe(before); // no new probe
  });

  test('disconnectAll clears lazy pending configs', async () => {
    const pool = new LazyTestPool();
    await pool.sync({ chrome: lazyConfig });
    await pool.callTool('mcp__chrome__do_thing', {});
    await pool.disconnectAll();
    expect(pool.isConnected('chrome')).toBe(false);
    expect(pool.getProxyToolDefs(['chrome']).length).toBe(0);
    // Post-disconnect sync re-probes and can reconnect on demand again
    await pool.sync({ chrome: lazyConfig });
    expect(pool.probeCounts.get('chrome')).toBe(2);
    expect(pool.isConnected('chrome')).toBe(false);
  });
});