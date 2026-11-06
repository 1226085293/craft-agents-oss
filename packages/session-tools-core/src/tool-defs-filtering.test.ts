import { describe, it, expect } from 'bun:test';
import {
  SESSION_TOOL_DEFS,
  getSessionToolDefs,
  getSessionToolNames,
  getSessionToolRegistry,
  getSessionSafeAllowedToolNames,
  getSessionSafeBlockedToolNames,
  getToolDefsAsJsonSchema,
} from './tool-defs.ts';

describe('session tool filtering helpers', () => {
  it('excludes developer feedback tool when includeDeveloperFeedback is false', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('includes developer feedback tool when includeDeveloperFeedback is true', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: true });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(true);
  });

  it('name set and registry stay aligned for filtered output', () => {
    const names = getSessionToolNames({ includeDeveloperFeedback: false });
    const registry = getSessionToolRegistry({ includeDeveloperFeedback: false });

    expect(registry.has('send_developer_feedback')).toBe(false);
    expect(names.has('send_developer_feedback')).toBe(false);

    for (const name of names) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('json schema conversion respects includeDeveloperFeedback filter', () => {
    const defs = getToolDefsAsJsonSchema({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('all canonical session tools declare safeMode metadata', () => {
    for (const def of SESSION_TOOL_DEFS) {
      expect(def.safeMode === 'allow' || def.safeMode === 'block').toBe(true);
    }
  });

  it('safe-mode helper sets classify expected tools', () => {
    const allowed = getSessionSafeAllowedToolNames();
    const blocked = getSessionSafeBlockedToolNames();

    expect(allowed.has('send_developer_feedback')).toBe(true);
    expect(allowed.has('call_llm')).toBe(true);
    expect(allowed.has('browser_tool')).toBe(true);
    expect(allowed.has('script_sandbox')).toBe(true);

    expect(blocked.has('source_oauth_trigger')).toBe(true);
    expect(blocked.has('source_credential_prompt')).toBe(true);
    expect(blocked.has('spawn_session')).toBe(true);

    // Pages: reads are Explore-safe, mutations are not
    expect(allowed.has('list_pages')).toBe(true);
    expect(allowed.has('get_page')).toBe(true);
    expect(blocked.has('create_page')).toBe(true);
    expect(blocked.has('update_page')).toBe(true);
    expect(blocked.has('write_page_data')).toBe(true);
    expect(blocked.has('delete_page')).toBe(true);
  });

  it('safe-mode helpers support MCP prefixing', () => {
    const allowedPrefixed = getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' });
    const blockedPrefixed = getSessionSafeBlockedToolNames({ prefix: 'mcp__session__' });

    expect(allowedPrefixed.has('mcp__session__send_developer_feedback')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__call_llm')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__script_sandbox')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__source_oauth_trigger')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__spawn_session')).toBe(true);
  });

  it('gives a supervisor the tools it needs to read the event it was handed', () => {
    // The third tier of the event funnel tells the supervisor "有一条未处理的事件
    // （id: …）". Without these it can neither see nor read that event, and the
    // turn dies on the 90s cap having done nothing.
    const names = getSessionToolNames({ role: 'supervisor' });

    expect(names.has('get_event')).toBe(true);
    expect(names.has('list_events')).toBe(true);
    expect(names.has('list_event_subscriptions')).toBe(true);
  });

  it('still keeps hands off a supervisor: no bash, write, edit or MCP', () => {
    const names = getSessionToolNames({ role: 'supervisor' });

    for (const forbidden of ['bash', 'write', 'edit', 'read', 'browser_tool', 'script_sandbox']) {
      expect(names.has(forbidden)).toBe(false);
    }
  });
});

describe('session tool scope', () => {
  /**
   * A task declares which tools its worker needs. The scope narrows what the
   * role already allows — it must never be a way to hand a supervisor hands, or
   * a worker something the role denies.
   */
  it('narrows the worker table to the declared tools', () => {
    const names = getSessionToolNames({ role: 'worker', allowedTools: ['list_events', 'get_event'] })
    expect([...names].sort()).toEqual(['get_event', 'list_events'])
  });

  it('cannot grant a worker a supervisor-only tool', () => {
    const names = getSessionToolNames({ role: 'worker', allowedTools: ['dispatch', 'ask_user'] })
    expect(names.size).toBe(0)
  });

  it('cannot grant a supervisor an execution tool', () => {
    // `bash` is not in the supervisor allowlist, so asking for it does nothing.
    const names = getSessionToolNames({ role: 'supervisor', allowedTools: ['bash'] })
    expect(names.has('bash')).toBe(false)
  });

  it('removes explicitly denied tools without listing the rest', () => {
    const withoutDeny = getSessionToolNames({ role: 'worker' })
    const withDeny = getSessionToolNames({ role: 'worker', deniedTools: ['get_event'] })
    expect(withoutDeny.has('get_event')).toBe(true)
    expect(withDeny.has('get_event')).toBe(false)
    expect(withDeny.size).toBe(withoutDeny.size - 1)
  });

  it('deny wins over allow', () => {
    const names = getSessionToolNames({
      role: 'worker',
      allowedTools: ['get_event', 'list_events'],
      deniedTools: ['get_event'],
    })
    expect([...names]).toEqual(['list_events'])
  });
});
