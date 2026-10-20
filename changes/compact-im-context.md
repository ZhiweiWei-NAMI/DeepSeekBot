---
section: Changed
---

## en

- Shortened external IM Inbox context by keeping message content and useful sender, quote and attachment context once; routing and authorization metadata remain Host-owned and available on demand, without repeating delivery instructions for every message. External automatic finals now explicitly share the existing 4000-code-unit text budget, refuse overlength delivery without closing the source, and direct longer answers to the existing file path ([compact IM context](https://github.com/ZhiweiWei-NAMI/DeepSeekBot/pull/4)).

## zh

- 精简外部 IM 的 Inbox 上下文，正文及必要的发送人、引用和附件信息只保留一份；路由与授权元信息仍由 Host 保存并按需读取，不再为每条消息重复注入发送指令。外部自动 final 明确沿用既有 4000 代码单元正文预算，超限拒绝且不结清来源，长文走现有文件交付路径（[精简 IM 上下文](https://github.com/ZhiweiWei-NAMI/DeepSeekBot/pull/4)）。
