---
Status: 待审阅
Date: 2026-10-15
Branch: `feature/dsh-auto-advisor`（独立克隆，未公开提交）
Spec: [dsh-auto-advisor.md](./dsh-auto-advisor.md)
---

# dsh-auto 模型顾问移植：审阅与本地接入说明

本文件是给人工审阅用的中文交接说明。完整规格、出处证据表和测试清单见英文姊妹篇
[dsh-auto-advisor.md](./dsh-auto-advisor.md)。

## 1. 术语澄清（不猜名，全部有出处）

| 用户说法 | 准确含义 | 出处 |
| --- | --- | --- |
| 「jev 模型」 | `jev-1.13-free`，OpenCode 提供的**评分/选择模型**（不是文本生成模型），是 Magpie Auto 的 decider | 用户仓库 `dsh-auto/README.md:3,47,53`；`jev_opt/jev-free-check/docs-verification.json` |
| 「system-one 建议」 | System One 原语 API，端点 `https://opencode.ai/inference/v1/systemone`，文档为 `docs.typesafe.ai/primitives/{noul,choice,score}`；请求体字段 `model` / `state` / `questions` | `jev_opt/jev-free-check/jev_free.py:21-25,87-114` |
| 三种问法 | `noul`=是/否概率；`choice`=从选项描述映射里选一个键；`score`=有序等级打分 | 同上 `docs-verification.json` |
| choice 的回答形状 | `{ choice: <criterion 键>, confidence: number }` | `dsh-auto/decisions.js:51`（`owner.choice === 'shared'`、`owner.confidence`） |
| 「一次建议」 | 一次 `choice` 调用，一次回答，一次决策；不递归、不多轮 | 本提案的硬约束 |

所以用户要的「一次轻量顾问调用建议 model+effort」，落到实现上就是：**把该 Bot 允许的候选配置枚举出来，作为一次 `choice` 问题的 criteria 映射发出去，拿回一个候选 id。**

## 2. 上游核实与许可

| 项 | 结果 |
| --- | --- |
| 上游仓库 | `https://github.com/BotHarness/DeepSeekBot` 用 `git ls-remote` 复核可达，HEAD `06d952f67786d66bee232df4cc70ccb06ac56c02` |
| 本地克隆 | `/mnt/data2/weizhiwei/dsh-auto-advisor`（独立克隆，`--filter=blob:none`），分支 `feature/dsh-auto-advisor`，基于上述 HEAD |
| 许可 | 上游 MIT © 2026 BotHarness；`dsh-auto` MIT © 2026 Zhiwei Wei → 兼容，可复用其技术 |
| 复用方式 | 只复用**技术思路与协议知识**（固定免费模型、固定端点、拒绝重定向、无重试、state 字节预算、置信度门槛），不复制其代码文件 |

未改动：本机运行中的 DSH 安装、Memory 目录、其他贡献目录、工作区其他仓库。

## 3. 后端边界

只动两个既有接缝，且都不改变它们的契约：

- `packages/core/src/models/presets.ts` — `assignmentModelsOf` / `selectAssignmentRoute` / `PersonaBotModelPlan`，**「这个 Bot 允许用什么」的唯一权威**。
- `packages/core/src/models/subagent-route.ts` — `resolveSubagentRoute`，**父路由被校验的唯一位置**。

新增（纯逻辑、依赖注入、可离线测试）：

```
packages/core/src/models/subagent-advisor.ts
```

接线（小改动）：

```
packages/core/src/runtime/subagent-model-tools.ts   // installBotSubagentModelTools 增加可选第 4 参数
```

**不新增** Host bridge 方法、`/api` 路由或 Bot 工具 → 本 PR 不触发 CLI 对齐义务。后续加开关的 PR 需要补 `deepseekbot` CLI 命令。

### 顾问没有权限

顾问只输出一个**候选 id**，随后必须再经 `selectAssignmentRoute` 按 `assignmentModelsOf(plan)` 重新解算。任何不在集合内的建议都会被拒绝，与显式指定模型的效果一致。它不能改 Tool Approval、Workspace Grant、预算、子代理深度上限或工具守卫。

### 决策流程（开关开启且调用方未指定模型字段时）

1. 无 modelPlan → 不咨询顾问，行为不变。
2. 候选集 = `assignmentModelsOf(plan)` 按计划顺序展开成 `(provider, model, effort)` 三元组，上限 24 个。候选 ≤1 或 >24 → 直接回退，**零次**顾问调用。
3. **不做缓存、不做单飞。** 顾问是「每次派遣一次」的决策：每次走到这一步的派遣准备恰好发**一次**请求，跨派遣不复用任何结果，因此不同任务不可能拿到别的任务的答案。
4. 构造一个 `choice` 问题，按字节预算序列化，经注入的 transport 发送，超时用 `AbortSignal.any([调用方信号, 超时])`。**只尝试一次，没有任何重试路径。**
5. 校验回答：`choice` 必须精确等于枚举出的候选 id，`confidence` 必须是 `[0,1]` 内的有限数且不低于阈值 `0.5`。否则确定性回退。
6. 用 `selectAssignmentRoute` 重新解算；越界会抛错并降级为回退。
7. 接线用既有的 `llm.resolveCallConfig` 探测最终路由（每条路径只探测一次）。若「被建议的路由」不可用，则回退一次到**无字段解析**——即既有 `resolveSubagentRoute` 行为：当前计划仍允许父路由就用父路由，否则用 Assignment 默认值——并记录原因 `suggested-route-unavailable`，再探测该路由；若重新解析出的正是刚刚失败的那个路由，原错误原样抛出。
8. 每条路径都发出**一条**结构化记录。

### 回退是确定且封闭的

```
disabled | no-plan | single-candidate | state-budget
timeout | transport-error | invalid-response | unknown-candidate
invalid-confidence | low-confidence | not-allowed | cancelled
suggested-route-unavailable
```

顾问自身在回退结果里报告的路由恒为 `selectAssignmentRoute(plan, plan.assignmentDefault)`。派遣层刻意不更聪明：它用无字段重新解析，即完全沿用既有 `resolveSubagentRoute` 行为——父路由仍被允许就继续用父路由，否则落到 Assignment 默认值。没有任何路径会发明路由，也没有任何路径会重试顾问。

**启动前会再读一次计划**，用当前允许集合重新校验选中的路由：在顾问或探测进行期间被撤销的模型不会被启动；如果路由因此发生变更，会再探测一次才使用。

### 可观测性

每次决策一条记录，经注入的有界 sink 写出，**不含任务正文、不含秘密**：

```
{ source, reason, tool, planRevision, candidateId?, confidence?,
  route, cached, calls, latencyMs, candidates, labelHash }
```

本 PR 经 `ctx.logger` 输出；写入运行日志面（`logs.db`，可用 `reading-operational-logs` 技能读取）放在配置 PR 里，因为那里 Host 才持有日志句柄。

### 成本与爆炸半径

- 每次派遣准备最多**一次**顾问请求，所有路径都是如此，且没有重试。
- 最坏新增延迟：一次性 `4000ms` 超时，然后回退。
- 回滚：完全没有持久化，撤掉 PR 即回到当前行为。

## 4. 前端契约（交 GLM，只改 `packages/client`）

后端已全部实现；GLM 只加复选框与文案。

### 4.1 桥方法

- 名称：`subagentAdvisorSet`
- 入参：`{ slug: string; enabled: boolean }`，两者必填；缺失或类型不符返回 `invalidInput('slug and enabled are required')`
- 返回：`{ ok: true, value: { bot: PersonaBotDetail } }`；未知 Bot 返回标准 `unknownBot(slug)` 拒绝
- 语义：`enabled: true` 写入该字段；`false` **删除**该字段（不是写 `false`）
- 幂等：重复设同值成功，且不改动记录其它字段

### 4.2 读模型字段

- `PersonaBotDetail.subagentAdvisor?: boolean`（`PersonaBotSummary` 上同样存在）
- 序列化规则：**仅当为 true 时出现**；关闭时该键不存在
- 前端必须把「键缺失」当作 `false`
- 已经随 `get` / `list` / 任何返回 Bot detail 的既有方法一起返回，无需新增读接口

### 4.3 默认值

默认**关**（字段不存在即为关）。

### 4.4 限制

- 顾问只在该 Bot 有 Assignment model plan、且展开后的 `(provider, model, effort)` 候选数 **≥ 2** 时才可能被调用；候选 ≤ 1 时零调用。
- 顾问的建议必须落在该 Bot 的允许集合内；前端文案不得暗示可以扩大允许集合。
- 文案不得声称已测得质量提升，只能说明选择被委派给顾问。
- 凭据引用 **`OPENCODE_CONSOLE_API_KEY`** 未配置前，顾问必然回退，并记录 `transport-error`。**在配置之前，UI 与任何报告都不得声称顾问已端到端工作。**
- 前端只加复选框 + 一行说明：不新增存储、不新增读接口、不改 `packages/client` 以外的目录。

### 4.5 client 侧接入形态（照既有 wrapper 写法）

```ts
export async function setSubagentAdvisor(
  call: BridgeCall,
  slug: string,
  enabled: boolean,
): Promise<PersonaBotDetailView> {
  const value = asRecord(await unwrap(call, 'subagentAdvisorSet', { slug, enabled }));
  const bot = asRecord(value?.['bot']);
  if (bot === undefined) throw new Error('Invalid Subagent advisor result');
  return bot as PersonaBotDetailView;
}
```

### 4.6 命令行入口（后端已实现，供手工验证）

```
deepseekbot advisor-enable <id> [--home <dsh-home>]
deepseekbot advisor-disable <id> [--home <dsh-home>]
```

`--home` 走离线 registry；不指定 `--home` 但指定 `--host` 时走在线 RPC（`subagentAdvisorSet` 已在 `packages/core/src/bridge/rpc.ts` 注册为 remote method）。开关在**每次派遣准备**时读取一次，因此关掉后立即不再咨询。

## 5. 依赖关系

| 依赖 | 状态 |
| --- | --- |
| 上游 HEAD `06d952f6` 作为基线 | 已确认 |
| `pnpm install`（`@deepseek-ai/dsh-*@0.2.0-rc.2` 来自 npm） | 本机已装成功（1m20s） |
| 本地工具链 | Node v22.23.2（仓库要求 ≥22.16）、pnpm 12.4.2、vitest 5.0.1 |
| pnpm 12.4.2 与 corepack 0.32.0 不兼容 | 已知坑：corepack 找不到 `bin/pnpm.cjs`。绕过方式见 §6 |
| 顾问端点可达性 | **本机不可达**：`opencode.ai` 返回 Cloudflare 403（`error_code 1010`）。因此测试全部离线注入，端点不可达时走确定性回退 |
| 顾问凭据引用 `OPENCODE_CONSOLE_API_KEY` | **待你接入**（跨 provider 认证字段） |
| 前端复选框 | 依赖 GLM 的独立 PR；后端开关已可用，本 PR 不依赖它 |

## 6. 本地验证接入步骤（不改运行中的安装）

本任务**不替换**正在运行的 GUI，也不合并其他工作树。要本地验证，按下面顺序做，全程可回滚：

```bash
# 0) 准备：corepack 0.32.0 认不出 pnpm 12 的布局，直接用固定版本入口
export PNPM12=~/.cache/node/corepack/v1/pnpm/12.4.2/bin/pnpm.mjs

# 1) 独立克隆 + 分支（已完成，重来一次的话）
cd /mnt/data2/weizhiwei
git clone --filter=blob:none https://github.com/BotHarness/DeepSeekBot.git dsh-auto-advisor
cd dsh-auto-advisor && git checkout -b feature/dsh-auto-advisor

# 2) 装依赖 + 跑后端测试（离线、不联网顾问）
node $PNPM12 install --frozen-lockfile
node node_modules/vitest/vitest.mjs run packages/core/test/subagent-advisor.test.ts \
  packages/core/test/subagent-model-tools.test.ts packages/core/test/subagent-route.test.ts

# 3) 仓库门禁
node scripts/check-source-policy.mjs
node scripts/check-adr-numbers.mjs
node scripts/check-cli-parity.mjs
node scripts/ci-plan.mjs --base origin/main

# 3.5) 打开/关闭某 Bot 的顾问开关（离线可用，不需要 UI；入口见 docs/bot-cli.md）
#   deepseekbot advisor-enable <bot-id> [--home <dsh-home>]
#   deepseekbot advisor-disable <bot-id> [--home <dsh-home>]

# 4) 起一个隔离的 Host 做人工验证（不碰运行中的安装）
#    见 AGENTS.md「Local DSH development」：用隔离 DSH_HOME + 独立端口
node scripts/dev-instance.mjs --home /tmp/dsh-advisor-home --port 8791 --worktree . --build
```

回滚：`git checkout main && git branch -D feature/dsh-auto-advisor`，删掉 `/tmp/dsh-advisor-home` 即可；运行中的 profile 与安装从未被写入。

### 运行中的 GUI 为什么不受影响

`dev-instance.mjs` 用独立的 `DSH_HOME`、独立端口和本 worktree 的 Bundle，只链接本 worktree 的产物；它不接受、也不修改当前 3080 端口那个实例的 profile。要停就停它自己的 PID。

## 7. 四个 PR 如何本地合并验证

**推荐：每个 PR 一个独立分支 + 一个本地集成分支，绝不把它们的改动互相 rebase 进彼此的分支。**

```bash
git checkout -b integration/local-4pr main
for b in pr1 pr2 pr3 pr4; do git merge --no-ff "$b" -m "integrate $b"; done
```

纪律：

1. **只在集成分支上合并**。各 PR 分支保持只含自己的 diff，便于单独审阅与单独回退。
2. **一个一个合，每合一个就跑一次门禁**。冲突第一次出现时停下，别连续合。
   ```bash
   node node_modules/vitest/vitest.mjs run <该 PR 影响的测试目录>
   node scripts/check-cli-parity.mjs && node scripts/check-adr-numbers.mjs
   ```
3. **冲突高发区先认领**，避免互相覆盖：`CHANGELOG.md`/`CHANGELOG.zh.md` 与 `changes/` 片段、`docs/adr/` 编号、`scripts/cli-parity-baseline.json`、`packages/core/src/plugin.ts`。ADR 编号撞车用 `node scripts/check-adr-numbers.mjs` 立刻能发现。
4. **验证用隔离 Host，不用运行中的实例**：集成分支上跑 `dev-instance.mjs` 起一个新端口，人肉验收；不要为了验证去替换 3080 上的 GUI。
5. **本任务不合并任何未完成工作**。`feature/dsh-auto-advisor` 不会被合进别人的分支，也不会替别人合并。集成分支只在用户批准后建立。

## 8. 风险

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 顾问端点由第三方控制，当前本机 403 不可达 | 功能等于不生效 | 惰性默认关闭 + 确定性回退；不作为正确性依赖 |
| 顾问可能压低正确率（原型明确未证明 Auto 优于原生） | 选型变差、成本变高 | 默认关闭；文案不得声称质量提升；建议仍需 `resolveCallConfig` 探测 |
| 任务标签可能夹带秘密 | 泄露给第三方 | 结构化保证：默认只发工具名+标签，不发 prompt 正文；标签先脱敏再截断；transport 拒绝非固定端点/模型且拒绝重定向 |
| 「建议路由不可用 → 回退默认」使一次派遣探测两次 | 语义变化 | 已在提案中标为待人工确认项；另一种选择是原样硬失败 |
| 「每次一次建议」的语义 | 无缓存导致的偏差 | 已按你的要求删掉正/负缓存、单飞与候选上限：每次派遣准备恰好一次请求，跨派遣不复用 |
| 未加 change 片段 | `pnpm changelog:check` 需要每个条目带 Issue/PR 链接，本地无 issue 号 | 提交前补：开 issue → 加 `changes/<issue>-subagent-model-advisor.md`（双语、两个 `- ` 条目、同一链接） |
| ADR 编号 0209 与其他未完成 PR 撞车 | lint 失败 | 合入前重跑 `node scripts/check-adr-numbers.mjs`，撞车就顺延 |
| 浮点/阈值调参未标定 | 回退过于频繁或过于激进 | 阈值沿用原型的置信度门槛 0.5，并在文档中标注「启发式、非标定最优」 |

## 9. 待人工确认项

1. **建议路由不可用时是否回退到 `assignmentDefault`**（一次派遣两次探测），还是保持原样硬失败？当前实现按前者。
1b. **顾问凭据**：请把 `OPENCODE_CONSOLE_API_KEY` 接到一个可解析的凭据引用；在那之前顾问必然回退。
2. 是否允许把任务正文的**截断摘录**发给顾问（当前默认不发，只发短标签）。
3. 公开提交前需要：确认 `jev-1.13-free` 的使用条款与端点可达性、开 GitHub issue、补 change 片段、定 ADR 编号。
