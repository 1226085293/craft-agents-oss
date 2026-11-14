import { describe, expect, it } from 'bun:test';

import { getSessionToolNames, USER_LANE_DENIED_TOOL_NAMES } from './tool-defs.ts';
import {
  SUPERVISOR_PROMPT_TOOLS,
  USER_LANE_PROMPT_TOOLS,
} from '../../shared/src/prompts/supervisor-prompt.ts';

/**
 * Path A: one lane writes a task, the other reads it and relays.
 *
 * The lane filter existed but never received the lane: `SessionManager` built the agent config
 * without `supervisorLane`, so `isToolVisibleToLane(name, undefined)` answered as the working lane
 * and the user-facing supervisor was handed `dispatch` and `task_create`.
 *
 * Worse, layering hid it from the flat check: the *registered* tools were filtered (10 top-level),
 * but the `call_tool` registry was built from the same unfiltered list, so 48 tools stayed callable
 * by name. A real run proved it — the user lane created T-1, dispatched step 1.1, and later
 * dispatched step 2, all of which its own prompt forbids.
 *
 * These cases pin the contract that made that possible to miss.
 */
describe('supervisor lanes: one writer, one reader', () => {
  const userTools = () => getSessionToolNames({ role: 'supervisor', supervisorLane: 'user' });
  const taskTools = () => getSessionToolNames({ role: 'supervisor', supervisorLane: 'task' });

  it('gives the user lane no way to write a task', () => {
    const tools = userTools();
    for (const denied of ['task_create', 'task_update', 'task_handoff']) {
      expect(tools.has(denied)).toBe(false);
    }
  });

  it('leaves the task lane every write except creation', () => {
    // Creation moved to the user lane (`create_task`), which is also the only path that can carry
    // `triggers`. Everything that *maintains* an existing task stays here.
    const tools = taskTools();
    for (const name of ['task_update', 'task_handoff', 'dispatch']) {
      expect(tools.has(name)).toBe(true);
    }
    expect(tools.has('task_create')).toBe(false);
  });

  /**
   * `task_verify` used to be named in three allowlists and defined nowhere.
   *
   * It survived because a name in a list reads like a capability: the prompt advertised it, both
   * lanes denied it, and nothing implemented it. Removed rather than implemented — a list entry is
   * not a specification, and inventing a tool to keep a list happy is how a name becomes a promise
   * nobody can keep.
   */
  it('no longer names task_verify anywhere, since nothing implemented it', () => {
    for (const tools of [userTools(), taskTools()]) {
      expect(tools.has('task_verify')).toBe(false);
    }
    expect((USER_LANE_DENIED_TOOL_NAMES as ReadonlySet<string>).has('task_verify')).toBe(false);
    expect(SUPERVISOR_PROMPT_TOOLS.includes('task_verify' as never)).toBe(false);
  });

  it('keeps the read tools on both lanes, so 「进度如何」 never needs a relay', () => {
    for (const tools of [userTools(), taskTools()]) {
      expect(tools.has('task_list')).toBe(true);
      expect(tools.has('task_get')).toBe(true);
    }
  });

  /**
   * The relay has to exist, or Path A is a lane that can neither write nor hand over.
   *
   * It used to be `send_agent_message`, which asked the model to reword the person's words into
   * a message — the reworded message was all the working lane saw. `create_task` replaced it: the
   * words travel verbatim, and the machine does the relaying.
   */
  it('gives the user lane exactly one way to hand work over', () => {
    const tools = userTools();
    expect(tools.has('create_task')).toBe(true);
    expect(tools.has('send_agent_message')).toBe(false);
    expect(tools.has('dispatch')).toBe(false);
  });

  /**
   * A lane that talks to the person must not have a tool for asking the person.
   *
   * `ask_user` delivers to 「the user lane」, and from inside that lane the target is itself
   * (`resolveReaderLane` returns `managed`). On a real run the person wrote 「一分钟给我发一次你好」,
   * the lane called `ask_user` with a decision, and the card came back into the same conversation —
   * 「督导 · 用户 发来的问句」 — while the requirement was never turned into a task.
   */
  it('gives the user lane no way to ask the lane it already is', () => {
    const tools = userTools()
    for (const name of ['ask_user', 'list_questions']) {
      expect(tools.has(name)).toBe(false)
    }
    // The working lane still asks: its questions are the ones that need a card.
    expect(taskTools().has('ask_user')).toBe(true)
    expect(taskTools().has('list_questions')).toBe(true)
  })

  it('declares a user-lane prompt list that matches the real table', () => {
    const tools = userTools();
    for (const name of USER_LANE_PROMPT_TOOLS) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it('keeps the declared denial set in step with the real table', () => {
    const tools = userTools();
    for (const denied of USER_LANE_DENIED_TOOL_NAMES) {
      expect(tools.has(denied)).toBe(false);
    }
  });

  it('still lets a supervisor written before lanes keep the whole table', () => {
    // Absent lane = the working lane. Defaulting the other way would disarm every old supervisor.
    expect(getSessionToolNames({ role: 'supervisor' }).has('dispatch')).toBe(true);
  });

  it('gives workers neither lane table', () => {
    const worker = getSessionToolNames({ role: 'worker' });
    expect(worker.has('dispatch')).toBe(false);
    expect(worker.has('task_create')).toBe(false);
    expect(worker.has('SubmitPlan')).toBe(false);
  });

  it('names every supervisor tool the prompt advertises', () => {
    // A prompt that promises a tool the table lacks is the same defect one layer up. No exceptions
    // now that `task_verify` is gone.
    const tools = taskTools();
    for (const name of SUPERVISOR_PROMPT_TOOLS) {
      expect(tools.has(name)).toBe(true);
    }
  });
});
