import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { PersonaBotModelPlan } from '../src/models/presets.js';
import type { SubagentAdvisor } from '../src/models/subagent-advisor.js';
import { installBotSubagentModelTools } from '../src/runtime/subagent-model-tools.js';

const plan: PersonaBotModelPlan = {
  revision: 1,
  sourcePresetId: 'preset',
  sourcePresetName: 'QA',
  appliedAt: '2026-09-30T00:00:00.000Z',
  orchestrator: { provider: 'deepseek', model: 'flash', reasoningEffort: 'low' },
  assignmentDefault: { provider: 'deepseek', model: 'pro', reasoningEffort: 'off' },
  assignmentModels: [
    { provider: 'deepseek', model: 'pro', allowedEfforts: ['off'], defaultEffort: 'off' },
  ],
};

describe('Bot-owned DSH Subagent tools', () => {
  it('fails before creating a child when the current default cannot resolve', async () => {
    const definitions = new Map<string, ToolDefinition>();
    const start = vi.fn();
    const startContinuable = vi.fn();
    const resolveCallConfig = vi.fn().mockRejectedValue(new Error('Selected model is unavailable'));
    const guards: Array<(execution: { name: string }) => string | undefined> = [];
    const context = {
      get(name: string) {
        if (name === 'subagents') return { resolveMaxDepth: () => 1, start, startContinuable };
        if (name === 'llm') return { resolveCallConfig };
        return undefined;
      },
      tools: {
        register(definition: ToolDefinition) {
          definitions.set(definition.name, definition);
          return () => undefined;
        },
        guard(check: (execution: { name: string }) => string | undefined) {
          guards.push(check);
          return () => undefined;
        },
      },
      systemPrompt: { section: () => () => undefined },
    } as unknown as Context;
    const agent = {
      id: 'parent',
      options: {
        provider: 'old-provider',
        model: 'old-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
      session: { id: 'parent', requestHeader: () => undefined },
    } as unknown as Agent;
    installBotSubagentModelTools(context, agent, () => plan);

    const tool = definitions.get('bot_subagent');
    expect(tool).toBeDefined();
    await expect(
      tool!.execute({ description: 'Unavailable default', prompt: 'Do not run' }, {
        agent,
        signal: new AbortController().signal,
      } as Parameters<ToolDefinition['execute']>[1]),
    ).rejects.toThrow('Selected model is unavailable');
    expect(resolveCallConfig).toHaveBeenCalledWith(
      { provider: 'deepseek', model: 'pro', reasoningEffort: ReasoningEffortId('off') },
      expect.any(AbortSignal),
    );
    expect(start).not.toHaveBeenCalled();
    expect(startContinuable).not.toHaveBeenCalled();
    expect(guards[0]?.({ name: 'subagent' })).toContain('Bot-scoped');
    expect(guards[0]?.({ name: 'bot_subagent' })).toBeUndefined();
  });
});

const wiringPlan: PersonaBotModelPlan = {
  revision: 3,
  sourcePresetId: 'preset',
  sourcePresetName: 'Mix',
  appliedAt: '2026-10-15T00:00:00.000Z',
  orchestrator: { provider: 'workbuddy', model: 'deepseek-v4-flash' },
  assignmentDefault: {
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'max',
  },
  assignmentModels: [
    {
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      allowedEfforts: ['max'],
      defaultEffort: 'max',
    },
    {
      provider: 'workbuddy',
      model: 'glm-5.3-flash',
      allowedEfforts: ['high'],
      defaultEffort: 'high',
    },
  ],
};

const advisedRoute = {
  source: 'advisor' as const,
  route: { provider: 'workbuddy', model: 'glm-5.3-flash', reasoningEffort: 'high' },
  candidateId: 'c1',
  confidence: 0.9,
};

function subagentHarness(
  resolveCallConfig: ReturnType<typeof vi.fn>,
  advisor: () => SubagentAdvisor | undefined,
  resolvePlan: () => PersonaBotModelPlan | undefined = () => wiringPlan,
): {
  tool: ToolDefinition;
  start: ReturnType<typeof vi.fn>;
  startContinuable: ReturnType<typeof vi.fn>;
} {
  const definitions = new Map<string, ToolDefinition>();
  const run = {
    id: 'child-1',
    result: Promise.resolve({
      stopReason: 'completed' as const,
      output: [{ type: 'text' as const, text: 'ok' }],
    }),
    dispose: async () => undefined,
  };
  const start = vi.fn(async () => run);
  const startContinuable = vi.fn();
  const context = {
    get(name: string) {
      if (name === 'subagents') return { resolveMaxDepth: () => 1, start, startContinuable };
      if (name === 'llm') return { resolveCallConfig };
      return undefined;
    },
    tools: {
      register(definition: ToolDefinition) {
        definitions.set(definition.name, definition);
        return () => undefined;
      },
      guard() {
        return () => undefined;
      },
    },
    systemPrompt: { section: () => () => undefined },
  } as unknown as Context;
  const agent = {
    id: 'parent',
    options: {
      provider: 'old-provider',
      model: 'old-model',
      reasoningEffort: ReasoningEffortId('high'),
    },
    session: { id: 'parent', requestHeader: () => undefined },
  } as unknown as Agent;
  installBotSubagentModelTools(context, agent, resolvePlan, { advisor });
  return { tool: definitions.get('bot_subagent')!, start, startContinuable };
}

function invocation(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  parent: { provider: string; model: string; reasoningEffort: string } = {
    provider: 'workbuddy',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  },
): Promise<string> {
  return tool.execute(args, {
    agent: {
      id: 'parent',
      options: {
        provider: parent.provider,
        model: parent.model,
        reasoningEffort: ReasoningEffortId(parent.reasoningEffort),
      },
      session: { id: 'parent', requestHeader: () => undefined },
    },
    signal: new AbortController().signal,
  } as unknown as Parameters<ToolDefinition['execute']>[1]) as Promise<string>;
}

describe('Bot-owned DSH Subagent tools with the model advisor', () => {
  it('starts the child on the advised route inside the allowed set', async () => {
    const resolveCallConfig = vi.fn(async () => undefined);
    const advise = vi.fn(async () => advisedRoute);
    const record = vi.fn();
    const { tool, start, startContinuable } = subagentHarness(resolveCallConfig, () => ({
      advise,
      record,
    }));

    await invocation(tool, {
      description: 'Frontend form',
      prompt: 'Build the form',
      run_in_background: false,
    });

    expect(advise).toHaveBeenCalledTimes(1);
    expect(resolveCallConfig).toHaveBeenCalledTimes(1);
    expect(resolveCallConfig).toHaveBeenCalledWith(
      {
        provider: 'workbuddy',
        model: 'glm-5.3-flash',
        reasoningEffort: ReasoningEffortId('high'),
      },
      expect.any(AbortSignal),
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(startContinuable).not.toHaveBeenCalled();
    const started = start.mock.calls[0]![1] as {
      agentOptions: { provider: string; model: string; reasoningEffort?: string };
    };
    expect(started.agentOptions).toMatchObject({
      provider: 'workbuddy',
      model: 'glm-5.3-flash',
    });
  });

  it('does not consult the advisor when the caller names the model', async () => {
    const resolveCallConfig = vi.fn(async () => undefined);
    const advise = vi.fn(async () => advisedRoute);
    const { tool, start } = subagentHarness(resolveCallConfig, () => ({
      advise,
      record: vi.fn(),
    }));

    await invocation(tool, {
      description: 'Explicit',
      prompt: 'Do not advise',
      provider: 'workbuddy',
      model: 'glm-5.3-flash',
      reasoning_effort: 'high',
      run_in_background: false,
    });

    expect(advise).not.toHaveBeenCalled();
    expect(resolveCallConfig).toHaveBeenCalledWith(
      {
        provider: 'workbuddy',
        model: 'glm-5.3-flash',
        reasoningEffort: ReasoningEffortId('high'),
      },
      expect.any(AbortSignal),
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('still refuses an advised route outside the allowed set', async () => {
    const resolveCallConfig = vi.fn(async () => undefined);
    const advise = vi.fn(async () => ({
      ...advisedRoute,
      route: { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' },
    }));
    const { tool, start, startContinuable } = subagentHarness(resolveCallConfig, () => ({
      advise,
      record: vi.fn(),
    }));

    await expect(
      invocation(tool, {
        description: 'Outside the set',
        prompt: 'Do not run',
        run_in_background: false,
      }),
    ).rejects.toThrow(/not allowed/);
    expect(start).not.toHaveBeenCalled();
    expect(startContinuable).not.toHaveBeenCalled();
    expect(resolveCallConfig).not.toHaveBeenCalled();
  });

  it('falls back to the Assignment default once when the advised route is unavailable', async () => {
    const resolveCallConfig = vi.fn(async (config: { provider: string }) => {
      if (config.provider === 'workbuddy') throw new Error('Selected model is unavailable');
    });
    const advise = vi.fn(async () => advisedRoute);
    const record = vi.fn();
    const { tool, start } = subagentHarness(resolveCallConfig, () => ({ advise, record }));

    const output = await invocation(tool, {
      description: 'Frontend form',
      prompt: 'Build the form',
      run_in_background: false,
    });

    expect(resolveCallConfig).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(output).toContain('opencode-go/deepseek-v4.1-flash');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'fallback',
        reason: 'suggested-route-unavailable',
        route: 'opencode-go/deepseek-v4.1-flash (max)',
      }),
    );
  });

  it('keeps the existing failure when the advised route is the Assignment default', async () => {
    const resolveCallConfig = vi.fn(async () => {
      throw new Error('Selected model is unavailable');
    });
    const advise = vi.fn(async () => ({
      ...advisedRoute,
      route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
    }));
    const { tool, start } = subagentHarness(resolveCallConfig, () => ({
      advise,
      record: vi.fn(),
    }));

    await expect(
      invocation(tool, {
        description: 'Unavailable default',
        prompt: 'Do not run',
        run_in_background: false,
      }),
    ).rejects.toThrow('Selected model is unavailable');
    expect(resolveCallConfig).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('reads the switch on every dispatch and stops consulting when it is off', async () => {
    let on = true;
    const advise = vi.fn(async () => advisedRoute);
    const resolver = vi.fn(() => (on ? { advise, record: vi.fn() } : undefined));
    const { tool } = subagentHarness(
      vi.fn(async () => undefined),
      resolver,
    );

    await invocation(tool, { description: 'On', prompt: 'Run', run_in_background: false });
    on = false;
    await invocation(tool, { description: 'Off', prompt: 'Run', run_in_background: false });

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(advise).toHaveBeenCalledTimes(1);
  });

  it('does not start a route the current plan no longer allows', async () => {
    const narrowed: PersonaBotModelPlan = {
      revision: 4,
      sourcePresetId: 'preset',
      sourcePresetName: 'Mix narrowed',
      appliedAt: '2026-10-15T00:00:00.000Z',
      orchestrator: { provider: 'workbuddy', model: 'deepseek-v4-flash' },
      assignmentDefault: {
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        reasoningEffort: 'max',
      },
      assignmentModels: [
        {
          provider: 'opencode-go',
          model: 'deepseek-v4.1-flash',
          allowedEfforts: ['max'],
          defaultEffort: 'max',
        },
      ],
    };
    let current = wiringPlan;
    const resolveCallConfig = vi.fn(async () => {
      current = narrowed;
    });
    const advise = vi.fn(async () => advisedRoute);
    const { tool, start } = subagentHarness(
      resolveCallConfig,
      () => ({ advise, record: vi.fn() }),
      () => current,
    );

    await expect(
      invocation(tool, { description: 'Revoked', prompt: 'Do not run', run_in_background: false }),
    ).rejects.toThrow(/not allowed/);
    expect(start).not.toHaveBeenCalled();
  });

  it('dispatches the provider default when the advisor chooses the empty effort', async () => {
    const plan: PersonaBotModelPlan = {
      revision: 5,
      sourcePresetId: 'preset',
      sourcePresetName: 'Provider default',
      appliedAt: '2026-10-15T00:00:00.000Z',
      orchestrator: { provider: 'workbuddy', model: 'deepseek-v4-flash' },
      assignmentDefault: {
        provider: 'workbuddy',
        model: 'glm-5.3-flash',
        reasoningEffort: 'high',
      },
      assignmentModels: [
        {
          provider: 'workbuddy',
          model: 'glm-5.3-flash',
          allowedEfforts: ['', 'high'],
          defaultEffort: 'high',
        },
      ],
    };
    const advise = vi.fn(async () => ({
      source: 'advisor' as const,
      route: { provider: 'workbuddy', model: 'glm-5.3-flash' },
      candidateId: 'c0',
      confidence: 0.9,
    }));
    const { tool, start } = subagentHarness(
      vi.fn(async () => undefined),
      () => ({ advise, record: vi.fn() }),
      () => plan,
    );

    await invocation(tool, {
      description: 'Default effort',
      prompt: 'Run',
      run_in_background: false,
    });

    const started = start.mock.calls[0]![1] as { agentOptions: { reasoningEffort?: string } };
    expect(started.agentOptions.reasoningEffort).toBeUndefined();
  });

  it('rejects a plan that tightens again while the last probe is in flight', async () => {
    const parentAllowed: PersonaBotModelPlan = {
      revision: 10,
      sourcePresetId: 'preset',
      sourcePresetName: 'Parent allowed',
      appliedAt: '2026-10-15T00:00:00.000Z',
      orchestrator: { provider: 'workbuddy', model: 'deepseek-v4-flash' },
      assignmentDefault: {
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        reasoningEffort: 'max',
      },
      assignmentModels: [
        {
          provider: 'opencode-go',
          model: 'deepseek-v4.1-flash',
          allowedEfforts: ['max'],
          defaultEffort: 'max',
        },
        {
          provider: 'workbuddy',
          model: 'glm-5.3-flash',
          allowedEfforts: ['high'],
          defaultEffort: 'high',
        },
      ],
    };
    const defaultOnly: PersonaBotModelPlan = {
      ...parentAllowed,
      revision: 11,
      assignmentModels: [
        {
          provider: 'opencode-go',
          model: 'deepseek-v4.1-flash',
          allowedEfforts: ['max'],
          defaultEffort: 'max',
        },
      ],
    };
    const parentOnly: PersonaBotModelPlan = {
      ...parentAllowed,
      revision: 12,
      assignmentDefault: {
        provider: 'workbuddy',
        model: 'glm-5.3-flash',
        reasoningEffort: 'high',
      },
      assignmentModels: [
        {
          provider: 'workbuddy',
          model: 'glm-5.3-flash',
          allowedEfforts: ['high'],
          defaultEffort: 'high',
        },
      ],
    };
    let current = parentAllowed;
    const resolveCallConfig = vi.fn(async () => {
      if (current.revision === 10) current = defaultOnly;
      else if (current.revision === 11) current = parentOnly;
    });
    const { tool, start } = subagentHarness(
      resolveCallConfig,
      () => undefined,
      () => current,
    );

    await expect(
      invocation(
        tool,
        {
          description: 'Tightened twice',
          prompt: 'Do not run',
          run_in_background: false,
        },
        { provider: 'workbuddy', model: 'glm-5.3-flash', reasoningEffort: 'high' },
      ),
    ).rejects.toThrow(/not allowed/);
    expect(resolveCallConfig).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });

  it('C final recheck: the last-await guard preserves no-Preset implicit parent inheritance', async () => {
    const { tool, start } = subagentHarness(
      vi.fn(async () => undefined),
      () => undefined,
      () => undefined,
    );

    await invocation(tool, {
      description: 'No Preset',
      prompt: 'Run',
      run_in_background: false,
    });

    expect(start).toHaveBeenCalledTimes(1);
    const started = start.mock.calls[0]![1] as {
      agentOptions: { provider: string; model: string };
    };
    expect(started.agentOptions).toMatchObject({
      provider: 'workbuddy',
      model: 'deepseek-v4-flash',
    });
  });
});
