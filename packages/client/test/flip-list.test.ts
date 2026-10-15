// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useFlipList } from '../src/client/flip-list.js';

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const animate = vi.fn();
  let ancestorScroll = 0;
  let panelTop = 100;
  let reduced = false;
  const positions: Record<string, number> = { a: 0, b: 40 };
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const list = host!.querySelector<HTMLElement>('[data-list]')!;
    const key = this.dataset['flipKey'];
    const top =
      panelTop - ancestorScroll + (key === undefined ? 0 : positions[key]! - list.scrollTop);
    return { top } as DOMRect;
  });
  function List({ keys }: { keys: string[] }) {
    return createElement(
      'div',
      { ref: useFlipList<HTMLDivElement>(), 'data-list': '' },
      keys.map((key) =>
        createElement(
          'div',
          {
            key,
            'data-flip-key': key,
            ref: (node: HTMLDivElement | null) => {
              if (node !== null) node.animate = animate;
            },
          },
          key,
        ),
      ),
    );
  }
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return {
    animate,
    positions,
    scrollAncestor: (top: number) => {
      ancestorScroll = top;
    },
    movePanel: (top: number) => {
      panelTop = top;
    },
    reduceMotion: (value: boolean) => {
      reduced = value;
    },
    render: async (keys = ['a', 'b']) => {
      await act(async () => root!.render(createElement(List, { keys })));
    },
    list: () => host!.querySelector<HTMLElement>('[data-list]')!,
  };
}

it('does not animate unchanged rows after ancestor scrolling and catalog rerenders', async () => {
  const f = fixture();
  await f.render();
  const row = f.list().firstElementChild;
  for (const top of [240, 370, 270, 0]) {
    f.scrollAncestor(top);
    await f.render();
  }
  expect(f.animate).not.toHaveBeenCalled();
  expect(f.list().firstElementChild).toBe(row);
});

it('ignores scrolling in the list itself and preserves its scroll position', async () => {
  const f = fixture();
  await f.render();
  f.list().scrollTop = 120;
  await f.render();
  expect(f.animate).not.toHaveBeenCalled();
  expect(f.list().scrollTop).toBe(120);
});

it('ignores whole-panel movement without a row reorder', async () => {
  const f = fixture();
  await f.render();
  f.movePanel(260);
  await f.render();
  expect(f.animate).not.toHaveBeenCalled();
});

it('still animates a real reorder by its list-local delta while scrolled', async () => {
  const f = fixture();
  await f.render();
  f.scrollAncestor(240);
  f.positions['a'] = 40;
  f.positions['b'] = 0;
  await f.render(['b', 'a']);
  expect(f.animate.mock.calls.map(([frames]) => frames)).toEqual([
    [{ transform: 'translateY(40px)' }, { transform: 'translateY(0)' }],
    [{ transform: 'translateY(-40px)' }, { transform: 'translateY(0)' }],
  ]);
  expect(f.animate.mock.calls[0]![1]).toEqual({
    duration: 220,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
  });
});

it('respects reduced motion and updates the baseline without animating newly inserted rows', async () => {
  const f = fixture();
  await f.render();
  f.reduceMotion(true);
  f.positions['a'] = 40;
  f.positions['b'] = 0;
  await f.render(['b', 'a']);
  expect(f.animate).not.toHaveBeenCalled();
  f.reduceMotion(false);
  f.positions['c'] = 80;
  await f.render(['b', 'a', 'c']);
  expect(f.animate).not.toHaveBeenCalled();
});
