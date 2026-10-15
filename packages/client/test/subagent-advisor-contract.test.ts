import { describe, expect, it, vi } from 'vitest';

import { createBridgeMethods, type BridgeMethodsDeps } from '../../core/src/bridge/methods.js';
import type { PersonaBotRecord } from '../../core/src/bots/persona-bot.js';
import { createBotStateTracker } from '../../core/src/state/bot-state.js';
import { parseBotSummary, setSubagentAdvisor, type BridgeCall } from '../src/client/bridge.js';

function service() {
  const record: PersonaBotRecord = {
    slug: 'ada',
    displayName: 'Ada',
    workspaces: [],
    createdAt: '2026-10-15T00:00:00Z',
    subagentAdvisor: true,
  };
  const methods = createBridgeMethods({
    registry: {
      setSubagentAdvisor(slug: string, enabled: boolean) {
        if (slug !== record.slug) return { ok: false, reason: 'not-found' };

        if (enabled) record.subagentAdvisor = true;
        else delete record.subagentAdvisor;
        return { ok: true, record };
      },
    },
    states: createBotStateTracker(),
  } as unknown as BridgeMethodsDeps);
  return { record, methods };
}

describe('advisor service/client off contract', () => {
  it('accepts the actual service detail with omitted false as confirmed off', async () => {
    const { record, methods } = service();
    const response = methods.subagentAdvisorSet({ slug: 'ada', enabled: false });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.code);
    expect(record).not.toHaveProperty('subagentAdvisor');
    expect(response.value.bot).not.toHaveProperty('subagentAdvisor');
    expect(parseBotSummary(response.value.bot)?.subagentAdvisor).toBeUndefined();
    const call = vi.fn<BridgeCall>(async () => response);
    await expect(setSubagentAdvisor(call, 'ada', false)).resolves.toBe(false);
    expect(call).toHaveBeenCalledExactlyOnceWith(
      'subagentAdvisorSet',
      { slug: 'ada', enabled: false },
      undefined,
    );
  });

  it('round-trips on/off through the real service and client without network', async () => {
    const { methods } = service();
    const call: BridgeCall = async (_endpoint, payload) => {
      const response = methods.subagentAdvisorSet(payload);
      if (!response.ok) throw new Error(response.error.code);
      return response;
    };
    await expect(setSubagentAdvisor(call, 'ada', true)).resolves.toBe(true);
    await expect(setSubagentAdvisor(call, 'ada', false)).resolves.toBe(false);
  });
});
