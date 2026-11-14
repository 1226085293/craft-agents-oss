import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionToolNames, isToolVisibleToLane } from '../../../session-tools-core/src/tool-defs.ts';

/**
 * The lane must reach the agent, or the tool filter silently answers for the wrong lane.
 *
 * `supervisorLane` was stored on the session, exported in the DTO, and read by
 * `isToolVisibleToLane` — but the `session` config handed to the backend never carried it. The
 * filter then received `undefined`, which by design means 「the working lane」, so the user-facing
 * supervisor kept `dispatch` and `task_create`.
 *
 * The flat tool table looked correct, which is why this survived: layered mode registers only the
 * fixed layer top-level, and the `call_tool` registry — built from the same list, one call away —
 * still held 48 tools. A real run proves the consequence: the user lane created T-1, dispatched
 * 1.1, and later dispatched step 2, every one of them its own prompt's forbidden work.
 *
 * This is asserted on the source because the config is assembled inline inside a 400-line session
 * builder; a behavioural test would need the whole workspace, connection and SDK stack to observe
 * one field. The contract is narrow and the failure is silent, which is exactly when a guard like
 * this earns its keep.
 */
describe('supervisor lane plumbing', () => {
  const source = readFileSync(join(import.meta.dir, 'SessionManager.ts'), 'utf-8');

  it('passes the lane into the backend session config', () => {
    // The field must appear as a spread-guarded entry, not merely as a local variable.
    expect(source).toMatch(/\.\.\.\(managed\.supervisorLane\s*\?\s*\{\s*supervisorLane:\s*managed\.supervisorLane\s*\}/);
  });

  it('stores the lane on the session when it is created', () => {
    expect(source).toMatch(/supervisorLane:\s*options\?\.supervisorLane/);
  });

  it('creates both lanes through the one factory that sets it', () => {
    // `ensureSupervisorSession` is the only creator; a second creation path would skip the field.
    expect(source).toMatch(/supervisorLane:\s*lane,/);
  });

  /**
   * The lane filter has to default to the working lane.
   *
   * A supervisor written before lanes existed carries no value, and reading that as 「user」 would
   * have disarmed every one of them at once — removing `dispatch` from the sessions that were
   * actively running work.
   */
  it('resolves an absent lane as the working lane', () => {
    expect(isToolVisibleToLane('dispatch', undefined)).toBe(true);
    // …and the user lane actually narrows, which is the behaviour the missing field switched off.
    expect(isToolVisibleToLane('dispatch', 'user')).toBe(false);
    expect(isToolVisibleToLane('task_update', 'user')).toBe(false);
    expect(isToolVisibleToLane('task_get', 'user')).toBe(true);
  });

  it('has no table entry for task_create, so no lane can reach it', () => {
    // The lane filter only narrows a table; it cannot remove a tool that is not in one. Asserting
    // the real table is what answers 「can anyone call this」 — `isToolVisibleToLane` would still say
    // `true` for a name in the supervisor whitelist, which is why the whitelist entry had to go too.
    for (const role of ['supervisor', 'worker'] as const) {
      for (const lane of [undefined, 'task', 'user'] as const) {
        const tools = getSessionToolNames({ role, ...(lane ? { supervisorLane: lane } : {}) });
        expect({ role, lane, has: tools.has('task_create') }).toEqual({ role, lane, has: false });
      }
    }
  });
});
