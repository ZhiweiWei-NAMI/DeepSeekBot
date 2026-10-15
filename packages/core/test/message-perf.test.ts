import { Context } from '@deepseek-ai/cordis';
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, vi } from 'vitest';
import { beforeEach, describe, expect, it } from 'vitest';

vi.mock('../src/workspaces/orchestrator-file-tools.js', () => ({
  installOrchestratorFileTools: vi.fn(async () => async () => undefined),
}));

import { apply, type BotHarnessCore } from '../src/index.js';
import { createMessagePerfTracker } from '../src/usage/message-perf.js';
import type { DshSessionEvent } from '../src/sessions/source.js';
import { FakeAgentHost } from './dsh-agent-host-fixture.js';
import { createTempRoot } from './helpers.js';

function textRun(time0: number, texts: string[]): unknown {
  return { type: 'text-chunks', time0, index: 0, dt: [], texts };
}

function toolRun(time0: number, args: string[]): unknown {
  return {
    type: 'tool-call-chunks',
    time0,
    index: 0,
    dt: [],
    id: 'call-1',
    name: 'channel_read',
    args,
  };
}

function usageChunk(time: number, outputTokens: number): unknown {
  return {
    type: 'chunk',
    time,
    chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens } },
  };
}

function event(
  type: string,
  seq: number,
  time: number,
  data: Record<string, unknown>,
): DshSessionEvent {
  return { type, seq, time, data };
}

function stepStart(seq: number, time: number, turn = 1, step = 0): DshSessionEvent {
  return event('step/start', seq, time, { turn, step });
}

function settlement(input: {
  seq: number;
  time: number;
  turn?: number;
  step?: number;
  stream: unknown;
  outputTokens?: number;
  extraUsage?: Record<string, unknown>;
}): DshSessionEvent {
  return event('assistant/message', input.seq, input.time, {
    turn: input.turn ?? 1,
    step: input.step ?? 0,
    message: createAssistantMessage({
      content: [{ type: 'text', text: '答复' }],
      source: { provider: 'test', model: 'test' },
    }),
    ...(input.outputTokens === undefined
      ? {}
      : { usage: { inputTokens: 10, outputTokens: input.outputTokens, ...input.extraUsage } }),
    stream: input.stream,
  });
}

describe('message perf fold', () => {
  it('counts outputTokens and the decode span of one settlement that has usage and a first token', () => {
    const tracker = createMessagePerfTracker();
    tracker.handleSessionEvent('s', stepStart(1, 1_000));
    tracker.handleSessionEvent(
      's',
      event('assistant/attempt', 2, 1_100, { turn: 1, step: 0, stream: [textRun(1_600, ['你'])] }),
    );
    tracker.handleSessionEvent(
      's',
      settlement({ seq: 3, time: 2_000, stream: [textRun(1_600, ['你'])], outputTokens: 40 }),
    );

    expect(tracker.forSession('s')).toEqual({
      sessionId: 's',
      turn: 1,
      outputTokens: 40,
      decodeMs: 400,
      ttftMs: 600,
      steps: 1,
    });
  });

  it('reports the provider outputTokens bucket unchanged, with no reasoning arithmetic', () => {
    const tracker = createMessagePerfTracker();
    tracker.handleSessionEvent('s', stepStart(1, 1_000));
    tracker.handleSessionEvent(
      's',
      settlement({
        seq: 2,
        time: 1_500,
        stream: [textRun(1_200, ['你'])],
        outputTokens: 40,
        extraUsage: { reasoningTokens: 7 },
      }),
    );

    expect(tracker.forSession('s')?.outputTokens).toBe(40);
  });

  it('counts one settlement once, however often the event is replayed', () => {
    const tracker = createMessagePerfTracker();
    tracker.handleSessionEvent('s', stepStart(1, 1_000));
    const settled = settlement({
      seq: 2,
      time: 2_000,
      stream: [textRun(1_600, ['你'])],
      outputTokens: 40,
    });
    tracker.handleSessionEvent('s', settled);
    tracker.handleSessionEvent('s', settled);

    tracker.handleSessionEvent(
      's',
      settlement({ seq: 3, time: 2_000, stream: [textRun(1_600, ['你'])], outputTokens: 40 }),
    );

    const perf = tracker.forSession('s');
    expect(perf).toMatchObject({ outputTokens: 40, decodeMs: 400, steps: 1 });
  });

  it('sums the steps of one turn up to the send boundary and keeps the first step TTFT', () => {
    const tracker = createMessagePerfTracker();
    tracker.handleSessionEvent('s', stepStart(1, 1_000));
    tracker.handleSessionEvent(
      's',
      settlement({ seq: 2, time: 2_000, stream: [textRun(1_600, ['你'])], outputTokens: 40 }),
    );
    tracker.handleSessionEvent('s', event('step/end', 3, 2_100, { turn: 1, step: 0 }));

    tracker.handleSessionEvent('s', stepStart(4, 3_000, 1, 1));
    tracker.handleSessionEvent(
      's',
      settlement({
        seq: 5,
        time: 3_900,
        step: 1,
        stream: [textRun(3_500, ['好'])],
        outputTokens: 60,
      }),
    );

    expect(tracker.forSession('s')).toEqual({
      sessionId: 's',
      turn: 1,
      outputTokens: 100,
      decodeMs: 400 + 400,
      ttftMs: 600,
      steps: 2,
    });
  });

  it('keeps the first token of a step across an in-step retry', () => {
    const tracker = createMessagePerfTracker();
    tracker.handleSessionEvent('s', stepStart(1, 1_000));
    tracker.handleSessionEvent(
      's',
      event('assistant/attempt', 2, 1_200, { turn: 1, step: 0, stream: [textRun(1_700, [''])] }),
    );
    tracker.handleSessionEvent(
      's',
      event('assistant/attempt', 3, 1_300, { turn: 1, step: 0, stream: [toolRun(1_650, ['{}'])] }),
    );
    tracker.handleSessionEvent(
      's',
      settlement({
        seq: 4,
        time: 2_000,
        stream: [textRun(1_900, ['你'])],
        outputTokens: 40,
      }),
    );

    expect(tracker.forSession('s')).toMatchObject({ ttftMs: 650, decodeMs: 350 });
  });

  it('writes nothing for a settlement without usage, a failed attempt, or an unknown first token', () => {
    const withoutUsage = createMessagePerfTracker();
    withoutUsage.handleSessionEvent('s', stepStart(1, 1_000));
    withoutUsage.handleSessionEvent(
      's',
      settlement({ seq: 2, time: 2_000, stream: [textRun(1_600, ['你'])] }),
    );
    expect(withoutUsage.forSession('s')).toBeUndefined();

    const failedAttempt = createMessagePerfTracker();
    failedAttempt.handleSessionEvent('s', stepStart(1, 1_000));
    failedAttempt.handleSessionEvent(
      's',
      event('assistant/attempt', 2, 1_100, { turn: 1, step: 0, stream: [textRun(1_600, ['你'])] }),
    );
    expect(failedAttempt.forSession('s')).toBeUndefined();

    const noToken = createMessagePerfTracker();
    noToken.handleSessionEvent('s', stepStart(1, 1_000));
    noToken.handleSessionEvent(
      's',
      settlement({ seq: 2, time: 2_000, stream: [usageChunk(2_000, 40)], outputTokens: 40 }),
    );
    expect(noToken.forSession('s')).toBeUndefined();

    const malformedUsage = createMessagePerfTracker();
    malformedUsage.handleSessionEvent('s', stepStart(1, 1_000));
    malformedUsage.handleSessionEvent(
      's',
      event('assistant/message', 2, 2_000, {
        turn: 1,
        step: 0,
        usage: { outputTokens: '40' },
        stream: [textRun(1_600, ['你'])],
      }),
    );
    expect(malformedUsage.forSession('s')).toBeUndefined();

    const negativeUsage = createMessagePerfTracker();
    negativeUsage.handleSessionEvent('s', stepStart(1, 1_000));
    negativeUsage.handleSessionEvent(
      's',
      settlement({ seq: 2, time: 2_000, stream: [textRun(1_600, ['你'])], outputTokens: -5 }),
    );
    expect(negativeUsage.forSession('s')).toBeUndefined();
  });

  it('writes nothing without a positive decode span', () => {
    const tracker = createMessagePerfTracker();
    tracker.handleSessionEvent('s', stepStart(1, 1_000));
    tracker.handleSessionEvent(
      's',
      settlement({ seq: 2, time: 1_600, stream: [textRun(1_600, ['你'])], outputTokens: 40 }),
    );

    expect(tracker.forSession('s')).toBeUndefined();
  });

  it('publishes nothing before a step is open or after the turn was not observed from its first step', () => {
    const closed = createMessagePerfTracker();
    closed.handleSessionEvent('s', stepStart(1, 1_000));
    closed.handleSessionEvent(
      's',
      settlement({ seq: 2, time: 2_000, stream: [textRun(1_600, ['你'])], outputTokens: 40 }),
    );
    closed.handleSessionEvent('s', event('step/end', 3, 2_100, { turn: 1, step: 0 }));
    expect(closed.forSession('s')).toBeUndefined();

    const midTurn = createMessagePerfTracker();
    midTurn.handleSessionEvent('s', stepStart(1, 3_000, 1, 2));
    midTurn.handleSessionEvent(
      's',
      settlement({
        seq: 2,
        time: 3_900,
        step: 2,
        stream: [textRun(3_500, ['你'])],
        outputTokens: 40,
      }),
    );
    expect(midTurn.forSession('s')).toBeUndefined();
  });

  it('suppresses a turn whose event stream skipped a sequence number', () => {
    const tracker = createMessagePerfTracker();
    tracker.handleSessionEvent('s', stepStart(1, 1_000));
    tracker.handleSessionEvent(
      's',
      settlement({ seq: 2, time: 2_000, stream: [textRun(1_600, ['你'])], outputTokens: 40 }),
    );
    tracker.handleSessionEvent('s', event('step/end', 3, 2_100, { turn: 1, step: 0 }));
    tracker.handleSessionEvent('s', stepStart(9, 3_000, 1, 1));
    tracker.handleSessionEvent(
      's',
      settlement({
        seq: 10,
        time: 3_900,
        step: 1,
        stream: [textRun(3_500, ['好'])],
        outputTokens: 60,
      }),
    );

    expect(tracker.forSession('s')).toBeUndefined();
  });

  it('keeps turns and Sessions apart', () => {
    const tracker = createMessagePerfTracker();
    tracker.handleSessionEvent('s', stepStart(1, 1_000));
    tracker.handleSessionEvent(
      's',
      settlement({ seq: 2, time: 2_000, stream: [textRun(1_600, ['你'])], outputTokens: 40 }),
    );
    tracker.handleSessionEvent('s', event('step/end', 3, 2_100, { turn: 1, step: 0 }));
    tracker.handleSessionEvent(
      's',
      event('turn/end', 4, 2_200, { turn: 1, reason: { kind: 'completed' } }),
    );

    tracker.handleSessionEvent('other', stepStart(1, 5_000, 1, 0));
    tracker.handleSessionEvent(
      'other',
      settlement({ seq: 2, time: 5_300, stream: [textRun(5_100, ['嗨'])], outputTokens: 9 }),
    );

    expect(tracker.forSession('s')).toBeUndefined();
    expect(tracker.forSession('other')).toMatchObject({
      sessionId: 'other',
      outputTokens: 9,
      steps: 1,
    });

    tracker.handleSessionEvent('s', stepStart(10, 6_000, 2, 0));
    tracker.handleSessionEvent(
      's',
      settlement({
        seq: 11,
        time: 6_400,
        turn: 2,
        stream: [textRun(6_200, ['新'])],
        outputTokens: 5,
      }),
    );
    expect(tracker.forSession('s')).toEqual({
      sessionId: 's',
      turn: 2,
      outputTokens: 5,
      decodeMs: 200,
      ttftMs: 200,
      steps: 1,
    });
  });

  it('reads one session snapshot twice with the same numbers, and forgets on clear', () => {
    const tracker = createMessagePerfTracker();
    tracker.handleSessionEvent('s', stepStart(1, 1_000));
    tracker.handleSessionEvent(
      's',
      settlement({ seq: 2, time: 2_000, stream: [textRun(1_600, ['你'])], outputTokens: 40 }),
    );
    const first = tracker.forSession('s');
    const second = tracker.forSession('s');
    expect(first).toEqual(second);
    expect(first).not.toBe(second);

    tracker.clear('s');
    expect(tracker.forSession('s')).toBeUndefined();
  });
});

describe('message perf through the Host wiring', () => {
  const contexts: Context[] = [];

  beforeEach(() => {
    vi.stubEnv('DSH_HOME', createTempRoot('botharness-message-perf-'));
  });

  afterEach(async () => {
    while (contexts.length > 0) await contexts.pop()?.fiber.dispose();
    vi.unstubAllEnvs();
  });

  function startHarness(
    onTurn: (session: FakeLike, tools: readonly ToolDefinition[]) => Promise<void>,
  ) {
    const dshHome = process.env['DSH_HOME'] ?? '';
    const ctx = new Context();
    contexts.push(ctx);
    const stored = new Set<string>();
    const host: FakeAgentHost = new FakeAgentHost(
      { kind: 'completed' },
      {
        onAgentCreated: (agent) => {
          for (const session of host.sessions) stored.add(session.id);
          ctx.emit('agent/created', { agent } as never);
        },
        onSessionEvent: (session, event) =>
          ctx.emit('session/event', session as never, event as never),
        onTurn,
      },
    );
    ctx.provide('tools', { register: () => () => undefined, guard: () => () => undefined });
    ctx.provide('systemPrompt', { section: () => () => undefined });
    ctx.provide('sessions', { list: () => host.sessions });
    ctx.provide('sessionPersistence', {
      stat: async (id: string) => (stored.has(id) ? {} : undefined),
    } as never);
    ctx.provide('agents', host as never);
    ctx.provide('workspaceRegistry', {
      get: () => undefined,
      list: () => [],
    } as never);
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test', model: 'test' }),
    });
    apply(ctx, { enabled: true });
    const core = ctx.get('botharness') as BotHarnessCore | undefined;
    if (core === undefined) throw new Error('core was not provided');
    return { ctx, core, dshHome, host };
  }

  function isTriageTurn(host: FakeAgentHost, sessionId: string): boolean {
    const message = host.received.get(sessionId)?.at(-1);
    return JSON.stringify(message ?? '').includes('[Triage]');
  }

  async function admit(core: BotHarnessCore, channelId: string, messageId: string, body: string) {
    await core.channels.appendMessage(channelId, {
      id: messageId,
      at: '2026-09-21T00:00:01.000Z',
      author: { kind: 'human' },
      body,
    });
    const admission = core.runtime.admitDmMessage({ channelId, messageId, body });
    if (!admission.admitted) throw new Error(`admission rejected: ${admission.reason}`);
    await admission.settled;
    await core.runtime.whenIdle();
  }

  interface FakeLike {
    id: string;
    append(type: string, data: unknown, time?: number): void;
    snapshotEvents(): readonly { type: string; data: unknown }[];
  }

  function turnOf(session: FakeLike): number {
    const starts = session
      .snapshotEvents()
      .filter((entry) => entry.type === 'turn/start')
      .map((entry) => (entry.data as { turn: number }).turn);
    return starts.at(-1) ?? 1;
  }

  async function send(
    session: FakeLike,
    tools: readonly ToolDefinition[],
    body: string,
    callId: string,
  ) {
    const channelSend = tools.find((tool) => tool.name === 'channel_send');
    if (channelSend === undefined) throw new Error('channel_send is unavailable');
    await channelSend.execute({ body }, { callId, rootCallId: callId } as ToolRunContext);
    return session;
  }

  it('attaches the turn snapshot of a real reply and never fabricates one', async () => {
    const sessions: string[] = [];
    const replyTurns: number[] = [];
    const { core, host } = startHarness(async (session, tools) => {
      if (isTriageTurn(host, session.id)) return;
      sessions.push(session.id);
      const turn = turnOf(session);
      replyTurns.push(turn);
      session.append('step/start', { turn, step: 0 }, 1_000);
      session.append(
        'assistant/attempt',
        { turn, step: 0, stream: [textRun(1_600, ['你'])] },
        1_100,
      );
      session.append(
        'assistant/message',
        {
          turn,
          step: 0,
          message: createAssistantMessage({
            content: [{ type: 'text', text: '答复' }],
            source: { provider: 'test', model: 'test' },
          }),
          usage: { inputTokens: 10, outputTokens: 40, reasoningTokens: 7 },
          stream: [textRun(1_600, ['你'])],
        },
        2_000,
      );
      await send(session, tools, '核查完成', 'call-1');
      session.append('step/end', { turn, step: 0 }, 2_100);
    });
    core.registry.create({ slug: 'ada', displayName: 'Ada' });
    const dm = core.channels.getOrCreateDm('ada', 'Ada');
    if (dm === undefined) throw new Error('DM channel missing');

    await admit(core, dm.id, 'human-1', '核查发布状态');

    const replies = core.channels
      .readMessages(dm.id)
      .filter((message) => message.author.kind === 'bot');
    expect(replies.map((message) => message.body)).toEqual(['核查完成']);
    expect(sessions).toHaveLength(1);
    expect(replyTurns).toEqual([1]);
    expect(replies[0]?.perf).toEqual({
      sessionId: sessions[0],
      turn: 1,
      outputTokens: 40,
      decodeMs: 400,
      ttftMs: 600,
      steps: 1,
    });
    expect(
      core.channels.readMessages(dm.id).find((message) => message.id === 'human-1')?.perf,
    ).toBeUndefined();

    const direct = await core.runtime.runDirectBotTool!(
      'ada',
      'channel_send',
      { channel_id: dm.id, body: '直接调用' },
      new AbortController().signal,
    );
    const directMessage = core.channels
      .readMessages(dm.id)
      .find((message) => message.body === '直接调用');
    expect(directMessage).toBeDefined();
    expect(directMessage?.perf).toBeUndefined();
    expect(direct.result).toMatchObject({ channelId: dm.id });
  });

  it('sums a multi-step turn, keeps each message on its own turn, and sends twice per step', async () => {
    const replyTurns: number[] = [];
    const { core, host } = startHarness(async (session, tools) => {
      if (isTriageTurn(host, session.id)) return;
      const turn = turnOf(session);
      replyTurns.push(turn);
      if (replyTurns.length === 1) {
        session.append('step/start', { turn, step: 0 }, 1_000);
        session.append(
          'assistant/message',
          {
            turn,
            step: 0,
            message: createAssistantMessage({
              content: [{ type: 'text', text: '先查一下' }],
              source: { provider: 'test', model: 'test' },
            }),
            usage: { inputTokens: 10, outputTokens: 40 },
            stream: [textRun(1_600, ['先'])],
          },
          2_000,
        );
        await send(session, tools, '第一轮答复', 'call-1');
        session.append('step/end', { turn, step: 0 }, 2_100);
        return;
      }

      session.append('step/start', { turn, step: 0 }, 3_000);
      session.append(
        'assistant/message',
        {
          turn,
          step: 0,
          message: createAssistantMessage({
            content: [
              { type: 'tool-call', id: ToolCallId('t1'), name: 'channel_read', arguments: '{}' },
            ],
            source: { provider: 'test', model: 'test' },
          }),
          usage: { inputTokens: 10, outputTokens: 10 },
          stream: [toolRun(3_100, ['{}'])],
        },
        3_200,
      );
      session.append('step/end', { turn, step: 0 }, 3_300);
      session.append('step/start', { turn, step: 1 }, 4_000);
      session.append(
        'assistant/message',
        {
          turn,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: '第二轮答复' }],
            source: { provider: 'test', model: 'test' },
          }),
          usage: { inputTokens: 10, outputTokens: 20 },
          stream: [textRun(4_500, ['第二'])],
        },
        5_000,
      );
      await send(session, tools, '第二轮答复', 'call-2');
      await send(session, tools, '第二轮补充', 'call-3');
      session.append('step/end', { turn, step: 1 }, 5_100);
    });
    core.registry.create({ slug: 'ada', displayName: 'Ada' });
    const dm = core.channels.getOrCreateDm('ada', 'Ada');
    if (dm === undefined) throw new Error('DM channel missing');

    await admit(core, dm.id, 'human-1', '核查发布状态');
    await admit(core, dm.id, 'human-2', '再核查一次');

    const replies = core.channels
      .readMessages(dm.id)
      .filter((message) => message.author.kind === 'bot')
      .reverse();
    expect(replies.map((message) => message.body)).toEqual([
      '第一轮答复',
      '第二轮答复',
      '第二轮补充',
    ]);
    const orchestratorSession = replies[0]?.perf?.sessionId;
    expect(orchestratorSession).toBeDefined();
    expect(replyTurns).toHaveLength(2);
    expect(replies[0]?.perf).toEqual({
      sessionId: orchestratorSession,
      turn: replyTurns[0],
      outputTokens: 40,
      decodeMs: 400,
      ttftMs: 600,
      steps: 1,
    });

    for (const reply of replies.slice(1)) {
      expect(reply.perf).toEqual({
        sessionId: orchestratorSession,
        turn: replyTurns[1],
        outputTokens: 30,
        decodeMs: 100 + 500,
        ttftMs: 100,
        steps: 2,
      });
    }
  });
});
