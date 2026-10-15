import { createRoot } from 'react-dom/client';
import { SubagentDispatchCard } from '../../src/client/subagent-dispatch-card.js';
import { zhTranslate } from '../../src/client/locale.js';
import { dispatchGallery } from './subagent-dispatch.js';

createRoot(document.getElementById('fixture')!).render(
  <main>
    <h1>Bot 聊天 · 子代理派遣</h1>
    <p className="fixture-note">脱敏离线组件样例 · 非运行状态 / 非端到端验证</p>
    <p className="fixture-note">仅呈现显式事件；与 Assignment 分开，不展示私密 prompt。</p>
    <section aria-label="派遣状态样例" className="fixture-cards">
      {dispatchGallery.map((dispatch) => (
        <SubagentDispatchCard key={dispatch.dispatchId} dispatch={dispatch} t={zhTranslate} />
      ))}
    </section>
  </main>,
);
