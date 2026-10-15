import { fileURLToPath } from 'node:url';
import { aliases, repoRoot, stylexCompiler } from './subagent-dispatch-tooling.mjs';

const compiler = stylexCompiler();
export default {
  root: repoRoot,
  cacheDir: fileURLToPath(new URL('../.tools/node_modules/.cache/vite', import.meta.url)),
  plugins: [
    {
      name: 'subagent-dispatch:offline-stylex',
      enforce: 'pre',
      async transform(code, id) {
        const filename = id.split('?')[0];
        if (!/\.[jt]sx?$/.test(filename) || filename.includes('/node_modules/')) return null;
        return { code: await compiler.transform(code, filename), map: null };
      },
    },
  ],
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: Object.entries(aliases).map(([name, replacement]) => ({
      find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      replacement,
    })),
  },
  test: {
    maxWorkers: 1,
    setupFiles: ['packages/client/test/support/subagent-dispatch-offline-setup.ts'],
    fileParallelism: false,
    include: [
      'packages/client/test/subagent-dispatch*.test.{ts,tsx}',
      'packages/client/test/channel-live.test.ts',
      'packages/client/test/messaging-defaults-live.test.ts',
    ],
    env: { DO_NOT_TRACK: '1' },
  },
};
