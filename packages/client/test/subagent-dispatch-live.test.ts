import { describe, expect, it, vi } from 'vitest';
import {
  createSubagentDispatchRegistry,
  subagentDispatchMessageId,
} from '../../core/src/channels/subagent-dispatch.js';
import {
  CHANNEL_SUBAGENT_DISPATCH_BASELINE_EVENT,
  createChannelLiveHub,
} from '../../core/src/channels/live.js';
import { openLiveFrames } from '../../core/src/channels/live-frames.js';
import type { ChannelStore } from '../../core/src/channels/store.js';
import { parseChannelMessage } from '../src/client/bridge.js';
import {
  installChannelFollow,
  mountChannelLive,
  type ChannelFollow,
} from '../src/client/channel-live.js';
import { createStore, type ChannelMessage, type ChannelSummary } from '../src/client/store.js';
import { dispatchFixture } from './fixtures/subagent-dispatch.js';

const CHANNEL: ChannelSummary = {
  id: 'group-fixture',
  type: 'group',
  name: 'Fixture',
  members: [],
  createdAt: dispatchFixture.updatedAt,
  updatedAt: dispatchFixture.updatedAt,
};
const messageId = subagentDispatchMessageId(dispatchFixture.dispatchId);
const anchor = (subagentDispatch = dispatchFixture): ChannelMessage => ({
  id: messageId,
  at: dispatchFixture.updatedAt,
  author: { kind: 'system' },
  body: '',
  subagentDispatch,
});
class FakeSource extends EventTarget {
  readyState = 1;
  onerror: ((event: Event) => void) | null = null;
  onopen = null;
  close() {
    this.readyState = 2;
  }
  emit(type: string, value: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value) }));
  }
}
function setup(messages: ChannelMessage[] = [anchor()]) {
  const store = createStore();
  store.setMode('bot');
  store.setRoster([], [CHANNEL]);
  store.select({ kind: 'channel', channelId: CHANNEL.id });
  store.setConversation({ channel: CHANNEL, status: 'ready', messages, revision: 1 });
  const sources: FakeSource[] = [];
  const dispose = mountChannelLive(
    store,
    { refreshChannelMessages: vi.fn(async () => undefined) },
    () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
  );
  const payload = (patch = {}, channelId = CHANNEL.id) => ({
    channelId,
    messageId,
    subagentDispatch: { ...dispatchFixture, ...patch },
  });
  return { store, sources, dispose, payload };
}

describe('dispatch history and live integration (offline)', () => {
  it('converges the initial journal anchor to the Host latest terminal reconnect baseline', async () => {
    const registry = createSubagentDispatchRegistry();
    const transition = {
      channelId: CHANNEL.id,
      dispatchId: dispatchFixture.dispatchId,
      parentSessionId: dispatchFixture.parentSessionId,
      description: dispatchFixture.description,
      at: dispatchFixture.updatedAt,
    };
    const initial = registry.apply({ ...transition, status: 'running' })!;
    // Synthetic descriptor refinements produce real registry revisions 2–4.
    for (const reasoningEffort of [undefined, 'low', 'high']) {
      registry.apply({
        ...transition,
        status: 'running',
        resolvedRoute: {
          provider: 'example-provider',
          model: 'review-model',
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        },
      });
    }
    const terminal = registry.apply({ ...transition, status: 'completed' })!;
    expect(initial.projection).toMatchObject({ status: 'running', revision: 1 });
    expect(terminal.projection).toMatchObject({ status: 'completed', revision: 5 });
    const history = parseChannelMessage(anchor(initial.projection))!;
    const { store, sources, dispose } = setup([history]);
    const hostStore = {
      get: (id: string) => (id === CHANNEL.id ? CHANNEL : undefined),
      revision: () => 1,
      messagesAfter: () => [],
      readPosition: () => undefined,
    } as unknown as ChannelStore;
    const hub = createChannelLiveHub(hostStore, undefined, undefined, registry);
    const controller = new AbortController();
    try {
      let replayed = false;
      for await (const frame of openLiveFrames(
        (request) => hub.open(request),
        `channelId=${CHANNEL.id}&after=1`,
        '',
        controller.signal,
      )) {
        if (frame.event !== CHANNEL_SUBAGENT_DISPATCH_BASELINE_EVENT) continue;
        const payload = JSON.parse(frame.data);
        expect(payload.dispatches[0]).toMatchObject({
          messageId,
          subagentDispatch: { status: 'completed', revision: 5 },
        });
        const source = sources[0]!;
        source.emit(frame.event, payload);
        expect(store.getSnapshot().conversation.messages[0]?.subagentDispatch).toMatchObject({
          status: 'completed',
          revision: 5,
        });
        expect(store.getSnapshot().conversation.messages).toHaveLength(1);
        expect(store.getSnapshot().conversation.revision).toBe(1);
        // Replayed older history and even a higher-revision nonterminal baseline
        // cannot undo an observed terminal fact.
        store.setConversation({ messages: [history] });
        source.emit(frame.event, {
          ...payload,
          dispatches: [{ messageId, subagentDispatch: { ...initial.projection, revision: 99 } }],
        });
        expect(store.getSnapshot().conversation.messages[0]?.subagentDispatch).toMatchObject({
          status: 'completed',
          revision: 5,
        });
        store.setConversation({ messages: [{ ...history, contentPurged: true }] });
        source.emit(frame.event, payload);
        expect(store.getSnapshot().conversation.messages[0]?.contentPurged).toBe(true);
        expect(store.getSnapshot().conversation.messages[0]?.body).toBe('');
        replayed = true;
        break;
      }
      expect(replayed).toBe(true);
    } finally {
      controller.abort();
      dispose();
    }
  });
  it('parses the actual v1 system anchor, strips private fields and leaves Assignment independent', () => {
    const parsed = parseChannelMessage({
      ...anchor(),
      subagentDispatch: { ...dispatchFixture, prompt: 'PRIVATE', output: 'PRIVATE' },
    });
    expect(parsed?.subagentDispatch).toEqual(dispatchFixture);
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
    expect(
      parseChannelMessage({ ...anchor(), author: { kind: 'bot', slug: 'ada' } }),
    ).toBeUndefined();
    expect(parseChannelMessage({ ...anchor(), id: 'unrelated' })).toBeUndefined();
    const assignment = {
      id: 'assignment-reply',
      at: dispatchFixture.updatedAt,
      body: 'Assignment reply',
      author: { kind: 'human' },
      assignmentReply: { sessionId: 'assignment-session', sourceEventId: 'source-event' },
    };
    expect(parseChannelMessage(assignment)?.assignmentReply).toEqual(assignment.assignmentReply);
    expect(parseChannelMessage(assignment)?.subagentDispatch).toBeUndefined();
  });
  it('updates in place, drops stale revisions, prevents terminal rollback and stale history replacement', () => {
    const { store, sources, dispose, payload } = setup();
    try {
      const source = sources[0]!;
      source.emit('channel/subagent-dispatch', payload({ status: 'completed', revision: 3 }));
      source.emit('channel/subagent-dispatch', payload({ status: 'failed', revision: 2 }));
      source.emit('channel/subagent-dispatch', payload({ status: 'running', revision: 99 }));
      store.setConversation({ messages: [anchor()] });
      expect(store.getSnapshot().conversation.messages).toHaveLength(1);
      expect(store.getSnapshot().conversation.messages[0]?.subagentDispatch).toMatchObject({
        status: 'completed',
        revision: 3,
      });
      expect(store.getSnapshot().conversation.revision).toBe(1);
    } finally {
      dispose();
    }
  });
  it('retains a real baseline until its history anchor arrives, with no invented card', () => {
    const { store, sources, dispose } = setup([]);
    try {
      sources[0]!.emit('channel/subagent-dispatch-baseline', {
        channelId: CHANNEL.id,
        dispatches: [{ messageId, subagentDispatch: { ...dispatchFixture, revision: 4 } }],
      });
      expect(store.getSnapshot().conversation.messages).toHaveLength(0);
      store.setConversation({ messages: [anchor()] });
      expect(store.getSnapshot().conversation.messages[0]?.subagentDispatch?.revision).toBe(4);
    } finally {
      dispose();
    }
  });
  it('filters other channels and malformed bindings on updates and baselines', () => {
    const { store, sources, dispose, payload } = setup();
    try {
      const source = sources[0]!;
      source.emit(
        'channel/subagent-dispatch',
        payload({ status: 'completed', revision: 5 }, 'other-channel'),
      );
      source.emit('channel/subagent-dispatch', {
        ...payload({ revision: 5 }),
        messageId: 'unrelated',
      });
      const terminal = { ...dispatchFixture, revision: 5, status: 'completed' };
      source.emit('channel/subagent-dispatch-baseline', {
        channelId: 'other-channel',
        dispatches: [{ messageId, subagentDispatch: terminal }],
      });
      source.emit('channel/subagent-dispatch-baseline', {
        channelId: CHANNEL.id,
        dispatches: [{ messageId: 'unrelated', subagentDispatch: terminal }],
      });
      expect(store.getSnapshot().conversation.messages[0]?.subagentDispatch?.revision).toBe(1);
    } finally {
      dispose();
    }
  });
  it('does not carry projections across channel switches or resurrect purged content', () => {
    const { store, sources, dispose, payload } = setup();
    try {
      const oldSource = sources[0]!;
      store.setConversation({ messages: [{ ...anchor(), body: '', contentPurged: true }] });
      oldSource.emit('channel/subagent-dispatch', payload({ revision: 2 }));
      expect(store.getSnapshot().conversation.messages[0]?.contentPurged).toBe(true);
      const other = { ...CHANNEL, id: 'other-channel' };
      store.setConversation({ channel: other, messages: [anchor()], revision: 1 });
      oldSource.emit('channel/subagent-dispatch', payload({ status: 'completed', revision: 4 }));
      expect(store.getSnapshot().conversation.messages[0]?.subagentDispatch?.revision).toBe(1);
    } finally {
      dispose();
    }
  });
  it('forwards both new events through the actual shared SSE transport', () => {
    const { store, dispose: stopFake, payload } = setup();
    stopFake();
    const streams: EventTarget[] = [];
    class Stream extends EventTarget {
      readyState = 1;
      constructor() {
        super();
        streams.push(this);
      }
      close() {
        this.readyState = 2;
      }
    }
    vi.stubGlobal('EventSource', Stream);
    const dispose = mountChannelLive(store, {
      refreshChannelMessages: vi.fn(async () => undefined),
    });
    try {
      const stream = streams.at(-1)!;
      stream.dispatchEvent(
        new MessageEvent('channel/subagent-dispatch-baseline', {
          data: JSON.stringify({
            channelId: CHANNEL.id,
            dispatches: [{ messageId, subagentDispatch: { ...dispatchFixture, revision: 2 } }],
          }),
        }),
      );
      expect(store.getSnapshot().conversation.messages[0]?.subagentDispatch?.revision).toBe(2);
      stream.dispatchEvent(
        new MessageEvent('channel/subagent-dispatch', {
          data: JSON.stringify(payload({ revision: 3, status: 'completed' })),
        }),
      );
      expect(store.getSnapshot().conversation.messages[0]?.subagentDispatch?.status).toBe(
        'completed',
      );
    } finally {
      dispose();
      vi.unstubAllGlobals();
    }
  });
  it('handles journal notifications and reconnect baselines through the existing typed seam', () => {
    let handlers: Parameters<ChannelFollow>[1] | undefined;
    const uninstall = installChannelFollow((_channelId, value) => {
      handlers = value;
      return { stop() {}, async prepend() {} };
    });
    const { store, dispose, payload } = setup();
    try {
      handlers!.change({
        type: 'notification',
        notification: {
          kind: 'subagent-dispatch-baseline',
          channelId: CHANNEL.id,
          dispatches: [{ messageId, subagentDispatch: { ...dispatchFixture, revision: 2 } }],
        },
      });
      expect(store.getSnapshot().conversation.messages[0]?.subagentDispatch?.revision).toBe(2);
      handlers!.change({
        type: 'notification',
        notification: {
          kind: 'subagent-dispatch',
          ...payload({ status: 'completed', revision: 3 }),
        },
      });
      expect(store.getSnapshot().conversation.messages[0]?.subagentDispatch?.status).toBe(
        'completed',
      );
    } finally {
      dispose();
      uninstall();
    }
  });
});
