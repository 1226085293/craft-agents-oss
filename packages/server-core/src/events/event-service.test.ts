import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { getEventService, resetEventServicesForTest } from './event-service.ts';
import { loadOutbox, recordOutboxCall } from '@craft-agent/shared/events/outbox.ts';
import { bindThread } from '@craft-agent/shared/events/thread-bindings.ts';
import { generatePairingCode, isChannelPaired, markChannelPaired, updateChannelGate } from '@craft-agent/shared/events/pairings.ts';
import { existsSync } from 'node:fs';
import type { EventMeta, EventRecord } from '@craft-agent/shared/events/event-store.ts';

const roots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-events-service-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  roots.push(dir);
  return dir;
}

function postJson(url: string, token: string, payload: unknown): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

afterEach(() => {
  resetEventServicesForTest();
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps the -wal handle briefly after close; leftovers are harmless.
    }
  }
});

describe('getEventService callback rebinding', () => {
  it('routes unclaimed events when the supervisor callback is wired during warm-up', async () => {
    const root = makeRoot();
    const seen: EventMeta[] = [];
    const dispatchTarget = {
      deliver: async () => true,
      isBusy: () => false,
      hasQueuedUserMessage: () => false,
    };

    const service = await getEventService(
      'ws-unclaimed-startup',
      root,
      undefined,
      dispatchTarget,
      (event) => seen.push(event),
    );
    const env = service.listenerEnv('probe');
    const response = await postJson(env.CRAFT_EVENTS_URL!, env.CRAFT_EVENTS_TOKEN!, {
      type: 'acceptance.ping',
      title: '启动预热直接绑定',
    });

    expect(response.status).toBe(200);
    expect(seen.map((event) => event.title)).toEqual(['启动预热直接绑定']);
  });

  /**
   * Regression: the boot warm-up creates the service before any renderer exists
   * and passes no `onChanged`. Binding only in the constructor meant every later
   * RPC call kept that callback-less instance, so an ingested event reached the
   * database but never the events list — the row showed up only after a reload.
   */
  it('routes inserts to a callback registered after the boot warm-up', async () => {
    const root = makeRoot();

    // Boot: warm-up starts the service with no renderer callback.
    const booted = await getEventService('ws-rebind', root);

    // A renderer connects later and subscribes its broadcast.
    const seen: EventRecord[] = [];
    const withRenderer = await getEventService('ws-rebind', root, (event) => seen.push(event));
    expect(withRenderer).toBe(booted);
    expect(seen).toHaveLength(0);

    const env = withRenderer.listenerEnv('probe');
    const response = await postJson(env.CRAFT_EVENTS_URL!, env.CRAFT_EVENTS_TOKEN!, {
      type: 'mail.received',
      title: '晚绑定测试',
      summary: '订阅发生在服务启动之后',
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.title).toBe('晚绑定测试');
    expect(seen[0]?.source).toBe('probe');
  });

  it('rebinds the unclaimed-event callback after boot warm-up', async () => {
    const root = makeRoot();
    const dispatchTarget = {
      deliver: async () => true,
      isBusy: () => false,
      hasQueuedUserMessage: () => false,
    };

    // Boot warm-up knows how to deliver directly to sessions, but the supervisor
    // callback is only supplied later when the RPC handler is registered.
    const booted = await getEventService('ws-unclaimed-rebind', root, undefined, dispatchTarget);
    const seen: EventMeta[] = [];
    const rebound = await getEventService(
      'ws-unclaimed-rebind',
      root,
      undefined,
      dispatchTarget,
      (event) => seen.push(event),
    );
    expect(rebound).toBe(booted);

    const env = rebound.listenerEnv('probe');
    const response = await postJson(env.CRAFT_EVENTS_URL!, env.CRAFT_EVENTS_TOKEN!, {
      type: 'acceptance.ping',
      title: '预热后绑定督导回调',
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.title).toBe('预热后绑定督导回调');
    expect(seen[0]?.source).toBe('probe');
  });

  it('keeps the live callback when a later caller passes none', async () => {
    const root = makeRoot();
    const seen: EventRecord[] = [];

    const withRenderer = await getEventService('ws-null-call', root, (event) => seen.push(event));
    // Some callers (listener listing, status polling) have no broadcast to offer.
    await getEventService('ws-null-call', root, undefined);

    const env = withRenderer.listenerEnv('probe');
    const response = await postJson(env.CRAFT_EVENTS_URL!, env.CRAFT_EVENTS_TOKEN!, {
      type: 'mail.received',
      title: '空回调不覆盖',
    });

    expect(response.status).toBe(200);
    expect(seen.map((e) => e.title)).toEqual(['空回调不覆盖']);
  });
});

/**
 * Regression: the bundled catalog ships code only. Enabling a catalog plugin
 * used to write `enabled: true` and then dead-end on readiness with
 * "not-installed", so the toggle looked broken. Enabling must adopt the
 * plugin (copy it into the workspace) so the start path actually runs.
 */
describe('enabling a catalog listener', () => {
  it('adopts it into the workspace so the toggle can start it', async () => {
    const root = makeRoot();
    // Minimal catalog plugin: manifest + a no-op sleep (node is on PATH in dev).
    const catalog = mkdtempSync(join(tmpdir(), 'craft-catalog-adopt-'));
    roots.push(catalog);
    const catDir = join(catalog, 'adopt');
    mkdirSync(catDir, { recursive: true });
    writeFileSync(
      join(catDir, 'manifest.json'),
      JSON.stringify({
        spec: 'craft-listener/1',
        id: 'adopt',
        name: 'Adopt',
        version: '1.0.0',
        runtime: { program: ['node', '-e', 'setTimeout(() => {}, 45000)'], readyTimeoutMs: 4000 },
      }, null, 2),
    );
    const previousCatalog = process.env.CRAFT_PLUGIN_CATALOG;
    process.env.CRAFT_PLUGIN_CATALOG = catalog;
    try {
      const service = await getEventService('ws-catalog-adopt', root);
      const status = await service.setListenerEnabled(root, 'adopt', true);

      // Adoption happened: the catalog dir was copied into the workspace.
      expect(existsSync(join(root, 'events', 'adopt', 'manifest.json'))).toBe(true);
      // And the start path ran instead of the readiness dead-end.
      expect(status.state).not.toBe('stopped');
      expect(status.lastError ?? '').not.toContain('插件尚未安装到工作区');
      await service.setListenerEnabled(root, 'adopt', false);
    } finally {
      if (previousCatalog === undefined) delete process.env.CRAFT_PLUGIN_CATALOG;
      else process.env.CRAFT_PLUGIN_CATALOG = previousCatalog;
    }
  });
});

/**
 * Host-owned slash commands: the plugin forwards the text, Craft decides the
 * meaning. /help answers from the catalogue, /stop stops the bound session.
 * Neither reaches the dispatcher (no onUnclaimed) and both are marked
 * handled by `host` with a routing trail entry.
 */
async function tickUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('tickUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A dispatch target that accepts everything and never blocks. */
const okDispatchTarget = {
  deliver: async () => true,
  isBusy: () => false,
  hasQueuedUserMessage: () => false,
} as unknown as import('./event-dispatcher.ts').DispatchTarget;

describe('host slash commands', () => {
  async function postCommand(service: Awaited<ReturnType<typeof getEventService>>, body: string): Promise<void> {
    // `telegram` is the posting listener id, so the ingested event's source
    // (and any outbox reply's listenerId) is `telegram`.
    const env = service.listenerEnv('telegram');
    const response = await postJson(env.CRAFT_EVENTS_URL!, env.CRAFT_EVENTS_TOKEN!, {
      type: 'telegram.message',
      title: body,
      body,
      links: [{ rel: 'reply', url: 'message://telegram/42/7' }],
    });
    expect(response.status).toBe(200);
  }

  it('/help queues a catalogue reply and does not dispatch', async () => {
    const root = makeRoot();
    const unclaimed: unknown[] = [];
    markChannelPaired(root, 'message://telegram/42')
    const service = await getEventService(
      'ws-slash-help',
      root,
      undefined,
      undefined,
      (event) => unclaimed.push(event),
    );

    await postCommand(service, '/help');
    await tickUntil(() => loadOutbox(root).length > 0);

    const records = loadOutbox(root);
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe('send_message');
    expect(records[0].listenerId).toBe('telegram');
    expect(records[0].args).toEqual({
      channelId: '42',
      text: expect.stringContaining('/stop'),
    });
    expect(records[0].status).toBe('pending');
    expect(unclaimed).toHaveLength(0);
  });

  it('/stop stops the thread-bound session and confirms', async () => {
    const root = makeRoot();
    markChannelPaired(root, 'message://telegram/42')
    bindThread(root, { threadKey: 'message://telegram/42', sessionId: 'sess-1' });
    const stopped: string[] = [];
    const service = await getEventService(
      'ws-slash-stop',
      root,
      undefined,
      undefined,
      undefined,
      { stop: async (sessionId: string) => { stopped.push(sessionId); } },
    );

    await postCommand(service, '/stop');
    await tickUntil(() => stopped.length > 0);

    expect(stopped).toEqual(['sess-1']);
    const records = loadOutbox(root);
    expect(records).toHaveLength(1);
    expect(records[0].args).toEqual({ channelId: '42', text: 'Stopped.' });
  });

  it('/stop without a binding reports idle', async () => {
    const root = makeRoot();
    markChannelPaired(root, 'message://telegram/42')
    const service = await getEventService('ws-slash-idle', root);

    await postCommand(service, '/stop');
    await tickUntil(() => loadOutbox(root).length > 0);

    const records = loadOutbox(root);
    expect(records).toHaveLength(1);
    expect(records[0].args).toEqual({ channelId: '42', text: 'Nothing is running here.' });
  });

  it('plain text is not a command and keeps the normal path', async () => {
    const root = makeRoot();
    const unclaimed: unknown[] = [];
    // A dispatch target is required for the dispatcher (and with it the
    // onUnclaimed hook) to exist at all.
    markChannelPaired(root, 'message://telegram/42')
    const service = await getEventService(
      'ws-slash-plain',
      root,
      undefined,
      okDispatchTarget,
      (event) => unclaimed.push(event),
    );

    await postCommand(service, 'hello there');
    await tickUntil(() => unclaimed.length > 0);

    expect(unclaimed).toHaveLength(1);
    expect(loadOutbox(root)).toHaveLength(0);
  });
});


/**
 * The host pairing gate: while a channel is unpaired, its messages never
 * enter the event store — the host answers with the pairing prompt or
 * redeems a `/pair <code>` attempt instead. Once paired, the same channel
 * flows through the normal event path.
 */
describe('host pairing gate', () => {
  async function postFromChannel(
    service: Awaited<ReturnType<typeof getEventService>>,
    body: string,
  ): Promise<void> {
    const env = service.listenerEnv('telegram');
    const response = await postJson(env.CRAFT_EVENTS_URL!, env.CRAFT_EVENTS_TOKEN!, {
      type: 'telegram.message',
      title: body,
      body,
      links: [{ rel: 'reply', url: 'message://telegram/42/9' }],
    });
    expect(response.status).toBe(200);
  }

  it('answers unpaired chats with the pairing prompt, and keeps them out of the event store', async () => {
    const root = makeRoot();
    const unclaimed: unknown[] = [];
    const service = await getEventService(
      'ws-pair-prompt',
      root,
      undefined,
      okDispatchTarget,
      (event) => unclaimed.push(event),
    );

    await postFromChannel(service, 'hello');
    await tickUntil(() => loadOutbox(root).length > 0);

    expect(loadOutbox(root)[0].args?.text).toContain('/pair');
    expect(unclaimed).toHaveLength(0);
    expect(service.list({}).length).toBe(0);
  });

  it('redeems /pair <code> and unlocks the channel for events', async () => {
    const root = makeRoot();
    const unclaimed: unknown[] = [];
    const service = await getEventService(
      'ws-pair-redeem',
      root,
      undefined,
      okDispatchTarget,
      (event) => unclaimed.push(event),
    );
    const { code } = generatePairingCode(root);

    await postFromChannel(service, `/pair ${code}`);
    await tickUntil(() => isChannelPaired(root, 'message://telegram/42'));
    expect(loadOutbox(root).some((record) => String(record.args?.text ?? '').includes('Paired'))).toBe(true);

    // The same channel, now paired: its messages are events again.
    await postFromChannel(service, 'count me');
    await tickUntil(() => service.list({}).length > 0);
    expect(service.list({})).toHaveLength(1);
    expect(unclaimed).toHaveLength(1);
  });

  it('answers unknown codes with the invalid-code text and stays unpaired', async () => {
    const root = makeRoot();
    const service = await getEventService('ws-pair-bad', root);

    await postFromChannel(service, '/pair NOPE9999');
    await tickUntil(() => loadOutbox(root).length > 0);

    expect(isChannelPaired(root, 'message://telegram/42')).toBe(false);
    expect(service.list({}).length).toBe(0);
  });
});

/**
 * Stage 5 judge wiring: a group channel set to `all` ingest holds its
 * messages in a batch window, and the (fake) model call decides what reaches
 * a session. The decision module itself is tested elsewhere; these pin the
 * host wiring: who is held, who is published, who is marked handled, and
 * what happens when the model route fails or the owner flips the channel.
 */
describe('channel judge (stage 5)', () => {
  const GROUP_KEY = 'message://telegram/-5095098301';

  async function makeJudgeService(
    root: string,
    workspaceId: string,
    callModel: (prompt: string) => Promise<string>,
  ) {
    const unclaimed: unknown[] = [];
    const service = await getEventService(
      workspaceId,
      root,
      undefined,
      okDispatchTarget,
      (event) => unclaimed.push(event),
    );
    service.setJudgeOptions({ callModel });
    markChannelPaired(root, GROUP_KEY);
    updateChannelGate(root, GROUP_KEY, { ingestMode: 'all' });
    return { service, unclaimed };
  }

  let messageNo = 0;
  async function postGroupMessage(
    service: Awaited<ReturnType<typeof getEventService>>,
    body: string,
    extraMeta: Record<string, string> = {},
  ): Promise<void> {
    messageNo += 1;
    const env = service.listenerEnv('telegram');
    const response = await postJson(env.CRAFT_EVENTS_URL!, env.CRAFT_EVENTS_TOKEN!, {
      type: 'telegram.message',
      title: body,
      body,
      dedupeKey: `msg-${messageNo}`,
      links: [{ rel: 'reply', url: `${GROUP_KEY}/${100 + messageNo}` }],
      meta: { channelKind: 'group', sender: 'Bob', ...extraMeta },
    });
    expect(response.status).toBe(200);
  }

  function judgeRouted(
    service: Awaited<ReturnType<typeof getEventService>>,
  ): import('@craft-agent/shared/events/event-store.ts').EventMeta[] {
    return service
      .list({})
      .filter((meta) => (meta.routing ?? []).some((entry) => entry.via === 'judge'));
  }

  it('holds an all-ingest batch until the judge runs; ignore marks both handled and dispatches nothing', async () => {
    const root = makeRoot();
    const prompts: string[] = [];
    const { service, unclaimed } = await makeJudgeService(root, 'ws-judge-ignore', async (prompt) => {
      prompts.push(prompt);
      return '{"action":"ignore","reason":"闲聊"}';
    });

    // A plain message with no mention stays in the open batch: nothing is
    // judged or published while the window is open.
    await postGroupMessage(service, '今天天气不错');
    expect(prompts).toHaveLength(0);
    expect(unclaimed).toHaveLength(0);

    // The mention closes the batch immediately; one call judges both.
    await postGroupMessage(service, '@bot 现在几点了', { mentionsBot: 'true' });
    await tickUntil(() => prompts.length === 1);
    expect(prompts[0]).toContain('今天天气不错');
    expect(prompts[0]).toContain('现在几点了');

    // Ignore: neither reaches a session, but both stay visible in the store
    // with a judge entry in the routing trail and a handled stamp, so the
    // unclaimed funnel never re-picks them.
    await tickUntil(() => judgeRouted(service).length === 2);
    expect(unclaimed).toHaveLength(0);
    expect(judgeRouted(service).every((meta) => meta.handledAt !== undefined)).toBe(true);
    expect(service.list({}).length).toBe(2);
  });

  it('publishes the whole batch when the judge says respond', async () => {
    const root = makeRoot();
    const { service, unclaimed } = await makeJudgeService(root, 'ws-judge-respond', async () => {
      return '{"action":"respond","reason":"在问助手"}';
    });

    await postGroupMessage(service, '这条在问助手');
    await postGroupMessage(service, '@bot 看下上一条', { mentionsBot: 'true' });
    await tickUntil(() => unclaimed.length === 2);
    const titles = unclaimed.map((event) => (event as { title?: string }).title);
    expect(titles).toEqual(['这条在问助手', '@bot 看下上一条']);
  });

  it('degrades a failed judge call to at_only: the mention survives, the chatter does not', async () => {
    const root = makeRoot();
    const { service, unclaimed } = await makeJudgeService(root, 'ws-judge-degrade', async () => {
      throw new Error('no model route');
    });

    await postGroupMessage(service, '有人在吗');
    await postGroupMessage(service, '@bot 帮个忙', { mentionsBot: 'true' });
    await tickUntil(() => unclaimed.length === 1);
    expect((unclaimed[0] as { title?: string }).title).toContain('帮个忙');

    await tickUntil(() => judgeRouted(service).length === 1);
    const skipped = judgeRouted(service)[0]!;
    expect(skipped.routing!.find((entry) => entry.via === 'judge')!.outcome).toContain('skipped');
  });

  it('never holds at_only channels: immediate publish, no judge call', async () => {
    const root = makeRoot();
    let judgeCalls = 0;
    const unclaimed: unknown[] = [];
    const service = await getEventService(
      'ws-judge-readonly',
      root,
      undefined,
      okDispatchTarget,
      (event) => unclaimed.push(event),
    );
    service.setJudgeOptions({
      callModel: async () => {
        judgeCalls++;
        return '{"action":"ignore"}';
      },
    });
    // No ingestMode set: the channel defaults to at_only — the judge must not
    // intervene in any way (zero regression for channels the owner never touched).
    markChannelPaired(root, GROUP_KEY);

    await postGroupMessage(service, '普通消息');
    await tickUntil(() => unclaimed.length === 1);
    expect(judgeCalls).toBe(0);
    expect(judgeRouted(service).length).toBe(0);
  });

  it('a channel flipped back to at_only mid-batch publishes instead of judging', async () => {
    const root = makeRoot();
    let judgeCalls = 0;
    const { service, unclaimed } = await makeJudgeService(root, 'ws-judge-flip', async () => {
      judgeCalls++;
      return '{"action":"ignore"}';
    });

    await postGroupMessage(service, '第一条');
    updateChannelGate(root, GROUP_KEY, { ingestMode: 'at_only' });
    await postGroupMessage(service, '@bot 第二条', { mentionsBot: 'true' }); // closes the batch

    await tickUntil(() => unclaimed.length === 2);
    expect(judgeCalls).toBe(0);
    expect(judgeRouted(service).length).toBe(0);
  });
});

describe('context-menu deletion (events & outbox)', () => {
  it('deleteEvents removes the named events and keeps the rest', async () => {
    const root = makeRoot();
    const service = await getEventService('ws-delete-events', root);
    const env = service.listenerEnv('probe');
    const ids: string[] = [];
    for (const title of ['keep one', 'drop one', 'drop two']) {
      const res = await postJson(env.CRAFT_EVENTS_URL!, env.CRAFT_EVENTS_TOKEN!, {
        type: 'probe.note',
        title,
      });
      expect(res.status).toBe(200);
      ids.push(JSON.parse(res.body).id);
    }
    // A ghost id must not inflate the removal count.
    expect(service.deleteEvents([ids[1], ids[2], 'evt-ghost'])).toBe(2);
    expect(service.list({}).map((meta) => meta.title)).toEqual(['keep one']);
  });

  it('deleteEvents is a no-op on an empty batch', async () => {
    const root = makeRoot();
    const service = await getEventService('ws-delete-empty', root);
    expect(service.deleteEvents([])).toBe(0);
  });

  it('outboxRemove drops the named records and keeps the rest', async () => {
    const root = makeRoot();
    const service = await getEventService('ws-outbox-remove', root);
    const rec1 = recordOutboxCall(root, {
      listenerId: 'telegram',
      action: 'send_message',
      args: { text: 'one' },
      ok: true,
      now: 1_000_000_001,
    });
    const rec2 = recordOutboxCall(root, {
      listenerId: 'telegram',
      action: 'send_message',
      args: { text: 'two' },
      ok: false,
      error: 'refused',
      now: 1_000_000_002,
    });
    const rec3 = recordOutboxCall(root, {
      listenerId: 'wechat',
      action: 'reply',
      args: { text: 'three' },
      ok: false,
      now: 1_000_000_003,
    });
    expect(rec1?.id).toBeTruthy();
    expect(rec2?.id).toBeTruthy();
    expect(rec3?.id).toBeTruthy();
    expect(service.outboxRemove([rec1!.id, rec3!.id])).toBe(2);
    expect(service.outboxList().map((record) => record.id)).toEqual([rec2!.id]);
  });
});
