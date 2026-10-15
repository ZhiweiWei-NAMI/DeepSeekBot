// Run from the repository root. Uses installed tools, no server, network, or installation.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stylexPlugin } from '../../../../scripts/stylex-plugin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const require = createRequire(resolve(root, 'package.json'));
const tools = createRequire(require.resolve('vitest/package.json'));
const { build } = await import(pathToFileURL(tools.resolve('vite')).href);
const { globSync } = await import('node:fs');
const playwright = globSync(
  'node_modules/.pnpm/playwright-core@*/node_modules/playwright-core/package.json',
  { cwd: root },
)[0];
assert(playwright, 'Use an existing playwright-core installation');
const { chromium } = require(resolve(root, dirname(playwright)));
const executablePath = process.env['ADVISOR_FIXTURE_CHROMIUM'] ?? chromium.executablePath();
// Extract the installed native Switch verbatim: avoid the primitives barrel's
// unrelated, locally missing simple-icons dependency without installing anything.
const clientRequire = createRequire(resolve(root, 'packages/client/package.json'));
const primitives = clientRequire.resolve('@deepseek-ai/dsh-client-ui-primitives');
const nativeSwitch = (await readFile(primitives, 'utf8')).match(
  /function Switch\([\s\S]*?\n}\n/,
)?.[0];
assert(nativeSwitch, 'Installed native Switch source must be recognizable');
const primitiveRequire = createRequire(primitives);
const switchModule = '\0advisor-native-switch';
const built = await build({
  configFile: false,
  root,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [
    {
      name: 'offline-native-switch-only',
      enforce: 'pre',
      resolveId(id) {
        if (id === '@deepseek-ai/dsh-client-ui-primitives') return switchModule;
      },
      load(id) {
        if (id !== switchModule) return;
        return `import { jsx } from ${JSON.stringify(clientRequire.resolve('react/jsx-runtime'))};
          import clsx from ${JSON.stringify(primitiveRequire.resolve('clsx'))};
          import css$8 from ${JSON.stringify(resolve(dirname(primitives), 'Switch.module.css'))};
          ${nativeSwitch}
          export { Switch };`;
      },
    },
    stylexPlugin({ rootDir: root }),
  ],
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  build: {
    write: false,
    minify: false,
    lib: {
      entry: resolve(here, 'subagent-advisor.tsx'),
      name: 'AdvisorFixture',
      formats: ['iife'],
    },
  },
});
const output = (Array.isArray(built) ? built[0] : built).output;
const script = output.find((item) => item.type === 'chunk').code;
const css = output
  .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
  .map((item) => item.source)
  .join('\n');
const evidence = resolve(here, '../evidence/subagent-advisor');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 800, height: 720 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => {
    errors.push(String(error));
    console.error('Offline fixture page error:', String(error));
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  // Fail any accidental external request; there is no Host, provider, or credential service.
  await page.route('**/*', (route) => route.abort());
  await page.setContent(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
    :root { color-scheme: light;
      --dsw-alias-label-primary: #242424; --dsw-alias-label-secondary: #616161;
      --dsw-alias-label-tertiary: #777; --dsw-alias-border-l1: #eee;
      --dsw-alias-state-error-primary: #b42318; --dsw-alias-bg-base: #fafafa;
      --dsw-alias-bg-module-platform: #fff; --dsw-alias-interactive-bg-active: #ddd;
      --dsw-alias-label-primary-foreground: #fff; --dsw-alias-state-business-primary: #3468d4;
      --dsw-alias-interactive-bg-hover: #eee; --dsw-radius-sm: 8px;
      --dsw-alias-border-l3: #ccc; --dsw-alias-brand-primary: #3468d4; --dsw-alias-switch-thumb: #fff;
    }
    body[data-ds-dark-theme] { color-scheme: dark;
      --dsw-alias-label-primary: #eee; --dsw-alias-label-secondary: #aaa;
      --dsw-alias-border-l1: #333; --dsw-alias-bg-base: #191919;
      --dsw-alias-bg-module-platform: #242424; --dsw-alias-state-error-primary: #ff8b82;
    }
    * { box-sizing: border-box } body { margin: 0; font: 14px/1.5 sans-serif; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base) }
    main { max-width: 760px; margin: auto; padding: 24px } header p { color: var(--dsw-alias-label-secondary); font-size: 12px }
    h1 { font-size: 20px; margin: 0 0 8px } h2 { font-size: 16px; margin: 0 }
    section { margin-top: 20px; padding: 16px; border-radius: 12px; background: var(--dsw-alias-bg-module-platform) }
    ${css}
  </style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  const ada = page.getByRole('region', { name: 'Ada', exact: true }).getByRole('switch');
  const bea = page.getByRole('region', { name: 'Bea', exact: true }).getByRole('switch');
  await ada.waitFor();
  await page.waitForFunction(() => !document.querySelector('[role="switch"]').disabled);
  assert.equal(await ada.getAttribute('aria-checked'), 'false');
  assert.equal(await bea.getAttribute('aria-checked'), 'true');
  await page.screenshot({
    path: resolve(evidence, '01-default-off.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await ada.click();
  assert.equal(await ada.getAttribute('aria-checked'), 'true');
  await page.screenshot({
    path: resolve(evidence, '02-enabled.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.evaluate(() => {
    window.advisorFixture.failNextSave = true;
  });
  await ada.click();
  await page.getByRole('alert').waitFor();
  assert.equal(await ada.getAttribute('aria-checked'), 'true');
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
  await page.screenshot({
    path: resolve(evidence, '03-save-failed-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: resolve(evidence, '04-narrow-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const calls = await page.evaluate(() => window.advisorFixture.calls);
  assert.deepEqual(
    calls.filter((call) => call.endpoint !== 'list'),
    [
      { endpoint: 'subagentAdvisorSet', payload: { slug: 'ada', enabled: true } },
      { endpoint: 'subagentAdvisorSet', payload: { slug: 'ada', enabled: false } },
    ],
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(evidence, 'result.json'),
    JSON.stringify(
      {
        scope:
          'offline fixture only; real component/native Switch; mock bridge, not Host/auth verification',
        executablePath,
        calls,
        errors,
        aria: await page.locator('main').ariaSnapshot(),
      },
      null,
      2,
    ),
  );
  console.log(`Offline advisor UI passed; screenshots: ${evidence}`);
} finally {
  await browser.close();
}
