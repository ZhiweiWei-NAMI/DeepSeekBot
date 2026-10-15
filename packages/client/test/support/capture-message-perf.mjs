import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const modules = new URL('../../../../node_modules/.pnpm/', import.meta.url);
const installed = (await readdir(modules)).find((name) => name.startsWith('playwright-core@'));
assert.ok(installed, 'Use an already installed playwright-core; this script never downloads it.');
const require = createRequire(new URL(`${installed}/node_modules/package.json`, modules));
const { chromium } = require('playwright-core');
const directory = new URL('../artifacts/message-perf/', import.meta.url);
const browser = await chromium.launch({
  ...(process.env['BH_PERF_CHROMIUM'] ? { executablePath: process.env['BH_PERF_CHROMIUM'] } : {}),
  headless: true,
  args: ['--no-sandbox'],
});
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 760, height: 760 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(new URL('fixture.html', directory).href);
  assert.equal(await page.locator('[data-message-perf]').count(), 2);
  assert.equal(await page.locator('section').nth(1).locator('[data-message-perf]').count(), 0);
  assert.equal(await page.locator('section').nth(2).locator('[data-message-perf]').count(), 0);
  assert.match(await page.locator('[data-message-perf]').first().innerText(), /50 tok\/s/);
  const measurements = [];
  for (const [theme, width] of [
    ['light', 760],
    ['dark', 760],
    ['light', 360],
  ]) {
    await page.setViewportSize({ width, height: 760 });
    await page.evaluate((dark) => {
      document.body.toggleAttribute('data-ds-dark-theme', dark);
    }, theme === 'dark');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `${theme} ${width}px overflow`);
    measurements.push({
      theme,
      width,
      overflow,
      perf: await page
        .locator('[data-message-perf]')
        .first()
        .evaluate((node) => ({
          color: getComputedStyle(node).color,
          fontSize: getComputedStyle(node).fontSize,
        })),
    });
    await page.screenshot({
      path: fileURLToPath(new URL(`${theme}-${width}.png`, directory)),
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    new URL('browser-evidence.json', directory),
    JSON.stringify(
      { kind: 'offline synthetic fixture, not live Host proof', errors, measurements },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { screenshots: ['light-760.png', 'dark-760.png', 'light-360.png'], errors, measurements },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
