import type { SubagentDispatch } from '../../src/client/subagent-dispatch.js';

// Synthetic public values only. These snapshots are NOT evidence of running jobs.
export const dispatchFixture: SubagentDispatch = {
  dispatchId: 'fixture-dispatch',
  kind: 'subagent',
  description: '复核前端白名单字段',
  status: 'running',
  revision: 1,
  updatedAt: '2026-10-15T06:00:00.000Z',
  parentSessionId: 'fixture-parent-session',
  resolvedRoute: { provider: 'example-provider', model: 'review-model', reasoningEffort: 'high' },
};

const { resolvedRoute: _route, ...withoutRoute } = dispatchFixture;

export const dispatchGallery: readonly SubagentDispatch[] = [
  {
    ...withoutRoute,
    dispatchId: 'fixture-queued',
    description: '复核前端白名单字段',
    status: 'queued',
  },
  {
    ...dispatchFixture,
    dispatchId: 'fixture-running',
    description: '检查组件可访问性',
    status: 'running',
  },
  {
    ...dispatchFixture,
    dispatchId: 'fixture-completed',
    description: '整理离线测试结果',
    status: 'completed',
  },
  {
    ...dispatchFixture,
    dispatchId: 'fixture-failed',
    description: '核对异常分支',
    status: 'failed',
    reasonCode: 'error',
  },
  {
    ...withoutRoute,
    dispatchId: 'fixture-declined',
    description: '复核不允许的模型请求',
    status: 'declined',
    reasonCode: 'route-not-allowed',
  },
  {
    ...withoutRoute,
    dispatchId: 'fixture-no-model',
    description: '缺少实际模型时不回退到 Assignment 默认模型',
    status: 'running',
  },
];
