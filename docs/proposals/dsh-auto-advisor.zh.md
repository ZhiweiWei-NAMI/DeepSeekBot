---
Status: 已实现；待上游审阅
Date: 2026-10-15
---

# Bot 子代理的一次性模型顾问

英文契约见 [dsh-auto-advisor.md](./dsh-auto-advisor.md)。本功能默认关闭，
为每次符合条件的派遣请求一次结构化建议，在该 Bot 已获准的 Assignment model/effort
组合中选择；不是规划器，也不授予权限。显式指定模型字段时不咨询顾问。

## 权限与生命周期

- `assignmentModelsOf`、`selectAssignmentRoute`、`resolveSubagentRoute` 仍是路由授权边界。
  顾问只能返回枚举候选 id，不能自行构造路由。
- 候选按计划顺序展开；不超过一个候选时零请求。无候选数量上限、缓存、单飞、重试、递归或跨任务复用。
  序列化 state 的预算为 24,000 字节，超预算不请求。
- 回答必须命中候选且置信度为 `[0, 1]` 内有限值、不低于 `0.5`；此阈值是启发式，不是质量保证。
- 顾问请求的 4,000ms 截止时间包含凭据读取；过期结果丢弃，迟到的凭据不得启动网络请求。
  这不是整个子代理生命周期或后续路由探测的超时上限。
- 每次派遣准备动态读开关；异步建议和探测后重新读计划，在最后一次 await 后再次校验允许集合。
  已撤销的路由不能启动子代理。关闭开关不会取消已经启动的子代理。
- 不改变 Tool Approval、Workspace Grant、预算、深度限制或子代理守卫。

## 回退与观测

顾问自身回退结果报告 Assignment 默认值；派遣层仍用既有无字段解析：父路由仍被允许就继承，
否则用 Assignment 默认值。被建议的路由不可用时按该规则回退一次并探测；若仍是同一失败路由，
原错误直接抛出。计划变化可能要求再次探测，之后仍需最终允许集合校验。

回退原因是固定代码，完整列表见英文契约。结构化日志通过注入 sink 和 `ctx.logger` 输出，
只记录来源、原因、工具、计划版本、路由、请求次数、耗时、候选数、标签哈希及可选候选 id/置信度，
不记录原始任务文本或凭据值。路由不可用的派遣层回退可以另记一条；没有 `cached` 字段。

## 传输与隐私

端点固定为 `https://opencode.ai/inference/v1/systemone`，模型固定为 `jev-1.13-free`，
只发一次 System One `choice`，拒绝重定向，响应读取上限为 64,000 字节。
凭据引用 `OPENCODE_CONSOLE_API_KEY` 由平台凭据服务解析，不直接读凭据文件。

生产接线不发送 prompt 正文或 fork 上下文；发送工具名、有界标签和含备注的候选列表。
标签与备注经过已知秘密模式脱敏，标签截断至 500 字符。**脱敏不能保证任意自由文本绝无隐私**：
启用第三方顾问时，不要在派遣标签或模型备注里放敏感信息。

凭据缺失、传输失败、回答无效或低置信度均回退。离线测试不证明端点可用性、条款、价格或选型质量，
不得声称 Auto 优于原生路由，也不得让顾问成为正确性依赖。

## 设置与 CLI

- PersonaBot 持久化、detail 与 summary 使用 `subagentAdvisor?: boolean`；仅暴露/存储 `true`，缺失即关闭。
- `subagentAdvisorSet({ slug, enabled })` 返回更新后的 Bot detail；关闭时删除字段。
- Client 已包含模型配置页中的原生开关，不另建权限或状态存储。
- `deepseekbot advisor-enable <id>` / `deepseekbot advisor-disable <id>`；`--home` 操作离线 registry，
  `--host` 使用 Host RPC。详见 [CLI 指南](../bot-cli.zh.md) 与
  [ADR-0212](../adr/0212-a-subagent-model-advisor-may-only-pick-from-the-allowed-set.md)。
- 可选开关字段不需要数据迁移；撤回功能即可恢复原行为。

## 验证与出处

英文契约给出聚焦测试命令。现有离线测试覆盖候选、预算、超时/迟到凭据、响应校验、任务隔离、
显式路由旁路、动态开关、计划撤销、RPC/CLI 持久化和 Client 解析。
截图夹具使用内存 bridge 并阻断外部请求，不是实际 Host 或 provider 验收；实际结果以对应提交的证据为准。

设计借鉴 MIT 许可的 `dsh-auto`（© 2026 Zhiwei Wei）的结构化选择思路；BotHarness 为 MIT
许可（© 2026 BotHarness）。复用协议知识与设计思路，未复制原型源码文件。
