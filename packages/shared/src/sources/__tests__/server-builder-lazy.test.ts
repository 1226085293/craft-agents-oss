/**
 * SourceServerBuilder lazy default: stdio MCP sources default to on-demand
 * (lazy) connection — the process is not kept resident at session start.
 * `lazy: false` in the source config opts back into eager (resident) mode.
 */

import { describe, test, expect } from 'bun:test';
import { SourceServerBuilder } from '../server-builder.ts';
import type { LoadedSource, FolderSourceConfig } from '../types.ts';

function createStdioSource(overrides: Partial<FolderSourceConfig> = {}): LoadedSource {
  return {
    config: {
      id: 'test-id',
      slug: 'test-stdio',
      name: 'Test Stdio',
      type: 'mcp',
      enabled: true,
      mcp: {
        transport: 'stdio',
        command: 'some-server',
        args: ['--flag'],
      },
      ...overrides,
    } as FolderSourceConfig,
    guide: null,
    folderPath: '/tmp/test/sources/test-stdio',
    workspaceRootPath: '/tmp/test',
    workspaceId: 'test-workspace',
  };
}

describe('SourceServerBuilder stdio lazy default', () => {
  const builder = new SourceServerBuilder();

  test('stdio source without lazy flag defaults to lazy=true', () => {
    const config = builder.buildMcpServer(createStdioSource(), null);
    expect(config).not.toBeNull();
    expect(config!.type).toBe('stdio');
    expect((config as { lazy?: boolean }).lazy).toBe(true);
  });

  test('stdio source with lazy=false stays eager', () => {
    const config = builder.buildMcpServer(
      createStdioSource({ mcp: { transport: 'stdio', command: 'some-server', args: [], lazy: false } }),
      null
    );
    expect(config).not.toBeNull();
    expect((config as { lazy?: boolean }).lazy).toBe(false);
  });

  test('stdio source with lazy=true is explicit lazy', () => {
    const config = builder.buildMcpServer(
      createStdioSource({ mcp: { transport: 'stdio', command: 'some-server', args: [], lazy: true } }),
      null
    );
    expect(config).not.toBeNull();
    expect((config as { lazy?: boolean }).lazy).toBe(true);
  });

  test('http source never gets lazy', () => {
    const source = createStdioSource({
      mcp: { transport: 'http', url: 'https://mcp.example.com/', authType: 'none' },
    });
    const config = builder.buildMcpServer(source, null);
    expect(config).not.toBeNull();
    expect(config!.type).toBe('http');
    expect((config as { lazy?: boolean }).lazy).toBeUndefined();
  });
});