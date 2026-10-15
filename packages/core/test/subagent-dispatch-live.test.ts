import { describe, expect, it } from 'vitest';

import {
  CHANNEL_DRAFT_BASELINE_EVENT,
  CHANNEL_SUBAGENT_DISPATCH_BASELINE_EVENT,
  CHANNEL_SUBAGENT_DISPATCH_EVENT,
  createChannelLiveHub,
  type ChannelLiveHub,
} from '../src/channels/live.js';
import type { ChannelRecord } from '../src/channels/channel.js';
import type { ChannelStore } from '../src/channels/store.js';
import { createSubagentDispatchRegistry } from '../src/channels/subagent-dispatch.js';
import { openLiveFrames, parseLiveFrame } from '../src/channels/live-frames.js';

const AT = '2026-10-15T06:00:00.000Z';

function channel(id: string): ChannelRecord {
  return {
    id,
    type: 'dm',
    name: id,
    createdAt: AT,
    updatedAt: AT,
    members: ['human', 'alpha'],
    botSlug: 'alpha',
  };
}

/** The slice of ChannelStore the live hub reads; the real store is exercised elsewhere. */
function store(channelIds: readonly string[]): ChannelStore {
  const records = new Map(channelIds.map((id) => [id, channel(id)]));
  return {
    get: (id: string) => records.get(id),
    revision: () => 0,
    messagesAfter: () => [],
    readHumanJournalPage: () => ({ entries: [], olderCursor: null, hasOlder: false }),
    readPosition: () => undefined,
  } as unknown as ChannelStore;
}

function dispatches() {
  const registry = createSubagentDispatchRegistry();
  return {
    registry,
    queued: () =>
      registry.apply({
        channelId: 'dm-alpha',
        dispatchId: 'call-1',
        parentSessionId: 'session-alpha',
        status: 'queued',
        at: AT,
        description: 'Alpha task',
      }),
  };
}

function hubWith(
  registry: ReturnType<typeof createSubagentDispatchRegistry>,
  channelIds: readonly string[] = ['dm-alpha', 'dm-beta'],
): ChannelLiveHub {
  return createChannelLiveHub(store(channelIds), undefined, undefined, registry);
}

describe('subagent dispatch live stream', () => {
  it('replays the latest dispatch state on every (re)subscribe', async () => {
    const { registry, queued } = dispatches();
    const hub = hubWith(registry);
    queued();
    registry.apply({
      channelId: 'dm-alpha',
      dispatchId: 'call-1',
      parentSessionId: 'session-alpha',
      status: 'running',
      at: AT,
    });

    const controller = new AbortController();
    const frames = [];
    for await (const frame of openLiveFrames(
      (request) => hub.open(request),
      'channelId=dm-alpha&after=0',
      '',
      controller.signal,
    )) {
      frames.push(frame);
      if (frame.event === CHANNEL_SUBAGENT_DISPATCH_BASELINE_EVENT) break;
    }
    controller.abort();

    const baseline = frames.find((frame) => frame.event === CHANNEL_SUBAGENT_DISPATCH_BASELINE_EVENT);
    expect(baseline).toBeDefined();
    const payload = JSON.parse(baseline!.data) as {
      channelId: string;
      dispatches: { messageId: string; subagentDispatch: { status: string; revision: number } }[];
    };
    expect(payload.channelId).toBe('dm-alpha');
    expect(payload.dispatches).toHaveLength(1);
    expect(payload.dispatches[0]!.subagentDispatch).toMatchObject({
      status: 'running',
      revision: 2,
    });
  });

  it('publishes each applied transition on the Channel the dispatch belongs to', async () => {
    const { registry, queued } = dispatches();
    const hub = hubWith(registry);
    queued();

    const controller = new AbortController();
    const frames = [];
    let published = false;
    for await (const frame of openLiveFrames(
      (request) => hub.open(request),
      'channelId=dm-alpha&after=0',
      '',
      controller.signal,
    )) {
      frames.push(frame);
      if (!published && frame.event === CHANNEL_SUBAGENT_DISPATCH_BASELINE_EVENT) {
        published = true;
        const record = registry.apply({
          channelId: 'dm-alpha',
          dispatchId: 'call-1',
          parentSessionId: 'session-alpha',
          status: 'completed',
          at: AT,
        });
        hub.publishSubagentDispatch(record!);
        continue;
      }
      if (frame.event === CHANNEL_SUBAGENT_DISPATCH_EVENT) break;
    }
    controller.abort();

    const update = frames.find((frame) => frame.event === CHANNEL_SUBAGENT_DISPATCH_EVENT);
    expect(update).toBeDefined();
    expect(JSON.parse(update!.data)).toMatchObject({
      channelId: 'dm-alpha',
      messageId: 'subagent-dispatch-call-1-b93e8f47',
      subagentDispatch: { status: 'completed', revision: 2 },
    });
    expect(parseLiveFrame(`event: ${CHANNEL_SUBAGENT_DISPATCH_EVENT}\ndata: ${update!.data}`)).toEqual(
      update,
    );
  });

  it('never leaks one Channel dispatch state into another Channel stream', async () => {
    const { registry, queued } = dispatches();
    const hub = hubWith(registry);
    queued();
    const record = registry.forChannel('dm-alpha')[0]!;
    const controller = new AbortController();
    const frames = openLiveFrames(
      (request) => hub.open(request),
      'channelId=dm-beta&after=0',
      '',
      controller.signal,
    )[Symbol.asyncIterator]();
    const timeout = () =>
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 150));

    expect((await frames.next()).value).toMatchObject({ event: 'open' });
    // The drafts baseline is always delivered; no dispatch frame precedes it.
    const baseline = await frames.next();
    expect(baseline.value).toMatchObject({ event: CHANNEL_DRAFT_BASELINE_EVENT });
    expect(await Promise.race([frames.next(), timeout()])).toBe('timeout');

    // A publish addressed at the other Channel reaches no dm-beta subscriber.
    hub.publishSubagentDispatch(record);
    expect(await Promise.race([frames.next(), timeout()])).toBe('timeout');

    controller.abort();
    expect(registry.forChannel('dm-beta')).toHaveLength(0);
    expect(registry.forChannel('dm-alpha')).toHaveLength(1);
  });

  it('ignores a dispatch whose Channel no longer exists', () => {
    const { registry, queued } = dispatches();
    const hub = hubWith(registry, ['dm-beta']);
    queued();
    const record = registry.forChannel('dm-alpha')[0]!;
    expect(() => hub.publishSubagentDispatch(record)).not.toThrow();
  });
});
