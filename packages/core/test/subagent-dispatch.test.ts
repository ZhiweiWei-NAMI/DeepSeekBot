import { describe, expect, it } from 'vitest';

import { isChannelMessage } from '../src/channels/channel.js';
import {
  createSubagentDispatchRegistry,
  isSubagentDispatchProjection,
  mapSubagentStopReason,
  isTerminalSubagentDispatchStatus,
  mapSubagentTurnEndReason,
  sanitizeSubagentDispatchDescription,
  sanitizeSubagentDispatchRoute,
  subagentDispatchMessageId,
  SUBAGENT_DISPATCH_DESCRIPTION_MAX_CHARS,
  SUBAGENT_DISPATCH_MAX_PER_CHANNEL,
  type SubagentDispatchRecord,
} from '../src/channels/subagent-dispatch.js';
import {
  createSubagentDispatchProjection,
  type SubagentDispatchCommit,
  type SubagentDispatchProjectionHost,
} from '../src/runtime/subagent-dispatch-projection.js';

const AT = '2026-10-15T06:00:00.000Z';

function transition(
  overrides: Partial<
    Parameters<ReturnType<typeof createSubagentDispatchRegistry>['apply']>[0]
  > = {},
): Parameters<ReturnType<typeof createSubagentDispatchRegistry>['apply']>[0] {
  return {
    channelId: 'dm-alpha',
    dispatchId: 'call-1',
    parentSessionId: 'session-parent',
    status: 'queued',
    at: AT,
    description: 'Audit the release notes',
    ...overrides,
  };
}

function toolCall(callId: string, name: string, args: unknown) {
  return {
    type: 'tool/call',
    time: 1,
    data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
  };
}

function toolResult(callId: string, isError: boolean, code?: string) {
  return {
    type: 'tool/result',
    time: 2,
    data: {
      turn: 1,
      step: 1,
      message: { toolCallId: callId, isError },
      ...(code === undefined ? {} : { error: { name: 'HarnessError', code } }),
    },
  };
}

function turnStart() {
  return { type: 'turn/start', time: 3, data: { turn: 1 } };
}

function turnEnd(reason: unknown) {
  return { type: 'turn/end', time: 4, data: { turn: 1, reason } };
}

function descriptor(payload: Record<string, unknown>) {
  return { type: 'subagent/descriptor', time: 5, data: payload };
}

function harness(
  options: {
    channelForSession?: (sessionId: string) => string | undefined;
    registry?: ReturnType<typeof createSubagentDispatchRegistry>;
  } = {},
) {
  const commits: SubagentDispatchCommit[] = [];
  const published: SubagentDispatchRecord[] = [];
  const warnings: string[] = [];
  const projection: SubagentDispatchProjectionHost = createSubagentDispatchProjection({
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    channelForSession: options.channelForSession ?? (() => 'dm-alpha'),
    commit: (input) => {
      commits.push(input);
    },
    publish: (record) => {
      published.push(record);
    },
    now: () => new Date(AT),
    warn: (message) => {
      warnings.push(message);
    },
  });
  return { projection, commits, published, warnings };
}

describe('subagent dispatch projection vocabulary', () => {
  it('sanitizes the delegation description and bounds it', () => {
    expect(sanitizeSubagentDispatchDescription('  Fix\n\tthe   tests ')).toBe('Fix the tests');
    expect(sanitizeSubagentDispatchDescription('a\u0000b\u202ac')).toBe('abc');
    expect(sanitizeSubagentDispatchDescription('   ')).toBeUndefined();
    expect(sanitizeSubagentDispatchDescription(7)).toBeUndefined();
    const long = 'x'.repeat(SUBAGENT_DISPATCH_DESCRIPTION_MAX_CHARS + 40);
    expect(sanitizeSubagentDispatchDescription(long)).toHaveLength(
      SUBAGENT_DISPATCH_DESCRIPTION_MAX_CHARS,
    );
  });

  it('accepts only bounded tokens as a resolved route', () => {
    expect(
      sanitizeSubagentDispatchRoute({
        provider: 'opencode-go',
        model: 'gpt-6.1-sol',
        reasoningEffort: 'high',
      }),
    ).toEqual({ provider: 'opencode-go', model: 'gpt-6.1-sol', reasoningEffort: 'high' });
    expect(sanitizeSubagentDispatchRoute({ provider: 'a b', model: 'm' })).toBeUndefined();
    expect(sanitizeSubagentDispatchRoute({ provider: 'p', model: '' })).toBeUndefined();
    expect(sanitizeSubagentDispatchRoute('p/m')).toBeUndefined();
  });

  it('derives a stable, safe card message id', () => {
    expect(subagentDispatchMessageId('call-1')).toBe(subagentDispatchMessageId('call-1'));
    expect(subagentDispatchMessageId('call-1')).not.toBe(subagentDispatchMessageId('call-2'));
    expect(subagentDispatchMessageId('call/1 odd')).toMatch(/^subagent-dispatch-[A-Za-z0-9_-]+$/u);
    expect(subagentDispatchMessageId('call/1 odd')).not.toBe(
      subagentDispatchMessageId('call/1-odd'),
    );
  });

  it('maps real Host stop reasons and never keeps an unmapped detail', () => {
    expect(mapSubagentTurnEndReason({ kind: 'completed' })).toEqual({ status: 'completed' });
    expect(mapSubagentTurnEndReason({ kind: 'aborted' })).toEqual({
      status: 'failed',
      reasonCode: 'aborted',
    });
    expect(
      mapSubagentTurnEndReason({ kind: 'error', error: { code: 'MISSING_CREDENTIAL' } }),
    ).toEqual({
      status: 'failed',
      reasonCode: 'credential',
    });
    expect(mapSubagentTurnEndReason({ kind: 'error', error: { code: 'SOMETHING_NEW' } })).toEqual({
      status: 'failed',
      reasonCode: 'error',
    });
    expect(mapSubagentTurnEndReason({ kind: 'max-tokens' })).toEqual({
      status: 'failed',
      reasonCode: 'max-tokens',
    });

    expect(mapSubagentStopReason('completed')).toEqual({ status: 'completed' });
    expect(mapSubagentStopReason('aborted')).toEqual({
      status: 'failed',
      reasonCode: 'aborted',
    });
  });

  it('validates a stored projection, including the declined-without-route rule', () => {
    const projection = {
      dispatchId: 'call-1',
      kind: 'subagent' as const,
      description: 'Fix the tests',
      status: 'running' as const,
      revision: 2,
      updatedAt: AT,
      parentSessionId: 'session-parent',
      resolvedRoute: { provider: 'opencode-go', model: 'gpt-6.1-sol' },
    };
    expect(isSubagentDispatchProjection(projection)).toBe(true);
    expect(isSubagentDispatchProjection({ ...projection, status: 'declined' })).toBe(false);
    expect(
      isSubagentDispatchProjection({
        ...projection,
        resolvedRoute: undefined,
        status: 'declined',
        reasonCode: 'refused',
      }),
    ).toBe(true);
    expect(isSubagentDispatchProjection({ ...projection, revision: 0 })).toBe(false);
    expect(isSubagentDispatchProjection({ ...projection, revision: 1.5 })).toBe(false);
    expect(isSubagentDispatchProjection({ ...projection, description: 'x'.repeat(400) })).toBe(
      false,
    );
    expect(isSubagentDispatchProjection({ ...projection, reasonCode: 'invented' })).toBe(false);
    expect(isSubagentDispatchProjection(null)).toBe(false);
  });
});

describe('subagent dispatch card is a valid Channel message', () => {
  it('accepts a system card and rejects a mismatched author or projection', () => {
    const card = {
      id: subagentDispatchMessageId('call-1'),
      at: AT,
      author: { kind: 'system' as const },
      body: 'Subagent: Fix the tests',
      format: 'text' as const,
      subagentDispatch: {
        dispatchId: 'call-1',
        kind: 'subagent' as const,
        description: 'Fix the tests',
        status: 'running' as const,
        revision: 2,
        updatedAt: AT,
        parentSessionId: 'session-parent',
      },
    };
    expect(isChannelMessage(card)).toBe(true);
    expect(isChannelMessage({ ...card, author: { kind: 'bot', slug: 'alpha' } })).toBe(false);
    expect(
      isChannelMessage({
        ...card,
        subagentDispatch: {
          ...card.subagentDispatch,
          status: 'declined',
          resolvedRoute: { provider: 'p', model: 'm' },
        },
      }),
    ).toBe(false);
  });
});

describe('subagent dispatch registry ordering', () => {
  it('advances queued to running to completed with monotonic revisions', () => {
    const registry = createSubagentDispatchRegistry();
    expect(registry.apply(transition())?.projection.status).toBe('queued');
    expect(registry.apply(transition({ status: 'running' }))?.projection.revision).toBe(2);
    const done = registry.apply(transition({ status: 'completed' }));
    expect(done?.projection).toMatchObject({
      status: 'completed',
      revision: 3,
      dispatchId: 'call-1',
      kind: 'subagent',
      parentSessionId: 'session-parent',
      description: 'Audit the release notes',
    });
    expect(isTerminalSubagentDispatchStatus(done!.projection.status)).toBe(true);
  });

  it('drops out-of-order and post-terminal transitions', () => {
    const registry = createSubagentDispatchRegistry();
    registry.apply(transition({ status: 'running' }));

    expect(registry.apply(transition({ status: 'queued' }))).toBeUndefined();
    registry.apply(transition({ status: 'failed', reasonCode: 'error' }));

    expect(registry.apply(transition({ status: 'running' }))).toBeUndefined();
    expect(registry.apply(transition({ status: 'completed' }))).toBeUndefined();
    expect(registry.get('dm-alpha', 'call-1')).toMatchObject({
      status: 'failed',
      revision: 2,
      reasonCode: 'error',
    });
  });

  it('drops a duplicate transition that carries no new information', () => {
    const registry = createSubagentDispatchRegistry();
    registry.apply(transition());
    expect(registry.apply(transition())).toBeUndefined();
    expect(registry.get('dm-alpha', 'call-1')?.revision).toBe(1);
  });

  it('never attaches a resolved route to a declined dispatch, but keeps one that arrives later', () => {
    const registry = createSubagentDispatchRegistry();
    const declined = registry.apply(
      transition({
        status: 'declined',
        reasonCode: 'refused',
        resolvedRoute: { provider: 'opencode-go', model: 'gpt-6.1-sol' },
      }),
    );
    expect(declined?.projection.resolvedRoute).toBeUndefined();

    const other = createSubagentDispatchRegistry();
    other.apply(transition({ status: 'declined', reasonCode: 'refused' }));
    expect(other.get('dm-alpha', 'call-1')?.resolvedRoute).toBeUndefined();
    const routed = other.apply(transition());
    expect(routed).toBeUndefined();
  });

  it('upgrades a running dispatch with the route the child really started on', () => {
    const registry = createSubagentDispatchRegistry();
    registry.apply(transition({ status: 'running' }));
    const routed = registry.apply(
      transition({
        status: 'running',
        resolvedRoute: { provider: 'opencode-go', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
      }),
    );
    expect(routed?.projection).toMatchObject({
      revision: 2,
      resolvedRoute: { provider: 'opencode-go', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    });
  });

  it('rejects malformed identities and unknown statuses', () => {
    const registry = createSubagentDispatchRegistry();
    expect(registry.apply(transition({ channelId: '' }))).toBeUndefined();
    expect(registry.apply(transition({ dispatchId: 'x'.repeat(500) }))).toBeUndefined();
    expect(registry.apply(transition({ status: 'invented' as never }))).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it('bounds retained records per Channel', () => {
    const registry = createSubagentDispatchRegistry();
    for (let index = 0; index < SUBAGENT_DISPATCH_MAX_PER_CHANNEL + 5; index += 1) {
      registry.apply(transition({ dispatchId: `call-${index}`, status: 'completed' }));
    }
    expect(registry.forChannel('dm-alpha').length).toBeLessThanOrEqual(
      SUBAGENT_DISPATCH_MAX_PER_CHANNEL,
    );
    expect(registry.get('dm-alpha', `call-${SUBAGENT_DISPATCH_MAX_PER_CHANNEL + 4}`)).toBeDefined();
  });
});

describe('subagent dispatch projection from real Host observations', () => {
  it('commits one card and declines a delegation the tool refused', async () => {
    const { projection, commits, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent', { description: 'Read the changelog' }),
    );
    await projection.flush();
    expect(commits).toHaveLength(0);

    projection.handleSessionEvent('session-parent', toolResult('call-1', true));
    await projection.flush();
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      channelId: 'dm-alpha',
      messageId: subagentDispatchMessageId('call-1'),
      body: 'Subagent: Read the changelog',
    });
    expect(commits[0]!.projection).toMatchObject({
      status: 'declined',
      reasonCode: 'refused',
      revision: 1,
    });
    expect(commits[0]!.projection.resolvedRoute).toBeUndefined();
    expect(published.at(-1)?.projection.status).toBe('declined');
  });

  it('declines with an aborted reason when cancellation wins before acceptance', async () => {
    const { projection, commits } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent', { description: 'Nightly sweep' }),
    );
    projection.handleSessionEvent(
      'session-parent',
      toolResult('call-1', true, 'TOOL_ABORTED_BEFORE_DISPATCH'),
    );
    await projection.flush();
    expect(commits[0]!.projection).toMatchObject({ status: 'declined', reasonCode: 'aborted' });
  });

  it('never invents a declined card when a turn ends before acceptance', async () => {
    const { projection, commits, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent_fork', { description: 'Fork a probe' }),
    );

    projection.handleSessionEvent('session-parent', turnEnd({ kind: 'completed' }));
    await projection.flush();
    expect(commits).toHaveLength(0);
    expect(published).toHaveLength(0);
    expect(projection.registry.size()).toBe(0);

    projection.handleJobEvent({
      type: 'registered',
      job: {
        id: 'subagent-late',
        kind: 'subagent',
        label: 'Fork a probe',
        owner: 'session-parent',
        status: 'running',
      },
    });
    await projection.flush();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.projection).toMatchObject({ status: 'queued', dispatchId: 'call-1' });
  });

  it('tracks a one-shot child to completion through queued and running', async () => {
    const { projection, commits, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent', { description: 'Deep review', run_in_background: true }),
    );
    projection.bindChild('session-child', 'session-parent', 'subagent');
    await projection.flush();
    expect(commits[0]!.projection).toMatchObject({ status: 'queued', revision: 1 });

    projection.handleSessionEvent('session-child', turnStart());
    projection.handleSessionEvent(
      'session-child',
      descriptor({ version: 3, mode: 'one-shot', provider: 'spawn', label: 'Deep review' }),
    );
    projection.handleSessionEvent('session-child', turnEnd({ kind: 'completed' }));
    await projection.flush();
    expect(published.map((record) => record.projection.status)).toEqual([
      'queued',
      'running',
      'completed',
    ]);
    expect(published.map((record) => record.projection.revision)).toEqual([1, 2, 3]);
    expect(commits).toHaveLength(1);
    expect(projection.pendingCount()).toBe(0);
  });

  it('settles a continuable child only on the Host activation terminal, with its route', async () => {
    const { projection, commits, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent', { description: 'Deep review', run_in_background: true }),
    );
    projection.bindChild('session-child', 'session-parent', 'subagent');
    projection.handleSessionEvent('session-child', turnStart());
    projection.handleSessionEvent(
      'session-child',
      descriptor({
        version: 3,
        mode: 'continuable',
        provider: 'spawn',
        label: 'Deep review',
        agentProvider: 'opencode-go',
        agentModel: 'gpt-6.1-sol',
        agentReasoningEffort: 'xhigh',
      }),
    );

    projection.handleSessionEvent('session-child', turnEnd({ kind: 'completed' }));
    await projection.flush();
    expect(published.at(-1)?.projection).toMatchObject({
      status: 'running',
      resolvedRoute: { provider: 'opencode-go', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' },
    });
    expect(published.some((record) => record.projection.status === 'completed')).toBe(false);
    expect(projection.pendingCount()).toBe(1);

    projection.handleSubagentEnd({
      runId: 'run-1',
      provider: 'spawn',
      id: 'session-child',
      local: true,
      stopReason: 'completed',
    });
    await projection.flush();
    expect(published.at(-1)?.projection).toMatchObject({
      status: 'completed',
      resolvedRoute: { provider: 'opencode-go', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' },
    });
    expect(commits).toHaveLength(1);
    expect(projection.pendingCount()).toBe(0);
  });

  it('records a background failure without inventing a completion', async () => {
    const { projection, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent', { description: 'Migrate the schema' }),
    );
    projection.bindChild('session-child', 'session-parent', 'subagent');
    projection.handleSessionEvent('session-child', turnStart());
    projection.handleSessionEvent(
      'session-child',
      descriptor({ version: 3, mode: 'one-shot', provider: 'spawn', label: 'Migrate the schema' }),
    );
    projection.handleSessionEvent(
      'session-child',
      turnEnd({ kind: 'error', error: { code: 'NO_ADAPTER', message: 'no adapter' } }),
    );
    await projection.flush();
    expect(published.at(-1)?.projection).toMatchObject({
      status: 'failed',
      reasonCode: 'provider-unavailable',
    });
    expect(published.some((record) => record.projection.status === 'completed')).toBe(false);
  });

  it('records a continuable activation failure from the Host terminal', async () => {
    const { projection, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent', { description: 'Continuable sweep' }),
    );
    projection.bindChild('session-child', 'session-parent', 'subagent');
    projection.handleSessionEvent('session-child', turnStart());
    projection.handleSessionEvent(
      'session-child',
      descriptor({
        version: 3,
        mode: 'continuable',
        provider: 'spawn',
        label: 'Continuable sweep',
      }),
    );
    projection.handleSessionEvent('session-child', turnEnd({ kind: 'completed' }));
    projection.handleSubagentEnd({ id: 'session-child', stopReason: 'max-tokens' });
    await projection.flush();
    expect(published.at(-1)?.projection).toMatchObject({
      status: 'failed',
      reasonCode: 'max-tokens',
    });
  });

  it('keeps a running card when no terminal fact ever arrives', async () => {
    const { projection, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent', { description: 'Long sweep' }),
    );
    projection.bindChild('session-child', 'session-parent', 'subagent');
    projection.handleSessionEvent('session-child', turnStart());

    projection.handleSessionDisposed('session-parent');
    await projection.flush();
    expect(published.at(-1)?.projection.status).toBe('running');
    expect(published).toHaveLength(2);
  });

  it('tracks the background Job path from registration to settlement', async () => {
    const { projection, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent_fork', {
        description: 'Fork the bench',
        run_in_background: true,
      }),
    );
    projection.handleJobEvent({
      type: 'registered',
      job: {
        id: 'subagent-7',
        kind: 'subagent',
        label: 'Fork the bench',
        owner: 'session-parent',
        status: 'running',
      },
    });
    projection.handleJobEvent({
      type: 'settled',
      job: {
        id: 'subagent-7',
        kind: 'subagent',
        label: 'Fork the bench',
        owner: 'session-parent',
        status: 'killed',
      },
    });
    await projection.flush();
    expect(published.map((record) => record.projection.status)).toEqual(['queued', 'failed']);
    expect(published.at(-1)?.projection.reasonCode).toBe('killed');
  });

  it('tracks a background fork through its Job and its child terminal', async () => {
    const { projection, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent_fork', {
        description: 'Bench the fork',
        run_in_background: true,
      }),
    );
    projection.handleJobEvent({
      type: 'registered',
      job: {
        id: 'subagent-7',
        kind: 'subagent',
        label: 'Bench the fork',
        owner: 'session-parent',
        status: 'running',
      },
    });

    projection.bindChild('session-child', 'session-parent', 'subagent');
    projection.handleSessionEvent('session-child', turnStart());
    projection.handleSessionEvent(
      'session-child',
      descriptor({ version: 3, mode: 'one-shot', provider: 'spawn', label: 'Bench the fork' }),
    );
    projection.handleSessionEvent('session-child', turnEnd({ kind: 'max-tokens' }));
    await projection.flush();
    expect(published.map((record) => record.projection.status)).toEqual([
      'queued',
      'running',
      'failed',
    ]);
    expect(published.at(-1)?.projection.reasonCode).toBe('max-tokens');

    projection.handleJobEvent({
      type: 'settled',
      job: {
        id: 'subagent-7',
        kind: 'subagent',
        label: 'Bench the fork',
        owner: 'session-parent',
        status: 'killed',
      },
    });
    await projection.flush();
    expect(published.at(-1)?.projection.reasonCode).toBe('max-tokens');
  });

  it('drops an out-of-order acceptance that arrives after the child finished', async () => {
    const { projection, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent', { description: 'Race me' }),
    );
    projection.bindChild('session-child', 'session-parent', 'subagent');
    projection.handleSessionEvent('session-child', turnStart());
    projection.handleSessionEvent(
      'session-child',
      descriptor({ version: 3, mode: 'one-shot', provider: 'spawn', label: 'Race me' }),
    );
    projection.handleSessionEvent('session-child', turnEnd({ kind: 'completed' }));
    await projection.flush();

    projection.handleJobEvent({
      type: 'registered',
      job: {
        id: 'subagent-9',
        kind: 'subagent',
        label: 'Race me',
        owner: 'session-parent',
        status: 'running',
      },
    });
    await projection.flush();
    expect(published.map((record) => record.projection.status)).toEqual([
      'queued',
      'running',
      'completed',
    ]);
  });

  it('keeps each Channel isolated, and projects nothing when a Session has no Channel', async () => {
    const channels = new Map([
      ['session-alpha', 'dm-alpha'],
      ['session-beta', 'dm-beta'],
    ]);
    const { projection, commits } = harness({
      channelForSession: (sessionId) => channels.get(sessionId),
    });
    projection.handleSessionEvent(
      'session-alpha',
      toolCall('call-a', 'bot_subagent', { description: 'Alpha work' }),
    );
    projection.handleSessionEvent(
      'session-beta',
      toolCall('call-b', 'bot_subagent', { description: 'Beta work' }),
    );
    projection.handleSessionEvent('session-beta', toolResult('call-b', true));
    projection.handleSessionEvent('session-alpha', toolResult('call-a', true));

    projection.handleSessionEvent(
      'session-assignment',
      toolCall('call-c', 'bot_subagent', { description: 'Assignment work' }),
    );
    await projection.flush();

    expect(commits.map((commit) => commit.channelId)).toEqual(['dm-beta', 'dm-alpha']);
    expect(
      projection.registry.forChannel('dm-alpha').map((record) => record.projection.dispatchId),
    ).toEqual(['call-a']);
    expect(
      projection.registry.forChannel('dm-beta').map((record) => record.projection.dispatchId),
    ).toEqual(['call-b']);
    expect(projection.registry.size()).toBe(2);
  });

  it("attributes reversed child creation by each child's own descriptor label", async () => {
    const { projection, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent', { description: 'First task' }),
    );
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-2', 'bot_subagent', { description: 'Second task' }),
    );

    projection.bindChild('child-b', 'session-parent', 'subagent');
    projection.bindChild('child-a', 'session-parent', 'subagent');
    projection.handleSessionEvent('child-b', turnStart());
    projection.handleSessionEvent('child-a', turnStart());
    await projection.flush();
    expect(published).toHaveLength(0);

    projection.handleSessionEvent(
      'child-b',
      descriptor({ version: 3, mode: 'one-shot', provider: 'spawn', label: 'Second task' }),
    );
    projection.handleSessionEvent(
      'child-a',
      descriptor({ version: 3, mode: 'one-shot', provider: 'spawn', label: 'First task' }),
    );
    projection.handleSessionEvent('child-a', turnEnd({ kind: 'completed' }));
    projection.handleSessionEvent(
      'child-b',
      turnEnd({ kind: 'error', error: { message: 'boom' } }),
    );
    await projection.flush();

    const byId = new Map(
      published.map((record) => [record.projection.dispatchId, record.projection]),
    );

    expect(byId.get('call-1')).toMatchObject({ description: 'First task', status: 'completed' });
    expect(byId.get('call-2')).toMatchObject({ description: 'Second task', status: 'failed' });
  });

  it('binds no card when two real Jobs share one label', async () => {
    const { projection, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-a', 'bot_subagent_fork', { description: 'Same label' }),
    );
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-b', 'bot_subagent_fork', { description: 'Same label' }),
    );
    for (const id of ['subagent-a', 'subagent-b']) {
      projection.handleJobEvent({
        type: 'registered',
        job: {
          id,
          kind: 'subagent',
          label: 'Same label',
          owner: 'session-parent',
          status: 'running',
        },
      });
      projection.handleJobEvent({
        type: 'settled',
        job: {
          id,
          kind: 'subagent',
          label: 'Same label',
          owner: 'session-parent',
          status: 'failed',
        },
      });
    }
    await projection.flush();

    expect(published).toHaveLength(0);
    expect(projection.registry.size()).toBe(0);
  });

  it("never publishes another delegation's route on a reused parent Session", async () => {
    const channels = new Map([['session-parent', 'dm-alpha']]);
    const { projection, published } = harness({
      channelForSession: (sessionId) => channels.get(sessionId),
    });

    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-a', 'bot_subagent_fork', { description: 'Same task' }),
    );
    projection.handleJobEvent({
      type: 'registered',
      job: {
        id: 'subagent-a',
        kind: 'subagent',
        label: 'Same task',
        owner: 'session-parent',
        status: 'running',
      },
    });
    projection.handleSessionEvent('session-parent', turnEnd({ kind: 'completed' }));
    await projection.flush();
    expect(projection.registry.get('dm-alpha', 'call-a')).toMatchObject({ status: 'queued' });

    channels.set('session-parent', 'dm-beta');
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-b', 'bot_subagent', { description: 'Same task' }),
    );
    projection.bindChild('child-b', 'session-parent', 'subagent');
    projection.handleSessionEvent('child-b', turnStart());
    projection.handleSessionEvent(
      'child-b',
      descriptor({
        version: 3,
        mode: 'continuable',
        provider: 'spawn',
        label: 'Same task',
        agentProvider: 'provider-b',
        agentModel: 'model-b',
      }),
    );
    projection.handleSessionEvent('child-b', turnEnd({ kind: 'completed' }));
    projection.handleSubagentEnd({ id: 'child-b', stopReason: 'completed' });
    await projection.flush();

    expect(projection.registry.get('dm-alpha', 'call-a')).toMatchObject({
      status: 'queued',
      description: 'Same task',
    });
    expect(projection.registry.get('dm-alpha', 'call-a')?.resolvedRoute).toBeUndefined();
    expect(projection.registry.get('dm-beta', 'call-b')).toBeUndefined();
    expect(published.every((record) => record.projection.resolvedRoute === undefined)).toBe(true);
  });

  it('leaves a delegation unbound rather than guessing when no key proves the target', async () => {
    const { projection, published } = harness();
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent', { description: 'First task' }),
    );
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-2', 'bot_subagent', { description: 'Second task' }),
    );

    projection.handleJobEvent({
      type: 'registered',
      job: {
        id: 'subagent-unknown',
        kind: 'subagent',
        label: 'Some other task',
        owner: 'session-parent',
        status: 'running',
      },
    });

    projection.bindChild('child-x', 'session-parent', 'subagent');
    await projection.flush();
    expect(published).toHaveLength(0);
    expect(projection.registry.size()).toBe(0);
  });

  it('reports a warning instead of throwing when the journal commit fails', async () => {
    const warnings: string[] = [];
    const projection = createSubagentDispatchProjection({
      channelForSession: () => 'dm-alpha',
      commit: () => {
        throw new Error('journal offline');
      },
      publish: () => undefined,
      now: () => new Date(AT),
      warn: (message) => {
        warnings.push(message);
      },
    });
    projection.handleSessionEvent(
      'session-parent',
      toolCall('call-1', 'bot_subagent', { description: 'Fail the commit' }),
    );
    projection.handleSessionEvent('session-parent', toolResult('call-1', true));
    await expect(projection.flush()).resolves.toBeUndefined();
    expect(warnings.some((message) => message.includes('journal offline'))).toBe(true);
  });
});
