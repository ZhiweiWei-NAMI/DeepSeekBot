// @vitest-environment jsdom
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ChannelMessageBody } from '../src/client/channel-message-body.js';
import { parseChannelMessage, parseChannelMessages } from '../src/client/bridge.js';
import { en, zhTranslate, type BotHarnessTranslate } from '../src/client/locale.js';
import { CSS } from '../src/client/styles.js';
import type { ChannelMessage } from '../src/client/store.js';
import { measuredMessage, measuredPerf } from './support/message-perf-fixture.js';

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: () => null,
  FileTypeIcon: () => null,
  fileSizeText: () => '',
  IconDownloadOutlineRegular: () => null,
  IconPlayOutlineRegular: () => null,
  IconPauseOutlineRegular: () => null,
  IconEllipsisOutlineRegular: () => null,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  Modal: () => null,
  StateDot: () => null,
  Button: ({ children }: { children: ReactNode }) => createElement('button', null, children),
}));

const enTranslate = ((key: keyof typeof en, params?: Record<string, unknown>) => {
  let text: string = en[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {}))
    text = text.replaceAll(`{${name}}`, String(value));
  return text;
}) as BotHarnessTranslate;

function render(message: ChannelMessage, t: BotHarnessTranslate = zhTranslate): string {
  return renderToStaticMarkup(createElement(ChannelMessageBody, { message, t }));
}

describe('message performance through the real client boundary', () => {
  it('survives history parsing and renders milliseconds as tok/s', () => {
    const wire = JSON.parse(JSON.stringify(measuredMessage()));
    const message = parseChannelMessages({ messages: [wire] })[0]!;
    expect(message.perf).toEqual(measuredPerf);
    expect(render(message)).toContain('50 tok/s · 首 token 0.4s · 2 步');
    expect(render(message, enTranslate)).toContain('50 tok/s · first token 0.4s · 2 steps');
  });

  it('ignores malformed optional measurements without dropping the message', () => {
    const message = parseChannelMessage({ ...measuredMessage(), perf: { outputTokens: 100 } });
    expect(message?.body).toBe('The result is ready.');
    expect(message?.perf).toBeUndefined();
    expect(render(message!)).not.toContain('data-message-perf');
  });

  it.each([{ streaming: true }, { pending: true }, { unconfirmed: true }, { failed: 'offline' }])(
    'drops wire telemetry for a nonterminal message %j',
    (state) => {
      const message = parseChannelMessage({ ...measuredMessage(), ...state })!;
      expect(message.perf).toBeUndefined();
      expect(render(message)).not.toContain('data-message-perf');
    },
  );

  it.each([
    { streaming: true },
    { pending: true },
    { unconfirmed: true },
    { failed: 'offline' },
    { author: { kind: 'human' } },
    { perf: { ...measuredPerf, decodeMs: 0 } },
    { perf: { ...measuredPerf, outputTokens: 0 } },
  ] satisfies Partial<ChannelMessage>[])('does not render invented values: %j', (overrides) => {
    expect(render(measuredMessage(overrides))).not.toContain('data-message-perf');
  });

  it('omits unavailable TTFT and single-sample detail', () => {
    const html = render(measuredMessage({ perf: { ...measuredPerf, ttftMs: null, steps: 1 } }));
    expect(html).toContain('50 tok/s');
    expect(html).not.toContain('首 token');
    expect(html).not.toContain(' 步');
  });

  it('keeps legacy messages silent and never exposes association IDs', () => {
    const legacy = parseChannelMessage({
      id: 'legacy',
      at: 'fixture-time',
      author: { kind: 'bot', slug: 'fixture-bot' },
      body: 'Done',
    })!;
    expect(render(legacy)).not.toContain('data-message-perf');
    expect(render(measuredMessage())).not.toContain(measuredPerf.sessionId);
  });

  it('exports an explicitly synthetic offline visual fixture on request', () => {
    if (process.env['BH_PERF_FIXTURE'] !== '1') return;
    const rows = [
      ['Measured completion / 已结算', measuredMessage()],
      ['Streaming — no rate / 流式不造值', measuredMessage({ streaming: true })],
      [
        'Missing telemetry / 缺计量',
        parseChannelMessage({
          id: 'legacy',
          at: 'fixture-time',
          author: { kind: 'bot', slug: 'fixture-bot' },
          body: 'The result is ready.',
          format: 'text',
        })!,
      ],
      [
        'No TTFT / 无首 token 时间',
        measuredMessage({ perf: { ...measuredPerf, ttftMs: null, steps: 1 } }),
      ],
    ] as const;
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Offline message performance fixture</title><style>
      :root { --dsw-alias-label-primary: #202124; --dsw-alias-label-secondary: #55595f; --dsw-alias-label-tertiary: #636971; --dsw-alias-bg-base: #fff; }
      body { margin: 0; padding: 24px; font: 14px/1.5 system-ui, sans-serif; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
      body[data-ds-dark-theme] { --dsw-alias-label-primary: #e5e7eb; --dsw-alias-label-secondary: #aab1bb; --dsw-alias-label-tertiary: #a0a6af; --dsw-alias-bg-base: #17191d; }
      h1 { font-size: 18px; margin: 0 0 8px; } p { margin: 0 0 20px; color: var(--dsw-alias-label-secondary); } section { padding: 16px 0; border-top: 1px solid var(--dsw-alias-label-tertiary); } h2 { font-size: 12px; font-weight: 500; margin: 0 0 12px; color: var(--dsw-alias-label-secondary); }
      ${CSS}
    </style><body><h1>Bot reply speed · 离线视觉夹具</h1><p>Synthetic usage: 120 tokens / 2400 ms = 50 tok/s. Production message component + CSS; not live backend evidence.</p>${rows.map(([label, message]) => `<section><h2>${label}</h2>${render(message)}</section>`).join('')}</body></html>`;
    const directory = join(dirname(fileURLToPath(import.meta.url)), 'artifacts/message-perf');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'fixture.html'), html);
  });
});
