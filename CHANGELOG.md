# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.1.0] — 2026-09-23

首个可用版本（探针级，仅一项塑形动作）。

### Added

- **入口塑造核心**：订阅 `session/event`，在 `assistant/message` 追加后、下一次请求之前，
  追加一条同类表面事件（`surfaceOp: { op: 'replace' }`）摘掉 `reasoning` 块。
  时机依据：推理"生成于本次调用、首次回传于下一次请求"⇒ 定型不打断任何已发送的前缀 ⇒ **零断点税**。
- **两条硬约束的落实**：`sourceEventSeqs` 原样沿用原事件（token-meter 校验器要求，否则抛错）；
  替换事件默认不复制 `usage`（否则同一步被计两次）。两者均可配置回退。
- **安全设计**：fail-open（异常只写日志）、自激保护（只处理 `surfaceOp === 'append'`）、
  空内容保护（摘空补空 `text` 块）、microtask 落地（避免事件发布中嵌套派发）、
  免重启熔断 `~/.dsh-entry-shaper.OFF`、可注入 `logPath`/`offSentinel`。
- **文档**：`docs/PIPELINE.md`（当前工作管道 + 源码出处）、`docs/PROCESSING.md`
  （op 组合、`shaper` 槽位协议、LLM op 口径、里程碑 M1–M5）。
- **测试**：`test/shaping.test.mjs` 13 例（定型正确性、provenance、usage、自激、空内容、
  开关、熔断、fail-open、兜底路径）。

### Verified

- 判定性实验（同机 `.research/probe-reasoning-passback.mjs`）：DeepSeek 接受"带 `tool_calls`
  但缺 `reasoning_content`"的 assistant 消息（200 OK，回答正确）；旁证：同一报文
  `miss=250 hit=128` ⇒ 前缀缓存按逐字前缀命中。

### Known limitations

- **质量影响未测**：模型下一次调用看不到自己刚生成的推理，行为影响需 A/B；
- 仅处理 `reasoning`；tool 结果（21.4%）与 tool 参数（40.2%）尚未塑形；
- 未实现 `shaper` 槽位与 `report-only` 模式（见 `docs/PROCESSING.md` M4）。
