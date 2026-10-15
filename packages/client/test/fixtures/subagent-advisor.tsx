import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  loadSubagentAdvisor,
  setSubagentAdvisor,
  type BridgeCall,
} from '../../src/client/bridge.js';
import { zhTranslate } from '../../src/client/locale.js';
import { SubagentAdvisorSetting } from '../../src/client/subagent-advisor-setting.js';

const css = document.createElement('style');
css.textContent = '@bh-stylex-css';
document.head.append(css);

const fixture = {
  failNextSave: false,
  calls: [] as { endpoint: string; payload: Record<string, unknown> }[],
  bots: [
    { slug: 'ada', displayName: 'Ada', subagentAdvisor: false },
    { slug: 'bea', displayName: 'Bea', subagentAdvisor: true },
  ],
};
Object.assign(window, { advisorFixture: fixture });
const call: BridgeCall = async (endpoint, payload) => {
  fixture.calls.push({ endpoint, payload });
  if (endpoint === 'list') return { ok: true, value: { bots: fixture.bots } };
  if (endpoint !== 'subagentAdvisorSet') throw new Error(`Unexpected endpoint: ${endpoint}`);
  if (fixture.failNextSave) {
    fixture.failNextSave = false;
    return {
      ok: false,
      error: { code: 'offline-fixture', message: 'Simulated offline failure', details: {} },
    };
  }
  const bot = fixture.bots.find((bot) => bot.slug === payload['slug']);
  if (!bot) throw new Error('Unknown fixture Bot');
  bot.subagentAdvisor = payload['enabled'] === true;
  return { ok: true, value: { bot } };
};
const actions = {
  subagentAdvisor: (slug: string) => loadSubagentAdvisor(call, slug),
  setSubagentAdvisor: (slug: string, enabled: boolean) => setSubagentAdvisor(call, slug, enabled),
};

createRoot(document.getElementById('root')!).render(
  createElement(
    'main',
    null,
    createElement(
      'header',
      null,
      createElement('h1', null, 'Bot 模型设置'),
      createElement('p', null, '离线 UI fixture · 模拟 bridge · 未验证认证或真实 Host'),
    ),
    ...fixture.bots.map((bot) =>
      createElement(
        'section',
        { key: bot.slug, 'aria-label': bot.displayName },
        createElement('h2', null, bot.displayName),
        createElement(SubagentAdvisorSetting, { slug: bot.slug, actions, t: zhTranslate }),
      ),
    ),
  ),
);
