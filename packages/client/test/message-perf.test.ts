import { describe, expect, it } from 'vitest';

import type { ChannelMessage } from '../src/client/store.js';
import {
  formatTokensPerSecond,
  messagePerfSteps,
  messageTokensPerSecond,
  messageTtftMs,
  parseMessagePerf,
  type MessagePerf,
} from '../src/client/message-perf.js';

function botMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    id: 'm1',
    at: '2026-10-15T00:00:00.000Z',
    author: { kind: 'bot', slug: 'atlas' },
    body: 'done',
    ...overrides,
  };
}

function perf(overrides?: Partial<MessagePerf>): MessagePerf {
  return {
    sessionId: 's1',
    turn: 3,
    outputTokens: 250,
    decodeMs: 1000,
    ttftMs: 420,
    steps: 1,
    ...overrides,
  };
}

describe('formatTokensPerSecond', () => {
  it('rounds to whole tokens from ten up', () => {
    expect(formatTokensPerSecond(123.4)).toBe('123');
  });

  it('keeps one decimal below ten', () => {
    expect(formatTokensPerSecond(7.34)).toBe('7.3');
  });

  it('clamps negatives to zero', () => {
    expect(formatTokensPerSecond(-5)).toBe('0');
  });
});

describe('messageTokensPerSecond', () => {
  it('divides provider output tokens by decode wall time', () => {
    expect(messageTokensPerSecond(botMessage({ perf: perf() }))).toBe(250);
  });

  it('converts milliseconds to seconds for non-unit and fractional durations', () => {
    expect(
      messageTokensPerSecond(botMessage({ perf: perf({ outputTokens: 120, decodeMs: 2400 }) })),
    ).toBe(50);
    expect(
      messageTokensPerSecond(botMessage({ perf: perf({ outputTokens: 10, decodeMs: 125.5 }) })),
    ).toBeCloseTo(79.6813);
  });

  it.each([
    { pending: true },
    { unconfirmed: true },
    { failed: 'not delivered' },
    { contentPurged: true },
    { sessionFailure: { role: 'orchestrator', sessionId: 's1', detail: 'interrupted' } },
  ] satisfies Partial<ChannelMessage>[])('hides unsettled or unavailable messages: %j', (state) => {
    const message = botMessage({ perf: perf({ steps: 2 }), ...state });
    expect(messageTokensPerSecond(message)).toBeNull();
    expect(messageTtftMs(message)).toBeNull();
    expect(messagePerfSteps(message)).toBeNull();
  });

  it('never uses body length, message timestamp, or TTFT for the rate', () => {
    const message = botMessage({
      body: 'x'.repeat(10000),
      at: 'invalid',
      perf: perf({ ttftMs: 90000 }),
    });
    expect(messageTokensPerSecond(message)).toBe(250);
    expect(messageTokensPerSecond(botMessage({ body: message.body }))).toBeNull();
  });

  it('rejects an overflowing derived rate', () => {
    expect(
      messageTokensPerSecond(botMessage({ perf: perf({ decodeMs: Number.MIN_VALUE }) })),
    ).toBeNull();
  });

  it('returns null without perf', () => {
    expect(messageTokensPerSecond(botMessage())).toBeNull();
  });

  it('returns null while streaming', () => {
    expect(messageTokensPerSecond(botMessage({ streaming: true, perf: perf() }))).toBeNull();
  });

  it('returns null for human messages even with perf', () => {
    expect(
      messageTokensPerSecond(botMessage({ author: { kind: 'human' }, perf: perf() })),
    ).toBeNull();
  });

  it('returns null on zero denominator or zero tokens', () => {
    expect(messageTokensPerSecond(botMessage({ perf: perf({ decodeMs: 0 }) }))).toBeNull();
    expect(messageTokensPerSecond(botMessage({ perf: perf({ outputTokens: 0 }) }))).toBeNull();
  });

  it('returns null on malformed perf instead of estimating', () => {
    expect(
      messageTokensPerSecond(
        botMessage({ perf: { sessionId: 's1', turn: 0, outputTokens: 12, decodeMs: 3 } as never }),
      ),
    ).toBeNull();
  });
});

describe('parseMessagePerf', () => {
  it.each([
    null,
    [],
    'unknown',
    perf({ sessionId: '' }),
    perf({ turn: -1 }),
    perf({ turn: 0.5 }),
    perf({ outputTokens: -1 }),
    perf({ outputTokens: 1.5 }),
    perf({ outputTokens: Number.MAX_SAFE_INTEGER + 1 }),
    perf({ decodeMs: -1 }),
    perf({ decodeMs: Number.NaN }),
    perf({ decodeMs: Infinity }),
    perf({ ttftMs: -1 }),
    perf({ ttftMs: Infinity }),
    perf({ steps: 0 }),
    perf({ steps: 1.5 }),
  ])('drops malformed optional telemetry: %j', (value) => {
    expect(parseMessagePerf(value)).toBeUndefined();
  });

  it('copies only contract fields and accepts fractional milliseconds', () => {
    const value = { ...perf({ decodeMs: 125.5, ttftMs: 20.25 }), privateField: 'not forwarded' };
    expect(parseMessagePerf(value)).toEqual(perf({ decodeMs: 125.5, ttftMs: 20.25 }));
    expect(parseMessagePerf(value)).not.toBe(value);
  });
});

describe('messageTtftMs', () => {
  it('reads the recorded TTFT', () => {
    expect(messageTtftMs(botMessage({ perf: perf() }))).toBe(420);
  });

  it('returns null when no first token was recorded', () => {
    expect(messageTtftMs(botMessage({ perf: perf({ ttftMs: null }) }))).toBeNull();
  });

  it('returns null while streaming', () => {
    expect(messageTtftMs(botMessage({ streaming: true, perf: perf() }))).toBeNull();
  });
});

describe('messagePerfSteps', () => {
  it('exposes the step count only for multi-step turns', () => {
    expect(messagePerfSteps(botMessage({ perf: perf({ steps: 3 }) }))).toBe(3);
    expect(messagePerfSteps(botMessage({ perf: perf({ steps: 1 }) }))).toBeNull();
  });
});
