import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { en, zhTranslate, type BotHarnessTranslate } from '../src/client/locale.js';
import { SubagentDispatchCard } from '../src/client/subagent-dispatch-card.js';
import { parseSubagentDispatch, newerSubagentDispatch } from '../src/client/subagent-dispatch.js';
import { dispatchFixture, dispatchGallery } from './fixtures/subagent-dispatch.js';

const enTranslate = ((key: string) =>
  (en as Record<string, string>)[key] ?? key) as BotHarnessTranslate;
const statuses = ['queued', 'running', 'completed', 'failed', 'declined'] as const;
const noRoute = { ...dispatchFixture, resolvedRoute: undefined };
function render(dispatch: unknown, t: BotHarnessTranslate = enTranslate): string {
  return renderToStaticMarkup(createElement(SubagentDispatchCard, { dispatch, t }));
}

describe('Host v1 public dispatch parser', () => {
  it.each(statuses)('preserves an explicit %s event', (status) => {
    expect(parseSubagentDispatch({ ...noRoute, status })?.status).toBe(status);
  });
  it.each([
    undefined,
    null,
    {},
    [],
    'Started Subagent child-1',
    { ...dispatchFixture, kind: 'assignment' },
  ])('rejects non-subagent input: %j', (value) => {
    expect(parseSubagentDispatch(value)).toBeUndefined();
  });
  it.each([undefined, 'working', 'idle', 'started', 'killed', 'unknown'])(
    'does not invent a status for %s',
    (status) => {
      expect(parseSubagentDispatch({ ...dispatchFixture, status })).toBeUndefined();
    },
  );
  it.each([
    { revision: 0 },
    { revision: -1 },
    { revision: 1.1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { updatedAt: -1 },
    { updatedAt: '' },
    { dispatchId: '' },
    { parentSessionId: '' },
    { description: 'x'.repeat(121) },
    { description: 'unsafe\ntext' },
    { description: 'unsafe\u202etext' },
  ])('rejects invalid public data: %j', (patch) => {
    expect(parseSubagentDispatch({ ...dispatchFixture, ...patch })).toBeUndefined();
  });
  it('copies only whitelisted values without reading private prompt or fallback models', () => {
    const value = {
      ...dispatchFixture,
      resolvedRoute: { ...dispatchFixture.resolvedRoute, secret: 'private' },
    };
    for (const key of ['prompt', 'args', 'output', 'error', 'requestedRoute', 'assignmentModel'])
      Object.defineProperty(value, key, {
        enumerable: true,
        get() {
          throw new Error('private field accessed');
        },
      });
    expect(parseSubagentDispatch(value)).toEqual(dispatchFixture);
  });
  it('keeps absent actual route unavailable and never falls back to requested route', () => {
    const result = parseSubagentDispatch({
      ...noRoute,
      requestedRoute: dispatchFixture.resolvedRoute,
    });
    expect(result?.resolvedRoute).toBeUndefined();
    expect(result?.status).toBe('running');
  });
  it.each([
    null,
    { model: 'requested-model' },
    { provider: 'p' },
    { provider: 'p', model: '\nsecret' },
  ])('rejects malformed actual route: %j', (resolvedRoute) => {
    expect(parseSubagentDispatch({ ...dispatchFixture, resolvedRoute })).toBeUndefined();
  });
  it('rejects unknown/raw reasons without exposing them', () => {
    const value = { ...dispatchFixture, status: 'failed', reasonCode: 'PRIVATE_RAW_ERROR' };
    expect(parseSubagentDispatch(value)).toBeUndefined();
    expect(render(value)).toBe('');
  });
  it('declined always has no route', () => {
    expect(parseSubagentDispatch({ ...dispatchFixture, status: 'declined' })).toBeUndefined();
    expect(
      parseSubagentDispatch({ ...noRoute, status: 'declined', reasonCode: 'route-not-allowed' })
        ?.reasonCode,
    ).toBe('route-not-allowed');
  });
});

describe('revision and terminal authority', () => {
  it.each([
    { status: 'queued', revision: 2 },
    { status: 'completed', revision: 1 },
    { status: 'failed', revision: 0 },
    { parentSessionId: 'different-parent', revision: 2 },
    { dispatchId: 'different-dispatch', revision: 2 },
  ] as const)('ignores stale, regressive or mismatched state: %j', (patch) => {
    expect(newerSubagentDispatch(dispatchFixture, { ...dispatchFixture, ...patch })).toBe(
      dispatchFixture,
    );
  });
  it.each(['completed', 'failed', 'declined'] as const)('never reopens terminal %s', (status) => {
    const terminal = { ...dispatchFixture, status, revision: 3 };
    expect(newerSubagentDispatch(terminal, { ...dispatchFixture, revision: 99 })).toBe(terminal);
  });
  it('accepts a newer explicit terminal event without fabricating intermediate stages', () => {
    const terminal = { ...dispatchFixture, status: 'completed' as const, revision: 2 };
    expect(newerSubagentDispatch(dispatchFixture, terminal)).toBe(terminal);
    expect(newerSubagentDispatch(undefined, terminal)).toBe(terminal);
  });
});

describe('SubagentDispatchCard', () => {
  it.each(dispatchGallery)('renders only supplied $status ($dispatchId)', (dispatch) => {
    const markup = render(dispatch);
    expect(markup).toContain(`data-dispatch-status="${dispatch.status}"`);
    expect(markup).toContain(dispatch.description);
    expect(markup).toContain('DSH Subagent');
    expect(markup).not.toContain(dispatch.parentSessionId);
    expect(markup).not.toContain(dispatch.dispatchId);
  });
  it('shows actual route and effort, never Assignment/requested models', () => {
    const markup = render({
      ...dispatchFixture,
      requestedRoute: { provider: 'requested', model: 'wrong' },
      assignmentModel: 'assignment-default',
    });
    expect(markup).toContain('example-provider/review-model');
    expect(markup).toContain('Reasoning effort');
    expect(markup).toContain('high');
    expect(markup).not.toContain('assignment-default');
    expect(markup).not.toContain('requested/wrong');
  });
  it('labels missing actual model without claiming a default', () => {
    const markup = render({ ...noRoute, assignmentModel: 'assignment-default' });
    expect(markup).toContain('Actual model');
    expect(markup).toContain('Not provided');
    expect(markup).not.toContain('assignment-default');
  });
  it.each([
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
  ])('localizes enum reason %s in both languages', (reasonCode) => {
    const value = { ...dispatchFixture, status: 'failed', reasonCode };
    expect(render(value)).not.toContain('subagentDispatch.');
    expect(render(value, zhTranslate)).not.toContain('subagentDispatch.');
  });
  it('renders Chinese state and enum reason labels', () => {
    const markup = render(
      { ...noRoute, status: 'declined', reasonCode: 'route-not-allowed' },
      zhTranslate,
    );
    expect(markup).toContain('DSH 子代理');
    expect(markup).toContain('已拒绝');
    expect(markup).toContain('请求的模型不在允许范围内。');
  });
  it('escapes public text and never renders private fields', () => {
    const markup = render({
      ...dispatchFixture,
      description: '<script>alert(1)</script>',
      prompt: 'PRIVATE_PROMPT',
      output: 'PRIVATE_OUTPUT',
      error: 'PRIVATE_ERROR',
    });
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('PRIVATE_');
  });
  it.each([
    { ...dispatchFixture, kind: 'assignment' },
    { ...dispatchFixture, status: 'unknown' },
    {},
  ])('does not render Assignment, unknown or absent state as a running Subagent', (value) => {
    expect(render(value)).toBe('');
  });
});
