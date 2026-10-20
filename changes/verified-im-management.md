---
section: Fixed
---

## en

- Let explicitly verified Human WeChat DMs use Tob's existing scoped management CLI after authenticated Host confirmation, without promoting ordinary contacts or owner claims; exact account/sender/DM binding, fresh-message checks, revocation and native approval remain required, while first authority capture avoids a redundant synchronous inspection and reuse, post-approval and pre-side-effect checks remain intact ([change](https://github.com/ZhiweiWei-NAMI/DeepSeekBot/pull/2)).

## zh

- 已由认证 Host 明确确认属于同一 Human 的微信私聊可使用 Tob 既有受限管理 CLI，不再仅因 transport 被拒绝；普通联系人或自称 owner 不会提权，仍要求准确账号／发送者／DM 绑定、新消息、可撤销授权及原生审批；首次权限捕获避免重复的同步检查，复用捕获、审批后及副作用前的校验保持不变（[改动](https://github.com/ZhiweiWei-NAMI/DeepSeekBot/pull/2)）。
