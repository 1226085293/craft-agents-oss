/**
 * A question for a person must never become input to a model.
 *
 * The failure this pins down happened in a real run. `deliverToUserLane` shared the
 * worker-nudge pipe — persist the row, then wake the session — which makes a row a message
 * *to an agent*. So 「需要你拍板：…」 arrived in the user lane as `role: 'user'`, the lane's
 * model read it as its own inbox, and answered:
 *
 *   14:09:29  user  〔来自督导·任务·需要拍板〕…请拍板：(a) 放行继续；(b) 就此结束 T-1
 *   14:09:43  assistant  按你最初的授权「先只做 1.1」，我拍板选 (b)：就此结束 T-1
 *
 * It then resumed the task and marked a step the user had excluded. The prompt telling it
 * not to answer was already there and did not hold: a model handed a question answers it.
 *
 * The property to keep: the request is written for the reader and starts no turn. The
 * answer comes back from the person as an ordinary user message.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getSessionFilePath } from '@craft-agent/shared/sessions/storage';

import { SessionManager, createManagedSession } from './SessionManager.ts';

interface Row {
  role?: string
  statusType?: string
  infoLevel?: string
  content?: string
  decisionRequest?: {
    id?: string
    askedBySessionId?: string
    askedByLabel?: string
    question?: string
    options?: string[]
    taskIdentifier?: string
    askedAt?: number
  }
}

describe('a decision request is written for the reader', () => {
  let tmpRoot: string;
  let sm: SessionManager;
  let sent: string[];

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-decision-'));
    sm = new SessionManager();
    sent = [];
  });

  afterEach(async () => {
    await sm.flushAllSessions();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function buildRequester() {
    const workspace = { id: 'ws_test', name: 'Test', rootPath: tmpRoot, createdAt: Date.now() };
    // `supervisorLane: 'user'` makes this session its own reader lane, so the write lands
    // here without standing up the workspace's task machinery.
    const managed = createManagedSession(
      { id: 'sess_asker', name: '督导 · 任务' },
      workspace as never,
      { messagesLoaded: true },
    );
    managed.supervisorLane = 'user';
    managed.agent = { chat: () => undefined } as never;
    managed.isProcessing = false;
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('sess_asker', managed);
    // Any wake would show up here. A question must produce none.
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = async (
      sessionId: string,
      message: string,
    ) => {
      sent.push(`${sessionId}:${message}`);
    };
    return managed;
  }

  async function readPersisted(sessionId: string): Promise<Row[]> {
    await sm.flushAllSessions();
    const path = getSessionFilePath(tmpRoot, sessionId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line) as Row);
  }

  /**
   * The card carries which task it is about, or the two surfaces cannot agree.
   *
   * Without it the conversation card's sync key was `undefined`, so answering on the task
   * page never reached it — the buttons stayed live and the same reply could be sent twice.
   * It is also what lets the supervisor tell which decision an answer closes when two tasks
   * are waiting at once.
   */
  it('names the task it is asking about', async () => {
    const requester = buildRequester();
    // The asker owns exactly one paused task with an open decision.
    ;(sm as unknown as { getTasks: unknown }).getTasks = () => ({
      list: () => [
        {
          id: 'T-7',
          status: 'paused',
          pauseReason: 'needs_decision',
          supervisorSessionId: 'sess_asker',
          decision: { askedAt: Date.now(), resolvedAt: undefined },
        },
      ],
    })

    await (
      sm as unknown as {
        deliverToUserLane: (m: unknown, t: string, k: string) => Promise<void>
      }
    ).deliverToUserLane(requester, '要不要放行 1.2？', 'decision')

    const managed = (sm as unknown as { sessions: Map<string, { messages: Row[] }> }).sessions.get(
      'sess_asker',
    )
    const asked = managed?.messages.find((m) => m.statusType === 'decision_request')
    expect(asked?.decisionRequest?.taskIdentifier).toBe('T-7')
  })

  /**
   * The asker names the task; the card carries it.
   *
   * Reading it from "which paused task has an open decision" was wrong twice in one run: a
   * question about T-1 that arrived before T-1 paused carried no task id at all, and the
   * next one was stamped T-2 because that was the newest open decision. A card with the
   * wrong task cannot be answered — the reply resolves the wrong decision.
   */
  it('prefers the task the asker named over a guess', async () => {
    const requester = buildRequester()
    ;(sm as unknown as { getTasks: unknown }).getTasks = () => ({
      list: () => [
        {
          id: 'T-2',
          status: 'paused',
          pauseReason: 'needs_decision',
          supervisorSessionId: 'sess_asker',
          decision: { askedAt: Date.now(), resolvedAt: undefined },
        },
      ],
    })

    await (
      sm as unknown as {
        deliverToUserLane: (
          m: unknown,
          t: string,
          k: string,
          o?: string[],
          taskId?: string,
        ) => Promise<void>
      }
    ).deliverToUserLane(requester, '要不要放行 1.2？', 'decision', ['放行'], 'T-1')

    const managed = (sm as unknown as { sessions: Map<string, { messages: Row[] }> }).sessions.get(
      'sess_asker',
    )
    const asked = managed?.messages.find((m) => m.statusType === 'decision_request')
    expect(asked?.decisionRequest?.taskIdentifier).toBe('T-1')
  })

  /**
   * A card that names no task must still be answerable.
   *
   * Observed: 「完成1.2后暂停」 reached the task supervisor as bare words, because the card
   * carried no task id and the renderer had nothing else to send. The asking session is the
   * one thing every card has, so it is the last resort for finding the task.
   */
  it('finds the task from the asking session when the card named none', () => {
    const requester = buildRequester()
    ;(sm as unknown as { getTasks: unknown }).getTasks = () => ({
      list: () => [
        {
          id: 'T-9',
          status: 'paused',
          pauseReason: 'needs_decision',
          supervisorSessionId: 'sess_asker',
          decision: { askedAt: Date.now(), resolvedAt: Date.now() },
        },
      ],
    })

    // Resolved decision, still paused: the open-decision lookup finds nothing, which is
    // exactly the state a follow-up card is raised in.
    expect(
      (sm as unknown as { openTaskFor: (s: string) => string | undefined }).openTaskFor('sess_asker'),
    ).toBe('T-9')
  })

  /**
   * A question asked while the task is still running still belongs to a task.
   *
   * 「要不要继续」 is asked between steps, when nothing has been handed back and the task is
   * `running`. Both lookups — the one that stamps the card and the one that finds the task
   * from the asking session — required `paused / needs_decision`, so that question produced a
   * card with no task id, no fallback, and every send came back
   * 「no task to answer — the card did not say which one」. Observed live on T-1: the question
   * was written at 05:17:29, the task had been `running` since 05:15:28.
   *
   * What makes a task answerable is an open decision, not a pause: a pause is only how a
   * hand-off usually ends up, and the person cannot tell the two apart from the card.
   */
  it('names a running task that has an open question', async () => {
    const requester = buildRequester()
    ;(sm as unknown as { getTasks: unknown }).getTasks = () => ({
      list: () => [
        {
          id: 'T-1',
          status: 'running',
          pauseReason: null,
          supervisorSessionId: 'sess_asker',
          decision: { askedAt: Date.now(), resolvedAt: undefined },
        },
      ],
    })

    await (
      sm as unknown as {
        deliverToUserLane: (m: unknown, t: string, k: string) => Promise<void>
      }
    ).deliverToUserLane(requester, '要不要继续做 1.2？', 'decision')

    const managed = (sm as unknown as { sessions: Map<string, { messages: Row[] }> }).sessions.get(
      'sess_asker',
    )
    const asked = managed?.messages.find((m) => m.statusType === 'decision_request')
    expect(asked?.decisionRequest?.taskIdentifier).toBe('T-1')
    // And the same task is what an unlabelled card falls back to.
    expect(
      (sm as unknown as { openTaskFor: (s: string) => string | undefined }).openTaskFor('sess_asker'),
    ).toBe('T-1')
  })

  it('writes a card instead of input, and starts no turn', async () => {
    const requester = buildRequester();
    await (
      sm as unknown as {
        deliverToUserLane: (m: unknown, t: string, k: string) => Promise<void>
      }
    ).deliverToUserLane(requester, '要不要放行 1.2？', 'decision');

    // Guarded directly on the session double, because reading the persisted file would
    // still pass if the wake had gone to a session the test never inspected.
    const managed = (sm as unknown as { sessions: Map<string, { messages: Row[] }> }).sessions.get(
      'sess_asker',
    );
    const asked = managed?.messages.find((m) => m.statusType === 'decision_request');
    expect(asked).toBeDefined();
    // The one property that matters: not a user row, so the model has nothing to answer.
    expect(asked?.role).toBe('info');
    expect(sent).toEqual([]);
  });

  it('names the session to answer, so a reply has a destination', async () => {
    const requester = buildRequester();
    await (
      sm as unknown as {
        deliverToUserLane: (m: unknown, t: string, k: string) => Promise<void>
      }
    ).deliverToUserLane(requester, '要不要放行 1.2？', 'decision');

    const rows = await readPersisted('sess_asker');
    const asked = rows.find((r) => r.statusType === 'decision_request');
    expect(asked?.decisionRequest?.askedBySessionId).toBe('sess_asker');
    expect(asked?.decisionRequest?.question).toBe('要不要放行 1.2？');
    // The asker's own name, not a hard-coded lane label: a worker can ask too.
    expect(asked?.decisionRequest?.askedByLabel).toBe('督导 · 任务');
    expect(asked?.decisionRequest?.id).toBeTruthy();
  });

  it('keeps one card per question, each answerable on its own', async () => {
    const requester = buildRequester();
    await (
      sm as unknown as {
        deliverQuestionToUserLane: (
          m: unknown,
          q: { question: string; options?: string[] }[],
        ) => Promise<void>
      }
    ).deliverQuestionToUserLane(requester, [
      { question: '放行 1.2 吗？', options: ['放行', '跳过'] },
      { question: '要保留成果吗？', options: ['保留', '丢弃'] },
    ]);

    const rows = await readPersisted('sess_asker');
    const cards = rows.filter((r) => r.statusType === 'decision_request');
    expect(cards).toHaveLength(2);
    // Distinct ids: answering one must not answer the other.
    expect(cards[0]?.decisionRequest?.id).not.toBe(cards[1]?.decisionRequest?.id);
    expect(cards[0]?.decisionRequest?.options).toEqual(['放行', '跳过']);
    expect(cards[1]?.decisionRequest?.options).toEqual(['保留', '丢弃']);
    expect(sent).toEqual([]);
  })

  it('a completion notice is read as a message, and never answered', async () => {
    const requester = buildRequester();
    await (
      sm as unknown as {
        deliverToUserLane: (m: unknown, t: string, k: string) => Promise<void>
      }
    ).deliverToUserLane(requester, 'T-1 已完成', 'completed');

    const managed = (sm as unknown as { sessions: Map<string, { messages: Row[] }> }).sessions.get(
      'sess_asker',
    );
    const notice = managed?.messages.find((m) => m.content === 'T-1 已完成');
    /**
     * An agent reporting to a person is a message from an agent.
     *
     * This used to be `role: 'info'` — a grey status row, which reads as system chrome rather than
     * as somebody telling you what happened. It now draws as an assistant bubble, and carries
     * `isRelayed` so the readers that treat a final assistant message as "this session finished and
     * this is what it said" (restart recovery, session output) skip it.
     */
    expect(notice?.role).toBe('assistant');
    expect((notice as { isRelayed?: boolean } | undefined)?.isRelayed).toBe(true);
    // No turn is started by it: the report is for a person, never model input.
    expect(sent).toEqual([]);
  });

  /**
   * The lane that talks to the person is not the lane that owns the task.
   *
   * Observed live: three question cards in the conversation, one question on the task page.
   * The cards were asked by 督导·用户, the task belonged to 督导·任务, and the lookup filtered on
   * `supervisorSessionId === askingSession` — a condition the user lane can never satisfy. The
   * two questions it could not attach existed only as chat rows, so the task page never showed
   * them and answering them found no decision.
   */
  it('finds a task owned by the other supervisor lane', async () => {
    const requester = buildRequester()
    ;(sm as unknown as { getTasks: unknown }).getTasks = () => ({
      list: () => [
        {
          id: 'T-1',
          status: 'paused',
          pauseReason: 'needs_decision',
          supervisorSessionId: 'sess_task_lane',
          updatedAt: Date.now(),
          decision: { askedAt: Date.now(), resolvedAt: undefined },
        },
      ],
    })

    expect(
      (sm as unknown as { openTaskFor: (s: string) => string | undefined }).openTaskFor('sess_asker'),
    ).toBe('T-1')

    await (
      sm as unknown as {
        deliverToUserLane: (m: unknown, t: string, k: string) => Promise<void>
      }
    ).deliverToUserLane(requester, '文件已存在时要不要覆盖？', 'decision')

    const managed = (sm as unknown as { sessions: Map<string, { messages: Row[] }> }).sessions.get(
      'sess_asker',
    )
    const asked = managed?.messages.find((m) => m.statusType === 'decision_request')
    expect(asked?.decisionRequest?.taskIdentifier).toBe('T-1')
  })

  /**
   * A supervisor with work of its own keeps the narrow scope.
   *
   * The workspace-wide fallback exists for the lane that owns nothing. A session that does own
   * tasks must not have its questions attributed to somebody else's task just because that one
   * happens to be waiting.
   */
  it('keeps its own task when it owns one', () => {
    buildRequester()
    ;(sm as unknown as { getTasks: unknown }).getTasks = () => ({
      list: () => [
        {
          id: 'T-1',
          status: 'paused',
          pauseReason: 'needs_decision',
          supervisorSessionId: 'sess_asker',
          updatedAt: 1,
          decision: { askedAt: 1, resolvedAt: undefined },
        },
        {
          id: 'T-2',
          status: 'paused',
          pauseReason: 'needs_decision',
          supervisorSessionId: 'sess_other',
          updatedAt: 999,
          decision: { askedAt: 2, resolvedAt: undefined },
        },
      ],
    })

    expect(
      (sm as unknown as { openTaskFor: (s: string) => string | undefined }).openTaskFor('sess_asker'),
    ).toBe('T-1')
  });
});
