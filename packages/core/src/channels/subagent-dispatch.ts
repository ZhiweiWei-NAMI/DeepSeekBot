export const SUBAGENT_DISPATCH_KIND = 'subagent';

export const SUBAGENT_DISPATCH_DESCRIPTION_MAX_CHARS = 120;

export const SUBAGENT_DISPATCH_ID_MAX_CHARS = 200;

export const SUBAGENT_DISPATCH_MAX_PER_CHANNEL = 64;

export type SubagentDispatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'declined';

export type SubagentDispatchReasonCode =
  | 'refused'
  | 'aborted'
  | 'killed'
  | 'max-tokens'
  | 'refusal'
  | 'route-not-allowed'
  | 'credential'
  | 'provider-unavailable'
  | 'no-plan'
  | 'unfinished'
  | 'error';

export interface SubagentDispatchRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface SubagentDispatchProjection {
  dispatchId: string;
  kind: typeof SUBAGENT_DISPATCH_KIND;

  description: string;
  status: SubagentDispatchStatus;

  revision: number;
  updatedAt: string;

  parentSessionId: string;

  resolvedRoute?: SubagentDispatchRoute;
  reasonCode?: SubagentDispatchReasonCode;
}

export interface SubagentDispatchRecord {
  channelId: string;
  messageId: string;
  projection: SubagentDispatchProjection;
}

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
  apply(transition: SubagentDispatchTransition): SubagentDispatchRecord | undefined;
  get(channelId: string, dispatchId: string): SubagentDispatchProjection | undefined;

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

export function isTerminalSubagentDispatchStatus(status: SubagentDispatchStatus): boolean {
  return STATUS_RANK[status] === 2;
}

export function subagentDispatchStatusRank(status: SubagentDispatchStatus): number {
  return STATUS_RANK[status];
}

export function isSubagentDispatchStatus(value: unknown): value is SubagentDispatchStatus {
  return typeof value === 'string' && Object.hasOwn(STATUS_RANK, value);
}

export function isSubagentDispatchReasonCode(value: unknown): value is SubagentDispatchReasonCode {
  return typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value);
}

const UNSAFE_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function safeText(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(UNSAFE_CHARS, '').trim();
}

function isSafeToken(value: string): boolean {
  return value.length > 0 && value.length <= 80 && /^[A-Za-z0-9_.:/-]+$/u.test(value);
}

export function sanitizeSubagentDispatchDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = safeText(value);
  if (normalized.length === 0) return undefined;
  const characters = Array.from(normalized);
  return characters.length > SUBAGENT_DISPATCH_DESCRIPTION_MAX_CHARS
    ? characters.slice(0, SUBAGENT_DISPATCH_DESCRIPTION_MAX_CHARS).join('')
    : normalized;
}

export function isSubagentDispatchIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SUBAGENT_DISPATCH_ID_MAX_CHARS &&
    !UNSAFE_CHAR.test(value)
  );
}

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

export function subagentDispatchMessageId(dispatchId: string): string {
  const safe = isSubagentDispatchIdentity(dispatchId) ? dispatchId : String(dispatchId);
  const token = safe.replace(/[^A-Za-z0-9_-]+/gu, '-').slice(0, 64);
  const suffix = fnv1a(safe);
  return `subagent-dispatch-${token.length === 0 ? 'x' : token}-${suffix}`;
}

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
  } else if (route !== undefined && sanitizeSubagentDispatchRoute(route) === undefined)
    return false;
  const reasonCode = projection['reasonCode'];
  if (reasonCode !== undefined && !isSubagentDispatchReasonCode(reasonCode)) return false;
  return true;
}

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

export function mapSubagentFailureCode(code: unknown): SubagentDispatchReasonCode {
  switch (code) {
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

export function mapSubagentTurnEndReason(reason: unknown): {
  status: SubagentDispatchStatus;
  reasonCode?: SubagentDispatchReasonCode;
} {
  const mapped = mapSubagentStopReason(reason);
  if (mapped.reasonCode !== 'error') return mapped;
  const record =
    typeof reason === 'object' && reason !== null ? (reason as Record<string, unknown>) : undefined;
  const raw = record?.['error'];
  const error =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
  return { status: 'failed', reasonCode: mapSubagentFailureCode(error?.['code']) };
}

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
      const updatedAt = typeof at === 'string' && at.length > 0 ? at : new Date(0).toISOString();

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
        const nextDescription =
          previous.description.length > 0 ? previous.description : description;
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
