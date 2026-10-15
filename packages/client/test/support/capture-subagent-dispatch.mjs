// Captures the actual React component, not a drawing or a full DSH instance.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { aliases, tools, stylexCompiler } from './subagent-dispatch-tooling.mjs';

const { build } = tools('esbuild');
const { chromium } = process.env.BH_PLAYWRIGHT_MODULE
  ? await import(process.env.BH_PLAYWRIGHT_MODULE)
  : tools('playwright');
const compiler = stylexCompiler();
const output = fileURLToPath(new URL('../evidence/subagent-dispatch/', import.meta.url));
await mkdir(output, { recursive: true });
const result = await build({
  entryPoints: [
    fileURLToPath(new URL('../fixtures/subagent-dispatch-preview.tsx', import.meta.url)),
  ],
  bundle: true,
  write: false,
  jsx: 'automatic',
  alias: aliases,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'real-component-stylex',
      setup(builder) {
        builder.onLoad({ filter: /\.[jt]sx?$/ }, async ({ path }) => {
          if (path.includes('/node_modules/')) return;
          return {
            contents: await compiler.transform(await readFile(path, 'utf8'), path),
            loader: path.endsWith('x') ? 'tsx' : 'ts',
          };
        });
      },
    },
  ],
});
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({
    viewport: { width: 720, height: 900 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  // Fixture-only palette supplies DSH token values without shell/avatar dependencies.
  await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    :root{color-scheme:light;--dsw-alias-bg-base:#f5f5f5;--dsw-alias-bg-module-platform:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#62666d;--dsw-alias-state-business-primary:#245dce;--dsw-alias-state-success-primary:#15723e;--dsw-alias-state-error-primary:#ba2535;--dsw-alias-state-warn-primary:#8c5c00;--dsw-radius-md:12px}
    :root[data-theme="dark"]{color-scheme:dark;--dsw-alias-bg-base:#18191b;--dsw-alias-bg-module-platform:#242629;--dsw-alias-label-primary:#eceef1;--dsw-alias-label-secondary:#a9afb8;--dsw-alias-state-business-primary:#8cb2ff;--dsw-alias-state-success-primary:#6ed599;--dsw-alias-state-error-primary:#ff8995;--dsw-alias-state-warn-primary:#e3bd69}
    *{box-sizing:border-box}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:system-ui,sans-serif}main{max-width:720px;padding:24px;margin:auto}h1{font-size:16px;line-height:24px;font-weight:500;margin:0 0 8px}.fixture-note{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:4px 0}.fixture-cards{display:grid;gap:12px;margin-top:20px}
    ${compiler.css()}
  </style><div id="fixture"></div></html>`);
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.locator('[data-dispatch-kind="subagent"]').last().waitFor();
  assert.equal(await page.locator('article').count(), 6);
  for (const status of ['queued', 'running', 'completed', 'failed', 'declined'])
    assert((await page.locator(`[data-dispatch-status="${status}"]`).count()) > 0);
  const text = await page.locator('main').innerText();
  assert(!text.includes('fixture-parent-session'));
  assert(!text.includes('fixture-dispatch'));
  assert(!text.includes('subagentDispatch.'));
  assert.equal(
    await page
      .locator('article')
      .first()
      .innerText()
      .then((text) => text.includes('未提供')),
    true,
  );
  const metrics = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.screenshot({ path: output + theme + '.png', fullPage: true });
    await writeFile(output + theme + '.aria.txt', await page.locator('main').ariaSnapshot());
    metrics.push(
      await page
        .locator('article')
        .first()
        .evaluate((element) => ({
          theme: document.documentElement.dataset.theme,
          background: getComputedStyle(element).backgroundColor,
          color: getComputedStyle(element).color,
          padding: getComputedStyle(element).padding,
          radius: getComputedStyle(element).borderRadius,
        })),
    );
  }
  await page.setViewportSize({ width: 360, height: 900 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'narrow fixture must wrap without horizontal scrolling');
  assert.deepEqual(errors, []);
  await writeFile(
    output + 'result.json',
    JSON.stringify(
      {
        scope: 'synthetic fixture; actual React component; no Host or end-to-end proof',
        cards: 6,
        metrics,
        narrowOverflow: overflow,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, cards: 6, narrowOverflow: overflow, pageErrors: errors }));
} finally {
  await browser.close();
}
