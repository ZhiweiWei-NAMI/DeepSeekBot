import { describe, expect, it, vi } from 'vitest';

import { BotharnessBridgeService } from '../src/bridge/rpc.js';

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

interface RemoteDescriptor {
  readonly version: number;
  readonly methods: readonly { readonly method: string }[];
}

function remoteDescriptor(): RemoteDescriptor {
  const prototype = BotharnessBridgeService.prototype as unknown as Record<
    string,
    RemoteDescriptor | undefined
  >;
  const descriptor = prototype[REMOTE_METHOD_DESCRIPTOR];
  if (descriptor === undefined) throw new Error('The bridge service exposes no remote methods');
  return descriptor;
}

describe('Subagent model advisor bridge registration', () => {
  it('marks subagentAdvisorSet as a remote method', () => {
    expect(remoteDescriptor().methods.map((entry) => entry.method)).toContain('subagentAdvisorSet');
  });

  it('forwards the toggle to the owning bridge method', () => {
    const subagentAdvisorSet = vi.fn(() => ({
      ok: true as const,
      value: { bot: { slug: 'advisor-qa' } },
    }));
    const result = BotharnessBridgeService.prototype.subagentAdvisorSet.call(
      { methods: { subagentAdvisorSet } },
      'advisor-qa',
      true,
    );
    expect(subagentAdvisorSet).toHaveBeenCalledWith({ slug: 'advisor-qa', enabled: true });
    expect(result).toEqual({ bot: { slug: 'advisor-qa' } });
  });
});
