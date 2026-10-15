# Bot 回复速度（tokens/s）core→client 遥测契约 v2

状态：core 侧已实现并测试；字段与语义以下列**本仓 pinned DSH `0.2.0-rc.2` 源码逐条核对**为准。
v1 草案中的若干断言未经源码证实，已在 §8 列出勘误。前端契约（`ChannelMessage.perf` 六字段）与 v1 一致，未变。

侧别：采集与写入在 `packages/core/**`（本文件同侧）；展示在 `packages/client/**`（另一侧，本契约只描述接口）。

## 1. 字段（`ChannelMessage` 可选字段，core 与 client 两份类型同步）

```ts
/** Turn 级生成性能快照；只出现在已提交的 Bot 回复消息上，草稿/流式中不带。 */
perf?: {
  /** 产生该回复的 Session id（快照所属 Session，等于消息发送方 Session）。 */
  sessionId: string;
  /** 该 Session 内的 turn 序号（`assistant/message.data.turn`，非负安全整数）。 */
  turn: number;
  /** 计入本快照的结算样本 provider outputTokens 之和；>0 才写。 */
  outputTokens: number;
  /** 对应样本 decode 段墙钟之和（首 token → assistant/message.time），毫秒；>0 才写。 */
  decodeMs: number;
  /** 本 turn 首步 TTFT（step/start → 首 token），毫秒；该步无 token delta 时为 null。 */
  ttftMs: number | null;
  /** 计入的结算样本数（多步 turn >1）；等于 outputTokens/decodeMs 的配对次数。 */
  steps: number;
};
```

## 2. 数据源（仅这些事实被采用；其余不推断）

| # | 事实（已核） | 证据位置（本仓 pinned `0.2.0-rc.2`） |
| --- | --- | --- |
| 1 | Bot 回复进 Channel 的唯一模型侧通道是 `channel_send` 工具；assistant 纯文本不投递 | `packages/core/src/runtime/dsh-bot-agent-adapter.ts`（channel_send 工具定义与 `execute`） |
| 2 | `step/start` data=`{turn, step}`，`event.time` = 该步开始时刻 | `@deepseek-ai/dsh-agent-loop/lib/index.js:968-971` |
| 3 | `assistant/attempt` data=`{turn, step, stream}`；`llm/retry` 的多次 attempt 共享同一步 | 同上 `:1101`、`:1106`、`:1119` |
| 4 | `assistant/message` data=`{turn, step, message, usage?, stream, interrupted?}`，`event.time` = 结算时刻；**`usage` 仅在 provider 上报时存在** | 同上 `:1086`、`:1144-1150` |
| 5 | **本步 `assistant/message` 先 append，随后才 `executeToolCalls`**：工具执行时本步结算已落库 | 同上 `:1144` 之后为 `executeToolCalls`（`step()` 内顺序） |
| 6 | `session.append` 在 append 内**同步**派发 `session/event`（`invokeContainedSessionObservers`），非微任务延迟 | `@deepseek-ai/dsh-session/lib/index.js:1450-1474` |
| 7 | 首 token = attempt/message 的 `stream` 中首个 token delta；由 `assistantStreamFirstTokenTime` 还原（其 `isTokenDelta` 含 text-delta、reasoning-delta 与 tool-call-delta 的 name/args 片段） | `@deepseek-ai/dsh-llm/lib/types/assistant-stream.js:185-195`、`:266-275` |
| 8 | 官方折叠 `sessionStats`：`llm`=step/start→message；`firstToken = open.firstTokenTime ?? assistantStreamFirstTokenTime(stream) ?? null`；**只有 `usage.outputTokens` 为有限非负数时才累加 `decodeMs`/`decodeTokens`**，`decodeMs = max(0, message.time - firstToken)`；TTFT = step/start→首 token | `@deepseek-ai/dsh-session-stats/lib/index.js:60-62`、`:85-125` |
| 9 | `TokenUsage` 字段**互斥**（`inputTokens` 只含未缓存输入，缓存单独上报）；文档**没有**说明 `reasoningTokens` 是否包含在 `outputTokens` 内 | `@deepseek-ai/dsh-llm/lib/types/types.d.ts:155-176` |
| 10 | Host 分发点：`ctx.on('session/event', ...)` 同步段已同时喂 activity 与 usage，本契约在同一段喂 perf 折叠 | `packages/core/src/plugin.ts:1993-2015` |
| 11 | `channel_send` / `bot_dm_send` 用 `exec.callId` 作为 `deliveryKey` | `packages/core/src/runtime/dsh-bot-agent-adapter.ts:3343`（bot_dm_send）、`:3454`（channel_send） |
| 12 | Group 与 Bot-DM 的消息 id = `bot-sha256(sessionId, deliveryKey)`（幂等重发同 id）；**Human DM 用随机 id，不做 deliveryKey 去重**，deliveryKey 只用于「先告知再发」的时序门 | `packages/core/src/runtime/bot-runtime.ts:5985-5994`（`#deliveryMessageId`）、`:5783`（Human DM 构造） |

## 3. 采集与关联键

- 折叠单元：`(sessionId, turn)`，实现于 `packages/core/src/usage/message-perf.ts`（`createMessagePerfTracker`）。
- 喂入：`plugin.ts` 的 `session/event` 同步监听（§2 #10 同一段），因此 `channel_send` 在稍后执行时**本步结算已被折叠**。
- 事件去重：按 `seq` 单调去重（`seq <= lastSeq` 直接忽略）；首次观测的事件只作为基线，因此中途挂载或恢复 Session 不产生「缺口」误判；**已建基线后出现 `seq` 跳号**则本 turn 标记不可靠，不再产出快照（宁缺）。
- 结构匹配：`assistant/attempt` / `assistant/message` 只对**当前打开的步**（`(turn, step)` 相同）生效；同一步的重复结算按 `step` 再挡一次。
- 发送边界（对齐 `channel_send` 的 turn 内位置）：快照在**发送那一刻**取值，等于 `step 0..当前步` 的累计；**当前步之后的 step 与他 turn 不计入**，也**不做迟到修订**——由 §2 #5/#6 保证工具执行时本步结算已可见地先到。
- `turn/end` 丢弃该 Session 的折叠；`agent/disposed` 再清一次（`plugin.ts:2054`），因此折叠内存只随活动 Session 增长。

### 3.1 不写 `perf` 的情形（宁缺，不造值）

| 情形 | 依据 |
| --- | --- |
| 发送时没有打开的 step（如 `deepseekbot` CLI 直调 `channel_send`：`runDirectBotTool` 用 `direct-<uuid>` 会话，永无 turn 事件） | 无 turn 可言 |
| 本 turn 首个被观测的 step 不是 step 0（中途挂载/丢事件），无法诚实地给「首步 TTFT」 | 首步未知 |
| 事件 `seq` 缺口使本 turn 累计不可靠 | 可能漏样本 |
| 结算无 `usage`（provider 未上报）或无首 token（纯 `usage` 结束块等） | 官方折叠同规则，且无配对样本 |
| `decodeMs <= 0`（首 token 与结算同刻）或 `outputTokens <= 0` | 不构成速率 |
| `interrupted` 结算 | 与官方一致地只读 `turn/step/time/usage/stream`，不做特殊假设；被中止的步若根本没有 `assistant/message`（只有 `assistant/attempt`），自然不计入 |
| 流式草稿（`channel/draft`，`packages/core/src/channels/draft.ts`） | 草稿不是 `ChannelMessage`，永不携带 `perf` |
| Host 自发的 turn 内通知（如记忆分支切换的 `channels.send({body})`，无 `deliveryKey`，也不经两个回复工具） | 非模型回复投递 |

`reasoningTokens` 既不加也不减：契约只使用 provider 报告的 `outputTokens` 原值（§2 #9）。因此 `outputTokens` 是否含 reasoning 取决于 provider，属未证实事实，不在两端做任何换算。

## 4. 计量定义

- 显示速率 = `outputTokens / (decodeMs / 1000)` tok/s（前端 `packages/client/src/client/message-perf.ts`）。
- 分母只含 decode 段墙钟：**不含 TTFT、不含工具耗时、不含步间间隔**；禁止用 `message.at` 差值或端到端时间做分母。
- TTFT 单独展示，不混入分母。
- 一个样本「成对」计入：有有效 `usage.outputTokens` **且** 有可还原首 token，才同时累加 `outputTokens` 与 `decodeMs`，并使 `steps += 1`。
- `ttftMs` 取本 turn **首步**（该 loop 每 turn 从 `step = 0` 开始）的 `step/start → 首 token`；该步无 token delta 时为 `null`，UI 略过。

## 5. 写入点（core）

| 位置 | 行为 |
| --- | --- |
| `packages/core/src/usage/message-perf.ts` | 折叠与快照（唯一计算处） |
| `packages/core/src/plugin.ts:986/1007/2013/2054` | 创建 tracker、注入 adapter、喂事件、丢弃已释放 Session |
| `packages/core/src/runtime/dsh-bot-agent-adapter.ts:3475-3478` | `#sendPerf(sessionId)` 读当前 turn 快照 |
| 同上 `:3343`（`bot_dm_send`）、`:3454`（`channel_send`） | 仅这两个模型回复投递携带 `perf` |
| `packages/core/src/runtime/bot-runtime.ts:5765/5783/5891/6044` | Human DM / Group / Bot-DM 三类消息构造点落库（Human DM 幂等无 id 绑定时仍落库） |

## 6. 前端接口（准确、与冻结前端一致）

- 消息定位：按 `(channelId, message.id)`；`perf` 是消息自身字段，随消息读写、持久化与桥接原样传输（store 的 `isChannelMessage` 不校验也不剥除 `perf`；`appendMessageOnce` 的 `sameMessageIntent` 不含 `perf`，重发不会因快照不同而报冲突）。
- 展示规则：`outputTokens > 0 && decodeMs > 0` 才有速率；否则与缺 `perf` 一样静默不显示（core 侧已保证不会写不可显示的快照，前端保留隐藏兜底即可）。
- `ttftMs === null` 时略过 TTFT。
- 旧消息、流式草稿、失败消息天然无 `perf`，不需要迁移或回填。
- 格式照抄官方 `formatTokensPerSecond`：`>=10` 取整，`<10` 保留 1 位小数，负值钳 0；文案 `{tps} tok/s`。

## 7. 验收（core 侧已完成）

`packages/core/test/message-perf.test.ts`（13 项，全绿）：

| 覆盖 | 用例 |
| --- | --- |
| 基本折叠 | 单样本 usage+首 token → `{40, 400ms, ttft 600ms, steps 1}` |
| provider 原值 | usage 带 `reasoningTokens: 7` 时 `outputTokens` 仍为 40（不做 reasoning 运算） |
| 去重 | 同事件重放（同 `seq`）与同 `(turn,step)` 重复结算都只计 1 次 |
| 分步 | 同 turn 两步求和 100 tokens / 800ms，`steps 2`，TTFT 仍取首步 |
| 重试 | 同一步 `llm/retry`，首 token 取最早一次（TTFT 650ms / decode 350ms） |
| 缺 usage / 失败 / 无首 token / 非法 usage | 四种情形均无快照 |
| 零分母 | 首 token 与结算同刻 → 无快照 |
| 边界 | 步已关闭、turn 未从 step 0 观测、`seq` 缺口 → 无快照 |
| 跨 turn / 跨 Session | turn/end 后清除；两 Session 互不可见；新 turn 从零折叠 |
| 快照稳定性 | 同一时刻两次读取同值（两次发送同值），`clear` 后消失 |
| 真实 Host 接线 | `FakeAgentHost` + 真实 `plugin` 接线跑一轮真人 DM：消息携带正确 `perf`；真人消息无 `perf`；`runDirectBotTool` 直调 `channel_send` 不借上一条 turn 的值 |
| 跨 turn 不污染 + 两次发送 | 第二轮 step0+step1 两步求和（30 tokens/600ms/steps 2），第一轮消息保持自己的值；同一步两次 `channel_send` 两条消息同一快照 |

命令：`./node_modules/.bin/vitest run packages/core/test/message-perf.test.ts`；`./node_modules/.bin/tsc --noEmit`；`./node_modules/.bin/oxlint`、`oxfmt --check` 干净。

## 8. v1 勘误（已在本版修正）

| v1 断言 | 实际情况 |
| --- | --- |
| 「`reasoningTokens` 不单独区分（已含在 provider `outputTokens` 内；桶互斥）」 | 无依据。`TokenUsage` 只说明各桶互斥，未说明 reasoning 与 output 的包含关系 → 本版只用 `outputTokens` 原值，不做任何 reasoning 换算 |
| 「`assistant/message` data = `{turn, step, message, usage?, stream}`」 | 补充 `interrupted?`；且 `usage` 缺省就是缺省，不可回退到别处猜 |
| 「usage 也可从 stream 内最后一条 `type:'usage'` chunk 读取（core 现行 `reportedBuckets` 已这样做）」 | 那是 usage 计费投影的做法；本契约**不**采用回退（缺 `usage` 即不写 `perf`），以免与官方 `sessionStats` 口径分叉 |
| 「关联键：(sessionId, turn)」隐含「按 turn 汇总整轮」 | 实际边界是**发送时刻**：`channel_send` 晚于它的 step 不计入。这一刻由 §2 #5/#6 保证，不需要迟到修订 |
| 「`channel_send` 在 Session 内执行，host 实现处可取当前 turn（唯一需要后端确认的接线点）」 | 已确认：`ToolRunContext` 不带 turn，正确做法是在 `session/event` 同步段折叠、由回复投递读快照；直调（无 turn）则宁缺 |
| 「流式期间（draft）不含 `perf`，最终修订含」 | 草稿机制与本字段无关：`perf` 只出现在已提交的 `ChannelMessage`，不存在「修订」路径 |
