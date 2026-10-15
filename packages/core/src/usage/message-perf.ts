import { assistantStreamFirstTokenTime, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm';

import type { ChannelMessagePerf } from '../channels/channel.js';
import type { DshSessionEvent } from '../sessions/source.js';

export interface MessagePerfTracker {
  handleSessionEvent(sessionId: string, event: DshSessionEvent): void;

  forSession(sessionId: string): ChannelMessagePerf | undefined;

  clear(sessionId?: string): void;
}

interface OpenStep {
  turn: number;
  step: number;
  startTime: number;
  firstTokenTime: number | null;
}

interface TurnFold {
  turn: number;
  openStep: OpenStep | null;

  firstStep: number | undefined;

  settled: Set<number>;

  contiguous: boolean;
  outputTokens: number;
  decodeMs: number;

  ttftMs: number | null;

  steps: number;
}

interface SessionFold {
  lastSeq: number | undefined;
  turn: TurnFold | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function asFiniteTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isStreamRecord(value: unknown): boolean {
  const record = asRecord(value);
  if (record === undefined) return false;
  const time0 = record['time0'];
  const dt = record['dt'];
  switch (record['type']) {
    case 'chunk': {
      const chunk = asRecord(record['chunk']);
      if (chunk === undefined || !Number.isFinite(record['time'])) return false;
      switch (chunk['type']) {
        case 'text-delta':
        case 'reasoning-delta':
          return typeof chunk['text'] === 'string';
        case 'tool-call-delta':
          return (
            typeof chunk['argumentsDelta'] === 'string' &&
            (chunk['name'] === undefined || typeof chunk['name'] === 'string')
          );
        default:
          return true;
      }
    }
    case 'text-chunks':
    case 'reasoning-chunks': {
      const texts = record['texts'];
      return (
        Number.isFinite(time0) &&
        Array.isArray(dt) &&
        dt.every((step) => Number.isFinite(step)) &&
        Array.isArray(texts) &&
        texts.every((text) => typeof text === 'string')
      );
    }
    case 'tool-call-chunks': {
      const args = record['args'];
      return (
        Number.isFinite(time0) &&
        Array.isArray(dt) &&
        dt.every((step) => Number.isFinite(step)) &&
        Array.isArray(args) &&
        args.every((text) => typeof text === 'string')
      );
    }
    default:
      return false;
  }
}

function firstTokenTime(stream: unknown): number | null {
  if (!Array.isArray(stream) || !stream.every(isStreamRecord)) return null;
  const time = assistantStreamFirstTokenTime(stream as readonly AssistantStreamRecord[]);
  return typeof time === 'number' && Number.isFinite(time) ? time : null;
}

function usageOutputTokens(usage: unknown): number | null {
  const record = asRecord(usage);
  return record === undefined ? null : (asNonNegativeInt(record['outputTokens']) ?? null);
}

function emptyTurn(turn: number): TurnFold {
  return {
    turn,
    openStep: null,
    firstStep: undefined,
    settled: new Set<number>(),
    contiguous: true,
    outputTokens: 0,
    decodeMs: 0,
    ttftMs: null,
    steps: 0,
  };
}

class FoldTracker implements MessagePerfTracker {
  readonly #sessions = new Map<string, SessionFold>();

  handleSessionEvent(sessionId: string, event: DshSessionEvent): void {
    const state = this.#session(sessionId);
    const seq = asNonNegativeInt(event.seq);
    if (seq !== undefined) {
      if (state.lastSeq !== undefined) {
        if (seq <= state.lastSeq) return;
        if (seq > state.lastSeq + 1 && state.turn !== undefined) state.turn.contiguous = false;
      }
      state.lastSeq = seq;
    }
    const data = asRecord(event.data);
    if (data === undefined) return;
    const turn = asNonNegativeInt(data['turn']);
    const step = asNonNegativeInt(data['step']);
    switch (event.type) {
      case 'step/start': {
        const startTime = asFiniteTime(event.time);
        if (turn === undefined || step === undefined || startTime === undefined) return;
        this.#openStep(state, turn, step, startTime);
        return;
      }
      case 'assistant/attempt': {
        if (turn === undefined || step === undefined) return;
        const fold = state.turn;
        if (fold === undefined || fold.turn !== turn) return;
        const open = fold.openStep;
        if (open === null || open.step !== step || open.firstTokenTime !== null) return;
        const first = firstTokenTime(data['stream']);
        if (first === null) return;
        open.firstTokenTime = first;
        this.#recordTtft(fold, open);
        return;
      }
      case 'assistant/message': {
        const settledAt = asFiniteTime(event.time);
        if (turn === undefined || step === undefined || settledAt === undefined) return;
        const fold = state.turn;
        if (fold === undefined || fold.turn !== turn) return;
        const open = fold.openStep;
        if (open === null || open.step !== step || fold.settled.has(step)) return;
        fold.settled.add(step);
        const first = open.firstTokenTime ?? firstTokenTime(data['stream']);
        if (first === null) return;
        open.firstTokenTime = first;
        this.#recordTtft(fold, open);
        const outputTokens = usageOutputTokens(data['usage']);
        if (outputTokens === null) return;
        fold.outputTokens += outputTokens;
        fold.decodeMs += Math.max(0, settledAt - first);
        fold.steps += 1;
        return;
      }
      case 'step/end': {
        if (turn === undefined || step === undefined) return;
        const fold = state.turn;
        if (fold === undefined) return;
        const open = fold.openStep;
        if (open !== null && open.turn === turn && open.step === step) fold.openStep = null;
        return;
      }
      case 'turn/end': {
        if (turn === undefined || state.turn?.turn !== turn) return;
        state.turn = undefined;
        return;
      }
      default:
        return;
    }
  }

  forSession(sessionId: string): ChannelMessagePerf | undefined {
    const fold = this.#sessions.get(sessionId)?.turn;
    if (fold === undefined) return undefined;
    if (fold.openStep === null) return undefined;
    if (fold.firstStep !== 0 || !fold.contiguous) return undefined;
    if (fold.steps === 0 || fold.outputTokens <= 0 || fold.decodeMs <= 0) return undefined;
    return {
      sessionId,
      turn: fold.turn,
      outputTokens: fold.outputTokens,
      decodeMs: fold.decodeMs,
      ttftMs: fold.ttftMs,
      steps: fold.steps,
    };
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) this.#sessions.clear();
    else this.#sessions.delete(sessionId);
  }

  #session(sessionId: string): SessionFold {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionFold = { lastSeq: undefined, turn: undefined };
    this.#sessions.set(sessionId, created);
    return created;
  }

  #openStep(state: SessionFold, turn: number, step: number, startTime: number): void {
    if (state.turn === undefined || state.turn.turn !== turn) state.turn = emptyTurn(turn);
    const fold = state.turn;
    if (fold.firstStep === undefined || step < fold.firstStep) fold.firstStep = step;
    fold.openStep = { turn, step, startTime, firstTokenTime: null };
  }

  #recordTtft(fold: TurnFold, open: OpenStep): void {
    if (open.step !== fold.firstStep || fold.ttftMs !== null) return;
    const first = open.firstTokenTime;
    if (first === null) return;
    fold.ttftMs = Math.max(0, first - open.startTime);
  }
}

export function createMessagePerfTracker(): MessagePerfTracker {
  return new FoldTracker();
}
