/**
 * Subagent dispatch visibility: the bounded projection of one delegated
 * `bot_subagent` / `bot_subagent_fork` call, rendered on a Channel as a live
 * card.
 *
 * A dispatch is identified by the Host tool-call id, which the Host assigns
 * before the tool body runs and therefore before any route is resolved — so a
 * refused delegation has an identity without ever having a run. The projection
 * only ever records facts the Host published: an accepted child session or
 * registered background Job (`queued`), the child's first executing turn
 * (`running`), and the child's or Job's terminal outcome
 * (`completed` / `failed` / `declined`). When no reliable terminal fact
 * arrives the projection stays where it was; it is never advanced to
 * `completed` on a guess.
 *
 * This module is deliberately dependency-free and side-effect-free: it owns the
 * vocabulary, the sanitizer, and the revision/ordering rules, so the same
 * reducer is exercised by unit tests and by the runtime wiring that feeds it.
 */

export const SUBAGENT_DISPATCH_KIND = 'subagent';

/** Longest delegation description retained in a projection, in characters. */
export const SUBAGENT_DISPATCH_DESCRIPTION_MAX_CHARS = 120;

/** Longest dispatch identity accepted from the Host, in characters. */
export const SUBAGENT_DISPATCH_ID_MAX_CHARS = 200;

/** Live dispatch records retained per Channel, oldest terminal records evicted first. */
export const SUBAGENT_DISPATCH_MAX_PER_CHANNEL = 64;

export type SubagentDispatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'declined';

/**
 * Why a dispatch is not `completed`. Codes are a closed, Host-independent
 * vocabulary: raw Host error text, stack, reason, and output never reach a
 * projection.
 */
export type SubagentDispatchReasonCode =
  /** The delegation never started: the tool call failed or was refused. */
  | 'refused'
  /** The delegation never started: cancellation won before any child existed. */
  | 'aborted'
  /** The child or Job was cancelled after starting. */
  | 'killed'
  /** The child hit its token ceiling. */
  | 'max-tokens'
  /** The child's model declined the task. */
  | 'refusal'
  /** Route selection refused the requested/child model. */
  | 'route-not-allowed'
  /** The provider credential is missing or invalid. */
  | 'credential'
  /** The provider adapter is unavailable for the resolved route. */
  | 'provider-unavailable'
  /** No Model Preset is applied, so an explicit model choice is refused. */
  | 'no-plan'
  /** The turn or Job ended without a recognized terminal kind. */
  | 'unfinished'
  /** Model or transport failure. */
  | 'error';

export interface SubagentDispatchRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** One dispatch's latest observable state. */
export interface SubagentDispatchProjection {
  /** Host tool-call id of the delegating call, assigned before routing. */
  dispatchId: string;
  kind: typeof SUBAGENT_DISPATCH_KIND;
  /** Bounded, control-character-free summary of the delegation `description`. */
  description: string;
  status: SubagentDispatchStatus;
  /** Monotonic per dispatch; a consumer drops any update at or below it. */
  revision: number;
  updatedAt: string;
  /** The PersonaBot session that delegated. */
  parentSessionId: string;
  /** Present only after a real start published the child's durable route. */
  resolvedRoute?: SubagentDispatchRoute;
  reasonCode?: SubagentDispatchReasonCode;
}

/** One live projection and the Channel message that carries it. */
export interface SubagentDispatchRecord {
  channelId: string;
  messageId: string;
  projection: SubagentDispatchProjection;
}

/** One observed transition to apply. */
export interface SubagentDispatchTransition {
  channelId: string;
  dispatchId: string;
  parentSessionId: string;
  status: SubagentDispatchStatus;
  at: string;
  description?: string;
  resolvedRoute?: SubagentDispatchRoute;
  reasonCode?: SubagentDispatchReasonCode;
}

export interface SubagentDispatchRegistry {
  /**
   * Apply one transition.
   * @returns the published record, or `undefined` when the transition was
   *   stale (an older status), a duplicate, or arrived after a terminal state.
   */
  apply(transition: SubagentDispatchTransition): SubagentDispatchRecord | undefined;
  get(channelId: string, dispatchId: string): SubagentDispatchProjection | undefined;
  /** Live records for one Channel, oldest first. */
  forChannel(channelId: string): readonly SubagentDispatchRecord[];
  forget(channelId: string, dispatchId: string): boolean;
  forgetChannel(channelId: string): void;
  size(): number;
  clear(): void;
}

const STATUS_RANK: Record<SubagentDispatchStatus, number> = {
  queued: 0,
  running: 1,
  completed: 2,
  failed: 2,
  declined: 2,
};

const REASON_CODES: readonly SubagentDispatchReasonCode[] = [
  'refused',
  'aborted',
  'killed',
  'max-tokens',
  'refusal',
  'route-not-allowed',
  'credential',
  'provider-unavailable',
  'no-plan',
  'unfinished',
  'error',
];

/** Terminal statuses are final: no later transition may reopen them. */
export function isTerminalSubagentDispatchStatus(status: SubagentDispatchStatus): boolean {
  return STATUS_RANK[status] === 2;
}

/** Relative progress of a status; a lower rank never overwrites a higher one. */
export function subagentDispatchStatusRank(status: SubagentDispatchStatus): number {
  return STATUS_RANK[status];
}

export function isSubagentDispatchStatus(value: unknown): value is SubagentDispatchStatus {
  return typeof value === 'string' && Object.hasOwn(STATUS_RANK, value);
}

export function isSubagentDispatchReasonCode(
  value: unknown,
): value is SubagentDispatchReasonCode {
  return typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value);
}

/** One unsafe code point: control, format, or line/paragraph separator. */
const UNSAFE_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** The same class for removal; global, so every occurrence is stripped. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function safeText(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(UNSAFE_CHARS, '').trim();
}

function isSafeToken(value: string): boolean {
  return value.length > 0 && value.length <= 80 && /^[A-Za-z0-9_.:/-]+$/u.test(value);
}

/**
 * Reduce a model-authored delegation `description` to a bounded summary.
 *
 * Whitespace collapses, control/format/separator characters are removed, and
 * the result is truncated. The raw arguments, prompt, child output, and stack
 * are never part of a projection, so this is the only free text a dispatch card
 * can carry.
 */
export function sanitizeSubagentDispatchDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = safeText(value);
  if (normalized.length === 0) return undefined;
  const characters = Array.from(normalized);
  return characters.length > SUBAGENT_DISPATCH_DESCRIPTION_MAX_CHARS
    ? characters.slice(0, SUBAGENT_DISPATCH_DESCRIPTION_MAX_CHARS).join('')
    : normalized;
}

/** Validate one identity (dispatch, channel, session) for retention. */
export function isSubagentDispatchIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SUBAGENT_DISPATCH_ID_MAX_CHARS &&
    !UNSAFE_CHAR.test(value)
  );
}

/**
 * Accept a resolved route only when every field is a bounded token, so a Host
 * value cannot smuggle free text into the projection.
 */
export function sanitizeSubagentDispatchRoute(value: unknown): SubagentDispatchRoute | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const route = value as Record<string, unknown>;
  const provider = route['provider'];
  const model = route['model'];
  if (typeof provider !== 'string' || !isSafeToken(provider)) return undefined;
  if (typeof model !== 'string' || !isSafeToken(model)) return undefined;
  const reasoningEffort = route['reasoningEffort'];
  if (reasoningEffort !== undefined) {
    if (typeof reasoningEffort !== 'string' || !isSafeToken(reasoningEffort)) return undefined;
  }
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

function routeEquals(
  left: SubagentDispatchRoute | undefined,
  right: SubagentDispatchRoute | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
  );
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The Channel message id that carries one dispatch card.
 *
 * The id is derived from the dispatch identity so history, live updates, and a
 * reconnect all address the same message without a second binding handshake.
 */
export function subagentDispatchMessageId(dispatchId: string): string {
  const safe = isSubagentDispatchIdentity(dispatchId) ? dispatchId : String(dispatchId);
  const token = safe.replace(/[^A-Za-z0-9_-]+/gu, '-').slice(0, 64);
  const suffix = fnv1a(safe);
  return `subagent-dispatch-${token.length === 0 ? 'x' : token}-${suffix}`;
}

/**
 * Validate one stored projection (journal read path). A `declined` projection
 * never carries `resolvedRoute`: a delegation that never started has no route.
 */
export function isSubagentDispatchProjection(value: unknown): value is SubagentDispatchProjection {
  if (typeof value !== 'object' || value === null) return false;
  const projection = value as Record<string, unknown>;
  if (projection['kind'] !== SUBAGENT_DISPATCH_KIND) return false;
  if (!isSubagentDispatchIdentity(projection['dispatchId'])) return false;
  if (!isSubagentDispatchIdentity(projection['parentSessionId'])) return false;
  if (!isSubagentDispatchStatus(projection['status'])) return false;
  const description = projection['description'];
  if (typeof description !== 'string') return false;
  if (description.length > SUBAGENT_DISPATCH_DESCRIPTION_MAX_CHARS) return false;
  if (UNSAFE_CHAR.test(description)) return false;
  if (!Number.isSafeInteger(projection['revision']) || (projection['revision'] as number) < 1)
    return false;
  const updatedAt = projection['updatedAt'];
  if (typeof updatedAt !== 'string' || updatedAt.length === 0) return false;
  const route = projection['resolvedRoute'];
  if (projection['status'] === 'declined') {
    if (route !== undefined) return false;
  } else if (route !== undefined && sanitizeSubagentDispatchRoute(route) === undefined) return false;
  const reasonCode = projection['reasonCode'];
  if (reasonCode !== undefined && !isSubagentDispatchReasonCode(reasonCode)) return false;
  return true;
}

/**
 * Map the Host's child stop-reason vocabulary onto the projection vocabulary.
 *
 * Accepts both Host shapes: a child `turn/end` reason (`{ kind, ... }`) and the
 * `subagent/end` lifecycle payload's bare `stopReason` string.
 */
export function mapSubagentStopReason(reason: unknown): {
  status: SubagentDispatchStatus;
  reasonCode?: SubagentDispatchReasonCode;
} {
  const kind =
    typeof reason === 'string'
      ? reason
      : typeof reason === 'object' && reason !== null && 'kind' in reason
        ? (reason as { kind?: unknown }).kind
        : undefined;
  if (kind === 'completed') return { status: 'completed' };
  if (kind === 'aborted') return { status: 'failed', reasonCode: 'aborted' };
  if (kind === 'error') return { status: 'failed', reasonCode: 'error' };
  if (kind === 'max-tokens') return { status: 'failed', reasonCode: 'max-tokens' };
  if (kind === 'refusal') return { status: 'failed', reasonCode: 'refusal' };
  return { status: 'failed', reasonCode: 'unfinished' };
}

/** Map a Host route/transport failure code onto a bounded reason code. */
export function mapSubagentFailureCode(code: unknown): SubagentDispatchReasonCode {  switch (code) {
    case 'MISSING_CREDENTIAL':
    case 'INVALID_CREDENTIAL':
      return 'credential';
    case 'NO_ADAPTER':
      return 'provider-unavailable';
    case 'MODEL_NOT_FOUND':
    case 'UNSUPPORTED_REASONING_EFFORT':
      return 'route-not-allowed';
    default:
      return 'error';
  }
}

/**
 * Map one child Session `turn/end` reason (`{ kind }`, with a structured
 * `error.code` when the turn failed) onto the projection vocabulary. Only the
 * mapped code survives; the Host's error message and stack never do.
 */
export function mapSubagentTurnEndReason(reason: unknown): {
  status: SubagentDispatchStatus;
  reasonCode?: SubagentDispatchReasonCode;
} {
  const mapped = mapSubagentStopReason(reason);
  if (mapped.reasonCode !== 'error') return mapped;
  const record =
    typeof reason === 'object' && reason !== null
      ? (reason as Record<string, unknown>)
      : undefined;
  const raw = record?.['error'];
  const error =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
  return { status: 'failed', reasonCode: mapSubagentFailureCode(error?.['code']) };
}

/** Map a background Job's terminal status onto the projection vocabulary. */
export function mapSubagentJobStatus(status: unknown): {
  status: SubagentDispatchStatus;
  reasonCode?: SubagentDispatchReasonCode;
} {
  if (status === 'completed') return { status: 'completed' };
  if (status === 'killed') return { status: 'failed', reasonCode: 'killed' };
  if (status === 'failed') return { status: 'failed', reasonCode: 'error' };
  return { status: 'failed', reasonCode: 'unfinished' };
}

export function createSubagentDispatchRegistry(): SubagentDispatchRegistry {
  const channels = new Map<string, Map<string, SubagentDispatchRecord>>();

  const forgetRecord = (channelId: string, dispatchId: string): boolean => {
    const group = channels.get(channelId);
    if (group === undefined) return false;
    const removed = group.delete(dispatchId);
    if (group.size === 0) channels.delete(channelId);
    return removed;
  };

  return {
    apply(transition) {
      const { channelId, dispatchId, parentSessionId, status, at } = transition;
      if (
        !isSubagentDispatchIdentity(channelId) ||
        !isSubagentDispatchIdentity(dispatchId) ||
        !isSubagentDispatchIdentity(parentSessionId)
      )
        return undefined;
      if (!isSubagentDispatchStatus(status)) return undefined;
      if (
        transition.reasonCode !== undefined &&
        !isSubagentDispatchReasonCode(transition.reasonCode)
      )
        return undefined;
      const description = sanitizeSubagentDispatchDescription(transition.description);
      const route =
        status === 'declined' ? undefined : sanitizeSubagentDispatchRoute(transition.resolvedRoute);
      const updatedAt =
        typeof at === 'string' && at.length > 0 ? at : new Date(0).toISOString();

      let group = channels.get(channelId);
      if (group === undefined) {
        group = new Map();
        channels.set(channelId, group);
      }
      const existing = group.get(dispatchId);
      if (existing !== undefined) {
        const previous = existing.projection;
        if (isTerminalSubagentDispatchStatus(previous.status)) return undefined;
        if (subagentDispatchStatusRank(status) < subagentDispatchStatusRank(previous.status))
          return undefined;
        const nextRoute = route ?? previous.resolvedRoute;
        const nextDescription = previous.description.length > 0 ? previous.description : description;
        if (
          status === previous.status &&
          routeEquals(route, previous.resolvedRoute) &&
          transition.reasonCode === previous.reasonCode &&
          nextDescription === previous.description
        )
          return undefined;
        const projection: SubagentDispatchProjection = {
          ...previous,
          status,
          description: nextDescription ?? previous.description,
          revision: previous.revision + 1,
          updatedAt,
          ...(nextRoute === undefined ? {} : { resolvedRoute: nextRoute }),
          ...(transition.reasonCode === undefined ? {} : { reasonCode: transition.reasonCode }),
        };
        if (nextRoute === undefined || status === 'declined') delete projection.resolvedRoute;
        if (status !== 'failed' && status !== 'declined') delete projection.reasonCode;
        const record = { ...existing, projection };
        group.set(dispatchId, record);
        return record;
      }

      const projection: SubagentDispatchProjection = {
        dispatchId,
        kind: SUBAGENT_DISPATCH_KIND,
        description: description ?? '',
        status,
        revision: 1,
        updatedAt,
        parentSessionId,
        ...(route === undefined ? {} : { resolvedRoute: route }),
        ...(transition.reasonCode === undefined || status === 'queued' || status === 'running'
          ? {}
          : { reasonCode: transition.reasonCode }),
      };
      const record: SubagentDispatchRecord = {
        channelId,
        messageId: subagentDispatchMessageId(dispatchId),
        projection,
      };
      group.set(dispatchId, record);
      if (group.size > SUBAGENT_DISPATCH_MAX_PER_CHANNEL) {
        for (const candidateId of group.keys()) {
          if (candidateId === dispatchId) continue;
          const candidate = group.get(candidateId);
          if (candidate === undefined) continue;
          if (isTerminalSubagentDispatchStatus(candidate.projection.status)) {
            group.delete(candidateId);
            break;
          }
        }
        if (group.size > SUBAGENT_DISPATCH_MAX_PER_CHANNEL) {
          for (const candidateId of group.keys()) {
            if (candidateId === dispatchId) continue;
            group.delete(candidateId);
            break;
          }
        }
      }
      return record;
    },
    get(channelId, dispatchId) {
      return channels.get(channelId)?.get(dispatchId)?.projection;
    },
    forChannel(channelId) {
      return [...(channels.get(channelId)?.values() ?? [])];
    },
    forget: forgetRecord,
    forgetChannel(channelId) {
      channels.delete(channelId);
    },
    size() {
      let total = 0;
      for (const group of channels.values()) total += group.size;
      return total;
    },
    clear() {
      channels.clear();
    },
  };
}
