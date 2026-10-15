import type { DshSessionEvent } from '../sessions/source.js';
import {
  createSubagentDispatchRegistry,
  isTerminalSubagentDispatchStatus,
  mapSubagentJobStatus,
  mapSubagentStopReason,
  mapSubagentTurnEndReason,
  sanitizeSubagentDispatchDescription,
  sanitizeSubagentDispatchRoute,
  type SubagentDispatchProjection,
  type SubagentDispatchReasonCode,
  type SubagentDispatchRecord,
  type SubagentDispatchRegistry,
  type SubagentDispatchStatus,
} from '../channels/subagent-dispatch.js';

export const SUBAGENT_DISPATCH_TOOLS: readonly string[] = ['bot_subagent', 'bot_subagent_fork'];

export const SUBAGENT_DISPATCH_MAX_INTENTS_PER_SESSION = 64;

export const SUBAGENT_DISPATCH_MAX_DEFERRED_CHILDREN = 64;

export interface SubagentDispatchCommit {
  channelId: string;
  messageId: string;
  at: string;
  body: string;
  projection: SubagentDispatchProjection;
}

export interface SubagentDispatchProjectionOptions {
  registry?: SubagentDispatchRegistry;

  channelForSession(sessionId: string): string | undefined;

  commit(input: SubagentDispatchCommit): Promise<void> | void;

  publish(record: SubagentDispatchRecord): void;
  now?(): Date;
  warn?(message: string): void;
  maxIntentsPerSession?: number;
}

type DispatchMode = 'one-shot' | 'continuable';

interface DispatchIntent {
  dispatchId: string;
  parentSessionId: string;
  channelId: string;
  description: string;
  childSessionId?: string;
  jobId?: string;
  mode?: DispatchMode;
  settled: boolean;
}

interface DeferredChild {
  parentSessionId: string;
  started: boolean;
  endReason?: unknown;
}

export interface ReportedJob {
  id: string;
  kind: string;
  label: string;
  owner?: string;
  status: string;
}

export interface SubagentDispatchProjectionHost {
  readonly registry: SubagentDispatchRegistry;
  handleSessionEvent(sessionId: string, event: DshSessionEvent): void;

  bindChild(childSessionId: string, parentSessionId: string, provenance?: string): void;
  handleJobEvent(event: { type: string; job?: ReportedJob }): void;

  handleSubagentEnd(info: unknown): void;
  handleSessionDisposed(sessionId: string): void;

  flush(): Promise<void>;
  pendingCount(): number;
  clear(): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function descriptionFromArguments(argumentsJson: unknown): string | undefined {
  if (typeof argumentsJson !== 'string' || argumentsJson.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  return record === undefined
    ? undefined
    : sanitizeSubagentDispatchDescription(record['description']);
}

function dispatchMode(value: unknown): DispatchMode | undefined {
  return value === 'one-shot' || value === 'continuable' ? value : undefined;
}

export function createSubagentDispatchProjection(
  options: SubagentDispatchProjectionOptions,
): SubagentDispatchProjectionHost {
  const registry = options.registry ?? createSubagentDispatchRegistry();
  const now = options.now ?? (() => new Date());
  const maxIntents = options.maxIntentsPerSession ?? SUBAGENT_DISPATCH_MAX_INTENTS_PER_SESSION;
  const intentsBySession = new Map<string, DispatchIntent[]>();
  const intentsByDispatch = new Map<string, DispatchIntent>();
  const intentsByChild = new Map<string, DispatchIntent>();
  const intentsByJob = new Map<string, DispatchIntent>();
  const deferredChildren = new Map<string, DeferredChild>();
  const queues = new Map<string, Promise<void>>();

  const enqueue = (key: string, task: () => Promise<void> | void): void => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(task, task)
      .catch((error: unknown) => {
        options.warn?.(`subagent-dispatch: ${String(error)}`);
      })
      .then(() => {
        if (queues.get(key) === next) queues.delete(key);
      });
    queues.set(key, next);
  };

  const releaseIntent = (intent: DispatchIntent): void => {
    const group = intentsBySession.get(intent.parentSessionId);
    if (group !== undefined) {
      const index = group.indexOf(intent);
      if (index !== -1) group.splice(index, 1);
      if (group.length === 0) intentsBySession.delete(intent.parentSessionId);
    }
    intentsByDispatch.delete(intent.dispatchId);
    if (intent.childSessionId !== undefined) intentsByChild.delete(intent.childSessionId);
    if (intent.jobId !== undefined) intentsByJob.delete(intent.jobId);
  };

  const apply = (
    intent: DispatchIntent,
    status: SubagentDispatchStatus,
    extra: { resolvedRoute?: unknown; reasonCode?: SubagentDispatchReasonCode } = {},
  ): void => {
    const at = now().toISOString();
    const route = sanitizeSubagentDispatchRoute(extra.resolvedRoute);
    const record = registry.apply({
      channelId: intent.channelId,
      dispatchId: intent.dispatchId,
      parentSessionId: intent.parentSessionId,
      status,
      at,
      description: intent.description,
      ...(route === undefined ? {} : { resolvedRoute: route }),
      ...(extra.reasonCode === undefined ? {} : { reasonCode: extra.reasonCode }),
    });
    if (record === undefined) return;
    const first = record.projection.revision === 1;
    if (isTerminalSubagentDispatchStatus(status)) intent.settled = true;
    enqueue(intent.dispatchId, async () => {
      if (first) {
        await options.commit({
          channelId: record.channelId,
          messageId: record.messageId,
          at,
          body: dispatchCardBody(record.projection),
          projection: record.projection,
        });
      }
      options.publish(record);
    });
  };

  const pendingFor = (parentSessionId: string): DispatchIntent[] =>
    intentsBySession.get(parentSessionId) ?? [];

  const truncate = (parentSessionId: string): void => {
    const group = intentsBySession.get(parentSessionId);
    if (group === undefined) return;
    for (const intent of [...group]) {
      if (group.length <= maxIntents) break;
      if (!intent.settled) continue;
      releaseIntent(intent);
    }
  };

  const registerIntent = (
    parentSessionId: string,
    dispatchId: string,
    channelId: string,
    description: string,
  ): DispatchIntent => {
    const intent: DispatchIntent = {
      dispatchId,
      parentSessionId,
      channelId,
      description,
      settled: false,
    };
    let group = intentsBySession.get(parentSessionId);
    if (group === undefined) {
      group = [];
      intentsBySession.set(parentSessionId, group);
    }
    group.push(intent);
    intentsByDispatch.set(dispatchId, intent);
    truncate(parentSessionId);
    return intent;
  };

  const claimIntent = (
    parentSessionId: string,
    kind: 'child' | 'job',
    description?: string,
  ): DispatchIntent | undefined => {
    const candidates = pendingFor(parentSessionId).filter(
      (intent) =>
        !intent.settled &&
        (kind === 'child' ? intent.childSessionId === undefined : intent.jobId === undefined),
    );
    if (description !== undefined && description.length > 0) {
      const matches = candidates.filter((intent) => intent.description === description);
      return matches.length === 1 ? matches[0] : undefined;
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  const attachChild = (intent: DispatchIntent, childSessionId: string): void => {
    if (intent.childSessionId !== undefined) intentsByChild.delete(intent.childSessionId);
    intent.childSessionId = childSessionId;
    intentsByChild.set(childSessionId, intent);
  };

  const deferChild = (childSessionId: string, parentSessionId: string): void => {
    deferredChildren.delete(childSessionId);
    deferredChildren.set(childSessionId, { parentSessionId, started: false });
    while (deferredChildren.size > SUBAGENT_DISPATCH_MAX_DEFERRED_CHILDREN) {
      const oldest = deferredChildren.keys().next();
      if (oldest.done === true) break;
      deferredChildren.delete(oldest.value);
    }
  };

  const applyDescriptorRoute = (intent: DispatchIntent, data: Record<string, unknown>): void => {
    if (dispatchMode(data['mode']) !== 'continuable') return;
    const provider = data['agentProvider'];
    const model = data['agentModel'];
    const reasoningEffort = data['agentReasoningEffort'];
    if (typeof provider !== 'string' || typeof model !== 'string') return;
    const current = registry.get(intent.channelId, intent.dispatchId);
    if (current === undefined) return;
    apply(intent, current.status, {
      resolvedRoute: {
        provider,
        model,
        ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}),
      },
    });
  };

  const handleParentEvent = (intent: DispatchIntent, event: DshSessionEvent): void => {
    if (intent.settled) return;
    const data = asRecord(event.data);
    if (data === undefined) return;
    if (event.type === 'tool/result') {
      const message = asRecord(data['message']);
      if (message?.['toolCallId'] !== intent.dispatchId) return;
      if (message['isError'] !== true) return;
      if (intent.childSessionId !== undefined || intent.jobId !== undefined) return;
      const error = asRecord(data['error']);
      const code = error?.['code'];
      apply(intent, 'declined', {
        reasonCode:
          code === 'TOOL_ABORTED' || code === 'TOOL_ABORTED_BEFORE_DISPATCH'
            ? 'aborted'
            : 'refused',
      });
      releaseIntent(intent);
      return;
    }
  };

  const handleChildEvent = (intent: DispatchIntent, event: DshSessionEvent): void => {
    if (intent.settled) return;
    const data = asRecord(event.data);
    if (event.type === 'subagent/descriptor') {
      if (data === undefined) return;
      const mode = dispatchMode(data['mode']);
      if (mode !== undefined) intent.mode = mode;
      applyDescriptorRoute(intent, data);
      return;
    }
    if (event.type === 'turn/start') {
      apply(intent, 'running');
      return;
    }
    if (event.type === 'turn/end') {
      if (intent.mode !== 'one-shot') return;
      const mapped = mapSubagentTurnEndReason(data?.['reason']);
      apply(intent, mapped.status, {
        ...(mapped.reasonCode === undefined ? {} : { reasonCode: mapped.reasonCode }),
      });
      releaseIntent(intent);
    }
  };

  const handleDeferredChildEvent = (
    childSessionId: string,
    deferred: DeferredChild,
    event: DshSessionEvent,
  ): void => {
    if (event.type === 'turn/start') {
      deferred.started = true;
      return;
    }
    if (event.type === 'turn/end') {
      deferred.endReason = asRecord(event.data)?.['reason'];
      return;
    }
    if (event.type !== 'subagent/descriptor') return;
    const data = asRecord(event.data);
    if (data === undefined) return;
    const label = sanitizeSubagentDispatchDescription(data['label']);
    const intent = claimIntent(deferred.parentSessionId, 'child', label);
    if (intent === undefined) return;
    deferredChildren.delete(childSessionId);
    attachChild(intent, childSessionId);
    const mode = dispatchMode(data['mode']);
    if (mode !== undefined) intent.mode = mode;

    if (deferred.endReason !== undefined && mode === 'one-shot') {
      const mapped = mapSubagentTurnEndReason(deferred.endReason);
      apply(intent, mapped.status, {
        ...(mapped.reasonCode === undefined ? {} : { reasonCode: mapped.reasonCode }),
      });
      releaseIntent(intent);
      return;
    }
    apply(intent, deferred.started ? 'running' : 'queued');
    applyDescriptorRoute(intent, data);
  };

  return {
    registry,
    handleSessionEvent(sessionId, event) {
      const child = intentsByChild.get(sessionId);
      if (child !== undefined) {
        handleChildEvent(child, event);
        return;
      }
      const deferred = deferredChildren.get(sessionId);
      if (deferred !== undefined) {
        handleDeferredChildEvent(sessionId, deferred, event);
        return;
      }
      const group = intentsBySession.get(sessionId);
      if (event.type === 'tool/call') {
        const data = asRecord(event.data);
        const name = data?.['name'];
        const callId = data?.['callId'];
        if (typeof name !== 'string' || !SUBAGENT_DISPATCH_TOOLS.includes(name)) return;
        if (typeof callId !== 'string' || callId.length === 0) return;
        if (intentsByDispatch.has(callId)) return;
        const channelId = options.channelForSession(sessionId);
        if (channelId === undefined) return;
        registerIntent(
          sessionId,
          callId,
          channelId,
          descriptionFromArguments(data?.['arguments']) ?? '',
        );
        return;
      }
      if (group === undefined) return;
      for (const intent of [...group]) handleParentEvent(intent, event);
    },
    bindChild(childSessionId, parentSessionId, provenance) {
      if (intentsByChild.has(childSessionId) || deferredChildren.has(childSessionId)) return;
      if (provenance !== undefined && provenance !== 'subagent' && provenance !== 'fork') return;
      const intent = claimIntent(parentSessionId, 'child');
      if (intent === undefined) {
        deferChild(childSessionId, parentSessionId);
        return;
      }
      attachChild(intent, childSessionId);
      apply(intent, 'queued');
    },
    handleJobEvent(event) {
      if (event.type === 'registered') {
        const job = event.job;
        if (job === undefined || job.kind !== 'subagent' || job.owner === undefined) return;
        if (intentsByJob.has(job.id)) return;
        const intent = claimIntent(
          job.owner,
          'job',
          sanitizeSubagentDispatchDescription(job.label),
        );
        if (intent === undefined) return;
        intent.jobId = job.id;
        intentsByJob.set(job.id, intent);
        apply(intent, 'queued');
        return;
      }
      if (event.type === 'settled') {
        const job = event.job;
        if (job === undefined) return;
        const intent = intentsByJob.get(job.id);
        if (intent === undefined || intent.settled) return;
        const mapped = mapSubagentJobStatus(job.status);
        apply(intent, mapped.status, {
          ...(mapped.reasonCode === undefined ? {} : { reasonCode: mapped.reasonCode }),
        });
        releaseIntent(intent);
      }
    },
    handleSubagentEnd(info) {
      const record = asRecord(info);
      const childSessionId = record?.['id'];
      if (typeof childSessionId !== 'string' || childSessionId.length === 0) return;
      const intent = intentsByChild.get(childSessionId);
      if (intent === undefined || intent.settled) return;

      const mapped = mapSubagentStopReason(record?.['stopReason']);
      apply(intent, mapped.status, {
        ...(mapped.reasonCode === undefined ? {} : { reasonCode: mapped.reasonCode }),
      });
      releaseIntent(intent);
    },
    handleSessionDisposed(sessionId) {
      deferredChildren.delete(sessionId);
      const group = intentsBySession.get(sessionId);
      if (group === undefined) return;
      for (const intent of [...group]) {
        if (intent.settled) {
          releaseIntent(intent);
          continue;
        }

        if (intent.childSessionId !== undefined || intent.jobId !== undefined) continue;
        releaseIntent(intent);
      }
    },
    async flush() {
      while (queues.size > 0) await Promise.allSettled([...queues.values()]);
    },
    pendingCount() {
      return intentsByDispatch.size;
    },
    clear() {
      intentsBySession.clear();
      intentsByDispatch.clear();
      intentsByChild.clear();
      intentsByJob.clear();
      deferredChildren.clear();
      registry.clear();
    },
  };
}

export function dispatchCardBody(projection: SubagentDispatchProjection): string {
  return projection.description.length === 0
    ? 'Subagent delegation'
    : `Subagent: ${projection.description}`;
}

export interface SubagentDispatchJobEvents {
  subscribe(filter: SubagentDispatchJobFilter, listener: (event: unknown) => void): () => void;
}

export type SubagentDispatchJobFilter = { owner: string } | { owners: 'scope' | 'all' };

export interface SubagentDispatchJobs {
  events?: SubagentDispatchJobEvents;
}

export function reportedJob(value: unknown): ReportedJob | undefined {
  const job = asRecord(value);
  if (job === undefined) return undefined;
  const id = job['id'];
  const kind = job['kind'];
  const label = job['label'];
  const status = job['status'];
  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (typeof kind !== 'string' || typeof label !== 'string' || typeof status !== 'string')
    return undefined;
  const owner = job['owner'];
  return {
    id,
    kind,
    label,
    status,
    ...(typeof owner === 'string' && owner.length > 0 ? { owner } : {}),
  };
}

export function subscribeSubagentJobs(
  events: SubagentDispatchJobEvents | undefined,
  filter: SubagentDispatchJobFilter,
  sink: (event: { type: string; job?: ReportedJob }) => void,
): () => void {
  if (events === undefined) return () => undefined;
  return events.subscribe(filter, (event) => {
    const record = asRecord(event);
    if (record === undefined) return;
    const type = record['type'];
    if (type !== 'registered' && type !== 'settled') return;
    const job = reportedJob(record['job']);
    if (job === undefined) return;
    sink({ type, job });
  });
}
