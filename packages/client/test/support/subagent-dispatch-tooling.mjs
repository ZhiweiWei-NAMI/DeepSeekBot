import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const local = createRequire(new URL('../.tools/package.json', import.meta.url));
export const tools = process.env.BH_FRONTEND_NODE_MODULES
  ? createRequire(resolve(process.env.BH_FRONTEND_NODE_MODULES, '../package.json'))
  : local;
const stylexTools = process.env.BH_STYLEX_NODE_MODULES
  ? createRequire(resolve(process.env.BH_STYLEX_NODE_MODULES, '../package.json'))
  : local;

const host = process.env.BH_HOST_NODE_MODULES
  ? createRequire(resolve(process.env.BH_HOST_NODE_MODULES, '../package.json'))
  : tools;

export const aliases = {
  '@botharness/pixel-banner': host.resolve('@botharness/pixel-banner'),
  react: tools.resolve('react'),
  'react/jsx-runtime': tools.resolve('react/jsx-runtime'),
  'react/jsx-dev-runtime': tools.resolve('react/jsx-dev-runtime'),
  'react-dom/client': tools.resolve('react-dom/client'),
  'react-dom/server': tools.resolve('react-dom/server'),
  '@stylexjs/stylex': stylexTools.resolve('@stylexjs/stylex'),
};

export function stylexCompiler() {
  const { transformAsync } = stylexTools('@babel/core');
  const stylexBabel = stylexTools('@stylexjs/babel-plugin');
  const rules = new Map();
  return {
    async transform(code, filename) {
      if (!code.includes('@stylexjs/stylex')) return code;
      const result = await transformAsync(code, {
        filename,
        babelrc: false,
        configFile: false,
        plugins: [
          [stylexTools('@babel/plugin-syntax-typescript'), { isTSX: filename.endsWith('x') }],
          ...(filename.endsWith('x') ? [stylexTools('@babel/plugin-syntax-jsx')] : []),
          stylexBabel.withOptions({
            dev: false,
            test: false,
            runtimeInjection: false,
            classNamePrefix: 'bhx',
            styleResolution: 'property-specificity',
            treeshakeCompensation: true,
            unstable_moduleResolution: { type: 'commonJS', rootDir: repoRoot },
          }),
        ],
      });
      rules.set(filename, result?.metadata?.stylex ?? []);
      return result?.code ?? code;
    },
    css() {
      return stylexBabel.processStylexRules([...rules.values()].flat(), { useLayers: false });
    },
  };
}
