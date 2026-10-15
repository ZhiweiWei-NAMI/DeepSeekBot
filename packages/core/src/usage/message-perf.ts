import { assistantStreamFirstTokenTime, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm';

import type { ChannelMessagePerf } from '../channels/channel.js';
import type { DshSessionEvent } from '../sessions/source.js';

/**
 * Per-message generation performance for a Bot reply, folded from one live
 * Session's `session/event` stream.
 *
 * The fold mirrors `@deepseek-ai/dsh-session-stats` (`sessionStats`) field for
 * field, so a message's tokens/second agrees with the official StatsPills:
 *
 * - `step/start` opens a step and records its start time.
 * - `assistant/attempt` records the step's first token (the first `text-delta`,
 *   `reasoning-delta` or `tool-call-delta` of the attempt stream, surviving an
 *   in-step `llm/retry`).
 * - `assistant/message` closes the step's accounting: `llm` time is the whole
 *   step, while `decodeMs`/`outputTokens` count only when the settlement carries
 *   both a resolvable first token and a provider-reported `usage.outputTokens`.
 * - The numbers are descriptive only: `forSession` returns a snapshot of the
 *   turn so far, so a `channel_send` executed inside step N never sees step N+1
 *   or another turn.
 *
 * Nothing is inferred. A settlement without usage, without a first token, or a
 * turn whose first step was never observed yields no snapshot rather than an
 * estimated one, and the provider's `outputTokens` is used exactly as reported.
 */
export interface MessagePerfTracker {
  /** Fold one live Session event; safe to call for every `session/event`. */
  handleSessionEvent(sessionId: string, event: DshSessionEvent): void;

  /**
   * The current turn's snapshot for one Session, or undefined when no snapshot
   * is measurable: no step is open right now, the turn's first step was not
   * observed, an event gap made the fold unreliable, or no settlement carried
   * both usage and a first token with a positive decode span and token count.
   */
  forSession(sessionId: string): ChannelMessagePerf | undefined;

  /** Drop one Session's fold, or every fold when no Session id is given. */
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
  /** The lowest step number observed for this turn; a turn starts at step 0. */
  firstStep: number | undefined;
  /** Steps whose `assistant/message` settlement was already applied. */
  settled: Set<number>;
  /** False once an event gap made this turn's totals unreliable. */
  contiguous: boolean;
  outputTokens: number;
  decodeMs: number;
  /** TTFT of the turn's first step, or null while that step has no token. */
  ttftMs: number | null;
  /** Settlements counted into outputTokens and decodeMs. */
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

/**
 * Whether one value is a compact stream record the DSH stream readers accept.
 * Records are read from durable Session JSON, so a record of an unknown shape
 * must yield "no first token" instead of a reader that walks absent members.
 */
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
      // The first observed event seeds the baseline: a Session resumed while the
      // plugin is unloaded still folds its next turn. A later gap means events
      // were missed, so this turn's totals stop being a measurement.
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

/** Create one fold tracker; the Host owns its lifetime and feeds it every Session event. */
export function createMessagePerfTracker(): MessagePerfTracker {
  return new FoldTracker();
}
