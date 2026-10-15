import type { ChannelMessage } from './store.js';

/** Host-set snapshot of settled model samples for this send, never a live estimate. */
export interface MessagePerf {
  sessionId: string;
  turn: number;
  /** Provider output tokens with matching decode timing (DSH's decodeTokens). */
  outputTokens: number;
  /** Sum of first-token → assistant/message durations, in milliseconds. */
  decodeMs: number;
  /** First measured sample's step/start → first token, in milliseconds. */
  ttftMs: number | null;
  /** Number of settled samples included, not the Session's step/end count. */
  steps: number;
}

export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

function isMessagePerf(value: unknown): value is MessagePerf {
  if (typeof value !== 'object' || value === null) return false;
  const perf = value as Record<string, unknown>;
  return (
    typeof perf['sessionId'] === 'string' &&
    perf['sessionId'].length > 0 &&
    typeof perf['turn'] === 'number' &&
    Number.isSafeInteger(perf['turn']) &&
    perf['turn'] >= 0 &&
    typeof perf['outputTokens'] === 'number' &&
    Number.isSafeInteger(perf['outputTokens']) &&
    perf['outputTokens'] >= 0 &&
    typeof perf['decodeMs'] === 'number' &&
    Number.isFinite(perf['decodeMs']) &&
    perf['decodeMs'] >= 0 &&
    (perf['ttftMs'] === null ||
      (typeof perf['ttftMs'] === 'number' &&
        Number.isFinite(perf['ttftMs']) &&
        perf['ttftMs'] >= 0)) &&
    typeof perf['steps'] === 'number' &&
    Number.isSafeInteger(perf['steps']) &&
    perf['steps'] > 0
  );
}

/** Invalid optional telemetry must not discard the message itself. */
export function parseMessagePerf(value: unknown): MessagePerf | undefined {
  if (!isMessagePerf(value)) return undefined;
  const { sessionId, turn, outputTokens, decodeMs, ttftMs, steps } = value;
  return { sessionId, turn, outputTokens, decodeMs, ttftMs, steps };
}

function settledPerf(message: ChannelMessage): MessagePerf | undefined {
  if (
    message.author.kind !== 'bot' ||
    message.streaming === true ||
    message.pending === true ||
    message.unconfirmed === true ||
    message.failed !== undefined ||
    message.sessionFailure !== undefined ||
    message.contentPurged === true
  )
    return undefined;
  return isMessagePerf(message.perf) ? message.perf : undefined;
}

export function messageTokensPerSecond(message: ChannelMessage): number | null {
  const perf = settledPerf(message);
  if (perf === undefined || perf.decodeMs <= 0 || perf.outputTokens <= 0) return null;
  const tps = perf.outputTokens / (perf.decodeMs / 1000);
  return Number.isFinite(tps) ? tps : null;
}

export function messageTtftMs(message: ChannelMessage): number | null {
  const perf = settledPerf(message);
  if (perf === undefined || perf.ttftMs === null) return null;
  return perf.ttftMs;
}

export function messagePerfSteps(message: ChannelMessage): number | null {
  const perf = settledPerf(message);
  if (perf === undefined || perf.steps <= 1) return null;
  return perf.steps;
}
