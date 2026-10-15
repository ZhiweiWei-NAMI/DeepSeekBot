import {
  isSubagentDispatchProjection,
  isTerminalSubagentDispatchStatus,
  sanitizeSubagentDispatchRoute,
  subagentDispatchStatusRank,
  type SubagentDispatchProjection,
} from '../../../core/src/channels/subagent-dispatch.js';
import type { ChannelMessage } from './store.js';

export type SubagentDispatch = SubagentDispatchProjection;

export function parseSubagentDispatch(value: unknown): SubagentDispatch | undefined {
  if (!isSubagentDispatchProjection(value)) return undefined;
  const resolvedRoute = sanitizeSubagentDispatchRoute(value.resolvedRoute);
  return {
    dispatchId: value.dispatchId,
    kind: 'subagent',
    description: value.description,
    status: value.status,
    revision: value.revision,
    updatedAt: value.updatedAt,
    parentSessionId: value.parentSessionId,
    ...(resolvedRoute === undefined ? {} : { resolvedRoute }),
    ...((value.status === 'failed' || value.status === 'declined') && value.reasonCode !== undefined
      ? { reasonCode: value.reasonCode }
      : {}),
  };
}

export function newerSubagentDispatch(
  previous: SubagentDispatch | undefined,
  next: SubagentDispatch,
): SubagentDispatch {
  if (previous === undefined) return next;
  if (
    previous.dispatchId !== next.dispatchId ||
    previous.parentSessionId !== next.parentSessionId ||
    next.revision <= previous.revision ||
    isTerminalSubagentDispatchStatus(previous.status) ||
    subagentDispatchStatusRank(next.status) < subagentDispatchStatusRank(previous.status)
  )
    return previous;
  return next;
}

export function preserveSubagentDispatches(
  previous: readonly ChannelMessage[],
  next: readonly ChannelMessage[],
): readonly ChannelMessage[] {
  const known = new Map(
    previous
      .filter((message) => message.subagentDispatch !== undefined)
      .map((message) => [message.id, message.subagentDispatch!]),
  );
  return next.map((message) => {
    const held = known.get(message.id);
    if (held === undefined || message.author.kind !== 'system' || message.contentPurged)
      return message;
    const projection =
      message.subagentDispatch === undefined
        ? held
        : newerSubagentDispatch(held, message.subagentDispatch);
    return projection === message.subagentDispatch
      ? message
      : { ...message, subagentDispatch: projection };
  });
}

export function overlaySubagentDispatches(
  messages: readonly ChannelMessage[],
  dispatches: ReadonlyMap<string, SubagentDispatch>,
): readonly ChannelMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    const incoming = dispatches.get(message.id);
    if (incoming === undefined || message.author.kind !== 'system' || message.contentPurged)
      return message;
    const projection = newerSubagentDispatch(message.subagentDispatch, incoming);
    if (projection === message.subagentDispatch) return message;
    changed = true;
    return { ...message, subagentDispatch: projection };
  });
  return changed ? next : messages;
}
