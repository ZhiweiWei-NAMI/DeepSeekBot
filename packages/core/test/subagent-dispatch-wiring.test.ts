import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/workspaces/orchestrator-file-tools.js', () => ({
  installOrchestratorFileTools: vi.fn(async () => async () => undefined),
}));

import { apply, type BotHarnessCore } from '../src/index.js';
import { attachOperationalModule } from '../src/database/owner.js';
import {
  CHANNEL_SUBAGENT_DISPATCH_BASELINE_EVENT,
  CHANNEL_SUBAGENT_DISPATCH_EVENT,
} from '../src/channels/live.js';
import { FakeAgentHost, type FakeSession } from './dsh-agent-host-fixture.js';
import { createTempRoot } from './helpers.js';

const contexts: Context[] = [];

beforeEach(() => {
  vi.stubEnv('DSH_HOME', createTempRoot('botharness-subagent-dispatch-'));
});

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (ctx !== undefined) await ctx.fiber.dispose();
  }
  vi.unstubAllEnvs();
});

interface Harness {
  ctx: Context;
  host: FakeAgentHost;
  core: BotHarnessCore;
}

interface ChildSession {
  id: string;
  header: { parentSession: string; createdAt: number };
  seq: number;
  append(type: string, data: unknown): void;
  snapshotEvents(): readonly { type: string; seq: number; time: number; data: unknown }[];
}

function childSession(id: string, parentSessionId: string): ChildSession {
  return {
    id,
    header: { parentSession: parentSessionId, createdAt: Date.parse('2026-09-21T00:00:00.000Z') },
    seq: 0,
    append: () => undefined,
    snapshotEvents: () => [],
  };
}

function emitChildEvent(
  ctx: Context,
  session: ChildSession,
  type: string,
  data: unknown,
  seq = 0,
): void {
  ctx.emit(
    'session/event',
    session as never,
    { type, seq, time: Date.parse('2026-09-21T00:00:00.000Z'), data } as never,
  );
}

function toolCallEvent(callId: string, description: string) {
  return {
    type: 'tool/call',
    data: {
      turn: 1,
      step: 1,
      callId,
      name: 'bot_subagent',
      arguments: JSON.stringify({ description, run_in_background: true }),
    },
  };
}

function startHarness(onTurn: (session: FakeSession) => Promise<void> | void): Harness {
  const dshHome = process.env['DSH_HOME'] ?? '';
  const ctx = new Context();
  contexts.push(ctx);
  const host = new FakeAgentHost(
    { kind: 'completed' },
    {
      onAgentCreated: (agent) => ctx.emit('agent/created', { agent } as never),
      onSessionEvent: (session, event) =>
        ctx.emit('session/event', session as never, event as never),
      onTurn: async (session) => {
        await onTurn(session);
      },
    },
  );
  ctx.provide('tools', { register: () => () => undefined, guard: () => () => undefined });
  ctx.provide('systemPrompt', { section: () => () => undefined });
  ctx.provide('sessions', { list: () => host.sessions });
  ctx.provide('sessionPersistence', { stat: async () => ({}) } as never);
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
  attachOperationalModule(core.operationalDatabase, 'subagent-dispatch-fixture').transaction(
    (database) => {
      database
        .prepare(`INSERT OR IGNORE INTO workspace_grants
      (id, bot_slug, workspace_id, workspace_path, workspace_title, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          'grant-1',
          'ada',
          'test-workspace',
          dshHome,
          'Test Workspace',
          '2026-09-21T00:00:00.000Z',
        );
    },
    ['workspace-grants'],
  );
  return { ctx, host, core };
}

async function admitTurn(
  core: BotHarnessCore,
  channelId: string,
  messageId: string,
  body: string,
): Promise<void> {
  await core.channels.appendMessage(channelId, {
    id: messageId,
    at: '2026-09-21T00:00:01.000Z',
    author: { kind: 'human' },
    body,
  });
  const admission = core.runtime.admitDmMessage({ channelId, messageId, body });
  if (!admission.admitted) throw new Error(`admission rejected: ${admission.reason}`);
  await admission.settled;
}

interface OpenStream {
  frames: string[];
  readUntil(predicate: (frames: string[]) => boolean, timeoutMs?: number): Promise<string[]>;
  cancel(): Promise<void>;
}

function openStream(core: BotHarnessCore, channelId: string): OpenStream {
  const response = core.live.open(
    new Request(`http://localhost/api/botharness/stream?channelId=${channelId}&after=0`),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  return {
    frames,
    async readUntil(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(frames) && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
        ]);
        if (next === undefined || next.done) break;
        const text = decoder.decode(next.value);
        for (const block of text.split('\n\n')) if (block.trim().length > 0) frames.push(block);
      }
      return frames;
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  };
}

async function readReconnectBaseline(core: BotHarnessCore, channelId: string): Promise<unknown[]> {
  const stream = openStream(core, channelId);
  try {
    const frames = await stream.readUntil((collected) =>
      hasEvent(collected, CHANNEL_SUBAGENT_DISPATCH_BASELINE_EVENT),
    );
    return dispatchFrames(frames, CHANNEL_SUBAGENT_DISPATCH_BASELINE_EVENT);
  } finally {
    await stream.cancel();
  }
}

function hasEvent(frames: string[], event: string): boolean {
  const marker = `event: ${event}`;
  return frames.some((block) => block.split('\n').some((line) => line.trim() === marker));
}

function dispatchFrames(frames: string[], event: string): unknown[] {
  const marker = `event: ${event}`;
  return frames
    .filter((block) => block.split('\n').some((line) => line.trim() === marker))
    .flatMap((block) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('');
      return data.length === 0 ? [] : [JSON.parse(data) as unknown];
    });
}

describe('subagent dispatch wiring', () => {
  it('commits a system card for a real tool call and streams it to the Channel', async () => {
    const { ctx, core } = startHarness(async (session) => {
      session.append('tool/call', toolCallEvent('call-live', 'Audit the release notes').data);

      const child = childSession('session-child', session.id);
      ctx.emit('agent/created', {
        agent: { session: child, ctx: { get: () => undefined } },
      } as never);
      emitChildEvent(ctx, child, 'turn/start', { turn: 1 });
      emitChildEvent(
        ctx,
        child,
        'subagent/descriptor',
        { version: 3, mode: 'one-shot', provider: 'spawn', label: 'Audit the release notes' },
        1,
      );
      emitChildEvent(ctx, child, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 2);
    });
    core.registry.create({ slug: 'ada', displayName: 'Ada' });
    const dm = core.channels.getOrCreateDm('ada', 'Ada');
    if (dm === undefined) throw new Error('DM channel missing');

    const stream = openStream(core, dm.id);
    try {
      await admitTurn(core, dm.id, 'human-1', '请核对发布状态');

      await vi.waitFor(() => {
        const card = core.channels.readMessages(dm.id).find((message) => message.subagentDispatch);
        expect(card).toBeDefined();
        expect(card!.author).toEqual({ kind: 'system' });
        expect(card!.body).toBe('Subagent: Audit the release notes');
        expect(card!.subagentDispatch).toMatchObject({
          dispatchId: 'call-live',
          kind: 'subagent',
          status: 'queued',
          revision: 1,
        });
        expect(JSON.stringify(card)).not.toContain('run_in_background');
      });

      await stream.readUntil((collected) =>
        dispatchFrames(collected, CHANNEL_SUBAGENT_DISPATCH_EVENT).some(
          (payload) =>
            (payload as { subagentDispatch: { status: string } }).subagentDispatch.status ===
            'completed',
        ),
      );
      const statuses = dispatchFrames(stream.frames, CHANNEL_SUBAGENT_DISPATCH_EVENT).map(
        (payload) =>
          (payload as { subagentDispatch: { status: string; revision: number } }).subagentDispatch,
      );
      expect(statuses.map((entry) => entry.status)).toEqual(['queued', 'running', 'completed']);
      expect(statuses.map((entry) => entry.revision)).toEqual([1, 2, 3]);
      expect(
        stream.frames.some((block) =>
          block.split('\n').some((line) => line.trim() === 'event: channel/message'),
        ),
      ).toBe(true);

      const baseline = await readReconnectBaseline(core, dm.id);
      expect(baseline).toHaveLength(1);
      expect(baseline[0]).toMatchObject({
        channelId: dm.id,
        dispatches: [
          {
            messageId: expect.stringContaining('subagent-dispatch-call-live'),
            subagentDispatch: { status: 'completed', revision: 3, dispatchId: 'call-live' },
          },
        ],
      });
    } finally {
      await stream.cancel();
    }
  });

  it('settles a continuable child only through the Host subagent/end edge', async () => {
    const { ctx, core } = startHarness(async (session) => {
      session.append('tool/call', toolCallEvent('call-cont', 'Continuable review').data);
      const child = childSession('session-child-cont', session.id);
      ctx.emit('agent/created', {
        agent: { session: child, ctx: { get: () => undefined } },
      } as never);
      emitChildEvent(ctx, child, 'turn/start', { turn: 1 });
      emitChildEvent(
        ctx,
        child,
        'subagent/descriptor',
        { version: 3, mode: 'continuable', provider: 'spawn', label: 'Continuable review' },
        1,
      );

      emitChildEvent(ctx, child, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 2);
    });
    core.registry.create({ slug: 'ada', displayName: 'Ada' });
    const dm = core.channels.getOrCreateDm('ada', 'Ada');
    if (dm === undefined) throw new Error('DM channel missing');

    const stream = openStream(core, dm.id);
    try {
      await admitTurn(core, dm.id, 'human-cont', '请核对发布状态');
      await vi.waitFor(() => {
        const card = core.channels.readMessages(dm.id).find((message) => message.subagentDispatch);
        expect(card?.subagentDispatch).toMatchObject({ dispatchId: 'call-cont', status: 'queued' });
      });
      await stream.readUntil(
        (collected) =>
          dispatchFrames(collected, CHANNEL_SUBAGENT_DISPATCH_EVENT).at(-1) !== undefined &&
          (
            dispatchFrames(collected, CHANNEL_SUBAGENT_DISPATCH_EVENT).at(-1) as {
              subagentDispatch: { status: string };
            }
          ).subagentDispatch.status === 'running',
      );
      expect(
        dispatchFrames(stream.frames, CHANNEL_SUBAGENT_DISPATCH_EVENT).map(
          (payload) =>
            (payload as { subagentDispatch: { status: string } }).subagentDispatch.status,
        ),
      ).toEqual(['queued', 'running']);
      expect(core.subagentDispatches.get(dm.id, 'call-cont')?.status).toBe('running');

      ctx.emit('subagent/end', {
        runId: 'run-cont',
        provider: 'spawn',
        id: 'session-child-cont',
        local: true,
        stopReason: 'completed',
      } as never);
      await vi.waitFor(() => {
        expect(core.subagentDispatches.get(dm.id, 'call-cont')?.status).toBe('completed');
      });
      const baseline = await readReconnectBaseline(core, dm.id);
      expect(baseline[0]).toMatchObject({
        dispatches: [{ subagentDispatch: { dispatchId: 'call-cont', status: 'completed' } }],
      });
    } finally {
      await stream.cancel();
    }
  });

  it('commits a declined card when the tool refused before any child existed', async () => {
    const { ctx, core } = startHarness(async (session) => {
      session.append('tool/call', toolCallEvent('call-refused', 'Impossible route').data);
      session.append('tool/result', {
        turn: 1,
        step: 1,
        message: { toolCallId: 'call-refused', isError: true },
      });
    });
    core.registry.create({ slug: 'ada', displayName: 'Ada' });
    const dm = core.channels.getOrCreateDm('ada', 'Ada');
    if (dm === undefined) throw new Error('DM channel missing');

    await admitTurn(core, dm.id, 'human-2', '请核对发布状态');

    await vi.waitFor(() => {
      const card = core.channels.readMessages(dm.id).find((message) => message.subagentDispatch);
      expect(card).toBeDefined();
      expect(card!.subagentDispatch).toMatchObject({
        dispatchId: 'call-refused',
        status: 'declined',
        reasonCode: 'refused',
      });
      expect(card!.subagentDispatch?.resolvedRoute).toBeUndefined();
    });

    const reconnect = await readReconnectBaseline(core, dm.id);
    const [payload] = reconnect;
    expect(payload).toMatchObject({
      dispatches: [
        {
          subagentDispatch: {
            status: 'declined',
            reasonCode: 'refused',
            dispatchId: 'call-refused',
          },
        },
      ],
    });
  });
});
