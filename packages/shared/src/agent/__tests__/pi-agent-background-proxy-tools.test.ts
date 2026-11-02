import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgent } from '../pi-agent.ts';
import { getSessionToolProxyDefs } from '../backend/pi/session-tool-defs.ts';
import type { BackendConfig } from '../backend/types.ts';

const roots: string[] = [];

function createConfig(rootPath: string): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath,
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: rootPath,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  };
}

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'craft-bg-proxy-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.CRAFT_BACKGROUND_TOOL_THRESHOLD_MS;
  delete process.env.CRAFT_BACKGROUND_FORCE_STOP_MS;
});

describe('backgroundable proxy tools', () => {
  it('advertises background on normal session tools and not on task-control tools', () => {
    const defs = getSessionToolProxyDefs();
    const byName = new Map(defs.map((def) => [def.name, def]));
    const properties = (name: string) => (
      byName.get(name)?.inputSchema as { properties?: Record<string, unknown> }
    )?.properties ?? {};

    expect(properties('mcp__session__script_sandbox').background).toBeDefined();
    expect(properties('mcp__session__transform_data').background).toBeDefined();
    expect(properties('mcp__session__call_llm').background).toBeUndefined();
    expect(properties('mcp__session__browser_tool').background).toBeUndefined();
    expect(properties('mcp__session__list_background_tasks').background).toBeUndefined();
    expect(properties('mcp__session__get_background_task_output').background).toBeUndefined();
    expect(properties('mcp__session__stop_background_task').background).toBeUndefined();
  });

  it('mode 2 returns a synthetic result immediately and emits completion', async () => {
    const root = newRoot();
    const agent = new PiAgent(createConfig(root));
    const sent: any[] = [];
    const events: any[] = [];
    (agent as any).send = (message: any) => sent.push(message);
    (agent as any).prerequisiteManager.checkPrerequisites = () => ({ allowed: true });
    agent.setBackgroundEventSink((event) => events.push(event));
    (agent as any).routeToolCall = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { content: 'background result', isError: false };
    };

    await (agent as any).handleToolExecuteRequest({
      requestId: 'req-1',
      toolName: 'mcp__session__script_sandbox',
      toolUseId: 'tool-1',
      args: { background: true },
    });

    const toolResult = sent[0]?.result;
    expect(toolResult.isError).toBe(false);
    expect(toolResult.content).toContain('backgroundTaskId:');
    expect(events.some((event) => event.type === 'task_backgrounded')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const completed = events.find((event) => event.type === 'task_completed');
    expect(completed?.status).toBe('completed');
    expect(completed?.kind).toBe('tool');
    expect(completed?.output).toBe('background result');
    expect(readFileSync(completed.outputFile, 'utf8')).toBe('background result');
  });

  it('mode 1 hands a still-running tool to the background after the threshold', async () => {
    process.env.CRAFT_BACKGROUND_TOOL_THRESHOLD_MS = '20';
    const root = newRoot();
    const agent = new PiAgent(createConfig(root));
    const sent: any[] = [];
    const events: any[] = [];
    (agent as any).send = (message: any) => sent.push(message);
    (agent as any).prerequisiteManager.checkPrerequisites = () => ({ allowed: true });
    agent.setBackgroundEventSink((event) => events.push(event));
    (agent as any).routeToolCall = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { content: 'auto background result', isError: false };
    };

    await (agent as any).handleToolExecuteRequest({
      requestId: 'req-2',
      toolName: 'mcp__session__script_sandbox',
      toolUseId: 'tool-2',
      args: {},
    });

    expect(sent[0]?.result.content).toContain('backgroundTaskId:');
    expect(events.some((event) => event.type === 'task_backgrounded')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const completed = events.find((event) => event.type === 'task_completed');
    expect(completed?.status).toBe('completed');
    expect(completed?.output).toBe('auto background result');
    expect(readFileSync(completed.outputFile, 'utf8')).toBe('auto background result');
  });

  it('cooperative cancel returns the run output and suppresses task_completed', async () => {
    const root = newRoot();
    const agent = new PiAgent(createConfig(root));
    const sent: any[] = [];
    const events: any[] = [];
    let aborted = false;
    (agent as any).send = (message: any) => sent.push(message);
    (agent as any).prerequisiteManager.checkPrerequisites = () => ({ allowed: true });
    agent.setBackgroundEventSink((event) => events.push(event));
    (agent as any).routeToolCall = async (
      _name: string,
      _args: unknown,
      signal?: AbortSignal,
      onKillResult?: (result: { ok: boolean; error?: string }) => void,
    ) => {
      signal?.addEventListener('abort', () => {
        aborted = true;
        onKillResult?.({ ok: true });
      }, { once: true });
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { content: 'cooperative output', isError: false };
    };

    await (agent as any).handleToolExecuteRequest({
      requestId: 'req-cancel',
      toolName: 'mcp__session__script_sandbox',
      toolUseId: 'tool-cancel',
      args: { background: true },
    });

    const taskId = /backgroundTaskId: (\S+)/.exec(sent[0]?.result.content)?.[1];
    expect(taskId).toBeTruthy();
    const stopped = await (agent as any).cancelBackgroundTask(taskId);
    expect(stopped.forced).toBe(false);
    expect(stopped.killStatus).toBe('killed');
    expect(stopped.content).toBe('cooperative output');
    expect(aborted).toBe(true);
    expect(readFileSync(stopped.outputFile, 'utf8')).toBe('cooperative output');

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.some((event) => event.type === 'task_completed')).toBe(false);
  });

  it('force-settles a non-responsive run after the configured timeout', async () => {
    process.env.CRAFT_BACKGROUND_FORCE_STOP_MS = '30';
    const root = newRoot();
    const agent = new PiAgent(createConfig(root));
    const sent: any[] = [];
    const events: any[] = [];
    (agent as any).send = (message: any) => sent.push(message);
    (agent as any).prerequisiteManager.checkPrerequisites = () => ({ allowed: true });
    agent.setBackgroundEventSink((event) => events.push(event));
    (agent as any).routeToolCall = () => new Promise(() => {});

    await (agent as any).handleToolExecuteRequest({
      requestId: 'req-force',
      toolName: 'mcp__session__script_sandbox',
      toolUseId: 'tool-force',
      args: { background: true },
    });

    const taskId = /backgroundTaskId: (\S+)/.exec(sent[0]?.result.content)?.[1];
    expect(taskId).toBeTruthy();
    const stopped = await (agent as any).cancelBackgroundTask(taskId);
    expect(stopped.forced).toBe(true);
    expect(stopped.killStatus).toBe('unverified');
    expect(stopped.content).toContain('background-task-force-stopped');
    expect(readFileSync(stopped.outputFile, 'utf8')).toContain('background-task-force-stopped');
    expect(events.some((event) => event.type === 'task_completed')).toBe(false);
  });

  it('force-stop reports a failed kill and preserves partial output', async () => {
    process.env.CRAFT_BACKGROUND_FORCE_STOP_MS = '30';
    const root = newRoot();
    const agent = new PiAgent(createConfig(root));
    const sent: any[] = [];
    (agent as any).send = (message: any) => sent.push(message);
    (agent as any).prerequisiteManager.checkPrerequisites = () => ({ allowed: true });
    (agent as any).routeToolCall = () => new Promise(() => {});

    await (agent as any).handleToolExecuteRequest({
      requestId: 'req-force-failed',
      toolName: 'mcp__session__script_sandbox',
      toolUseId: 'tool-force-failed',
      args: { background: true },
    });

    const taskId = /backgroundTaskId: (\S+)/.exec(sent[0]?.result.content)?.[1];
    const state = (agent as any).backgroundProxyTasks.get(taskId);
    writeFileSync(state.outputFile, 'partial stdout', 'utf8');
    state.killStatusRef.current = { ok: false, error: 'taskkill denied' };

    const stopped = await (agent as any).cancelBackgroundTask(taskId);
    expect(stopped.forced).toBe(true);
    expect(stopped.killStatus).toBe('failed');
    expect(stopped.content).toContain('partial stdout');
    expect(stopped.content).toContain('killStatus: failed (taskkill denied)');
    expect(readFileSync(stopped.outputFile, 'utf8')).toContain('partial stdout');
  });

  it('forces Agent subagents into background without a model flag', async () => {
    const root = newRoot();
    const agent = new PiAgent(createConfig(root));
    const sent: any[] = [];
    (agent as any).send = (message: any) => sent.push(message);
    (agent as any).prerequisiteManager.checkPrerequisites = () => ({ allowed: true });

    await (agent as any).handlePreToolUseRequest({
      requestId: 'ptu-agent',
      toolName: 'Agent',
      toolCallId: 'tool-agent',
      input: {
        description: 'Long investigation',
        prompt: 'Investigate the repository',
      },
    });

    const response = sent.find((message) => message.type === 'pre_tool_use_response');
    expect(response?.action).toBe('modify');
    expect(response?.input?.run_in_background).toBe(true);
    expect(response?.input?.description).toBe('Long investigation');
  });
});
