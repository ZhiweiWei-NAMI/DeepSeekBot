import type { ChannelMessage } from '../../src/client/store.js';
import type { MessagePerf } from '../../src/client/message-perf.js';

// Synthetic provider measurements only; no real session, prompt, or credential data.
export const measuredPerf: MessagePerf = {
  sessionId: 'fixture-session',
  turn: 2,
  outputTokens: 120,
  decodeMs: 2400,
  ttftMs: 350,
  steps: 2,
};

export function measuredMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'fixture-message',
    at: '2026-10-15T00:00:00.000Z',
    author: { kind: 'bot', slug: 'fixture-bot' },
    format: 'text',
    body: 'The result is ready.',
    perf: { ...measuredPerf },
    ...overrides,
  };
}
