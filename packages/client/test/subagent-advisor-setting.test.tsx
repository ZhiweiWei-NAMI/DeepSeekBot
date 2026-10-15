// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: h } = await import('react');
  return {
    Switch: ({
      checked,
      disabled,
      label,
      onChange,
    }: {
      checked: boolean;
      disabled: boolean;
      label: string;
      onChange(value: boolean): void;
    }) =>
      h('button', {
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        disabled,
        onClick: () => onChange(!checked),
      }),
  };
});

import { createActions } from '../src/client/actions.js';
import {
  loadSubagentAdvisor,
  parseBotSummary,
  setSubagentAdvisor,
  type BridgeCall,
} from '../src/client/bridge.js';
import { en, zhTranslate, type BotHarnessTranslate } from '../src/client/locale.js';
import { createStore } from '../src/client/store.js';
import { SubagentAdvisorSetting } from '../src/client/subagent-advisor-setting.js';

const bot = { slug: 'ada', displayName: 'Ada' };
const english = ((key: keyof typeof en) => en[key]) as BotHarnessTranslate;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
});

function actionsFor(call: BridgeCall) {
  return createActions(call, createStore());
}
async function render(call: BridgeCall, t = english) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const actions = actionsFor(call);
  const show = async (slug: string) => {
    await act(async () =>
      root!.render(createElement(SubagentAdvisorSetting, { slug, actions, t })),
    );
  };
  await show('ada');
  return {
    show,
    toggle: () => host.querySelector<HTMLButtonElement>('[role="switch"]')!,
    click: async () => {
      await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    },
  };
}

describe('advisor bridge read model', () => {
  it.each([undefined, false, true, 'true', 1])(
    'parses opt-in only as boolean: %s',
    async (value) => {
      const row = { ...bot, subagentAdvisor: value };
      expect(parseBotSummary(row)?.subagentAdvisor).toBe(
        typeof value === 'boolean' ? value : undefined,
      );
      const call = vi.fn<BridgeCall>(async () => ({ ok: true, value: { bots: [row] } }));
      expect(await loadSubagentAdvisor(call, 'ada')).toBe(value === true);
      expect(call).toHaveBeenCalledExactlyOnceWith('list', {}, undefined);
    },
  );

  it('writes only slug and enabled, unwraps detail.bot and respects the Host value', async () => {
    const call = vi.fn<BridgeCall>(async () => ({
      ok: true,
      value: { bot: { ...bot, subagentAdvisor: false } },
    }));
    expect(await setSubagentAdvisor(call, 'ada', true)).toBe(false);
    expect(call).toHaveBeenCalledExactlyOnceWith(
      'subagentAdvisorSet',
      { slug: 'ada', enabled: true },
      undefined,
    );
  });

  it.each([
    { ...bot, slug: 'other', subagentAdvisor: true },
    { ...bot, slug: 'other' },
    { ...bot, displayName: undefined },
    { ...bot, subagentAdvisor: 'true' },
    { ...bot, subagentAdvisor: 'false' },
    { ...bot, subagentAdvisor: null },
    { ...bot, subagentAdvisor: 0 },
    { ...bot, subagentAdvisor: 1 },
    { ...bot, subagentAdvisor: {} },
    { ...bot, subagentAdvisor: [] },
  ])('rejects malformed or wrong-Bot acknowledgements', async (row) => {
    const call: BridgeCall = async () => ({ ok: true, value: { bot: row } });
    await expect(setSubagentAdvisor(call, 'ada', true)).rejects.toThrow(
      'Invalid subagentAdvisorSet response',
    );
  });

  it('rejects unknown Bots instead of inventing their state', async () => {
    await expect(
      loadSubagentAdvisor(async () => ({ ok: true, value: { bots: [] } }), 'ada'),
    ).rejects.toThrow('PersonaBot is unavailable');
  });
});

describe('advisor opt-in UI through production actions and bridge', () => {
  it.each([english, zhTranslate])(
    'defaults off, saves on/off per Bot without a model or auth call',
    async (t) => {
      let value: boolean | undefined;
      const call = vi.fn<BridgeCall>(async (endpoint, payload) => {
        if (endpoint === 'list')
          return { ok: true, value: { bots: [{ ...bot, subagentAdvisor: value }] } };
        value = payload['enabled'] as boolean;
        // Match service summary: disabling removes the field rather than returning false.
        return {
          ok: true,
          value: { bot: { ...bot, ...(value ? { subagentAdvisor: true } : {}) } },
        };
      });
      const view = await render(call, t);
      expect(view.toggle().getAttribute('aria-checked')).toBe('false');
      expect(view.toggle().disabled).toBe(false);
      expect(host.textContent).toContain(t('subagentAdvisor.description'));
      expect(host.textContent).toContain(t('subagentAdvisor.notice'));
      await view.click();
      expect(view.toggle().getAttribute('aria-checked')).toBe('true');
      await view.click();
      expect(view.toggle().getAttribute('aria-checked')).toBe('false');
      expect(call.mock.calls.map(([endpoint, payload]) => [endpoint, payload])).toEqual([
        ['list', {}],
        ['subagentAdvisorSet', { slug: 'ada', enabled: true }],
        ['subagentAdvisorSet', { slug: 'ada', enabled: false }],
      ]);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it('stays off and disabled until its read completes', async () => {
    const pending = deferred<Awaited<ReturnType<BridgeCall>>>();
    const call = vi.fn<BridgeCall>(() => pending.promise);
    const view = await render(call);
    expect(view.toggle().disabled).toBe(true);
    expect(view.toggle().getAttribute('aria-checked')).toBe('false');
    await act(async () =>
      pending.resolve({ ok: true, value: { bots: [{ ...bot, subagentAdvisor: true }] } }),
    );
    expect(view.toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('locks a pending save, keeps last confirmed state, shows failure and never retries', async () => {
    const pending = deferred<Awaited<ReturnType<BridgeCall>>>();
    const call = vi.fn<BridgeCall>(async (endpoint) =>
      endpoint === 'list' ? { ok: true, value: { bots: [bot] } } : pending.promise,
    );
    const view = await render(call);
    await view.click();
    expect(view.toggle().disabled).toBe(true);
    expect(view.toggle().getAttribute('aria-checked')).toBe('false');
    await view.click();
    await act(async () => pending.reject(new Error('offline')));
    expect(view.toggle().disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en['subagentAdvisor.error']);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not claim enabled when the Host returns false', async () => {
    const view = await render(async (endpoint) =>
      endpoint === 'list'
        ? { ok: true, value: { bots: [bot] } }
        : { ok: true, value: { bot: { ...bot, subagentAdvisor: false } } },
    );
    await view.click();
    expect(view.toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('fails closed on a read error without a write or retry', async () => {
    const call = vi.fn<BridgeCall>(async () => ({
      ok: false,
      error: { code: 'offline', message: 'offline', details: {} },
    }));
    const view = await render(call);
    expect(view.toggle().disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en['subagentAdvisor.error']);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each(['read', 'save'])('ignores a late %s after switching Bots', async (phase) => {
    const pending = deferred<Awaited<ReturnType<BridgeCall>>>();
    let reads = 0;
    const call = vi.fn<BridgeCall>(async (endpoint) => {
      if (
        (endpoint === 'list' && ++reads === 1 && phase === 'read') ||
        endpoint === 'subagentAdvisorSet'
      )
        return pending.promise;
      return { ok: true, value: { bots: [bot, { slug: 'bea', displayName: 'Bea' }] } };
    });
    const view = await render(call);
    if (phase === 'save') await view.click();
    await view.show('bea');
    await act(async () =>
      pending.resolve({
        ok: true,
        value:
          phase === 'read'
            ? { bots: [{ ...bot, subagentAdvisor: true }] }
            : { bot: { ...bot, subagentAdvisor: true } },
      }),
    );
    expect(view.toggle().getAttribute('aria-checked')).toBe('false');
    expect(view.toggle().disabled).toBe(false);
  });
});
