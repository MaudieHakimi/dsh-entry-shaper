# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.2.0] — 2026-09-23

**桩化（stub）替代删除（drop）**，并新增"简洁便宜准确"的行为分歧基准。

### 背景：基准第一次跑就否掉了 0.1.0 的做法

`bench/divergence.mjs`（真实多轮历史）与 `bench/passback-stub.mjs` 实测发现：

- **缺 `reasoning_content` 会被 API 拒绝**，但只在"延续工具回路"时（报文以 `role:'tool'`
  结果结尾）：
  `400 The reasoning_content in the thinking mode must be passed back to the API.`
  单轮探针（1 轮工具往返、末尾带用户消息）曾返回 200，属特例，**不能代表真实会话**；
- 把推理文本换成短桩 `[reasoning omitted: N chars]` 后 **200 OK**
  ⇒ **API 要求的是字段存在，不是内容完整**。

⇒ 0.1.0 的 `drop` 在主对话路径上会把会话打挂；本版改为默认 `stub`。

### Changed

- `index.js`：新增 `reasoningMode: 'stub' | 'drop'`（默认 `stub`）与 `stubTemplate`
  （默认 `[reasoning omitted: {chars} chars]`）；多个 reasoning 块只留一个桩。
  实测体积：3,500 字符 → 31 字符（省 **99.1%**），字段保留 ⇒ 不触发 400。
- `cordis.patch.yml`：**紧急关闭**（`enabled: false`）——质量代价未确认前不默认生效。

### Added

- `bench/divergence.mjs`：行为分歧基准。从真实会话日志捞"工具往返"快照，同一前缀发两次
  （full 带完整推理 vs stub 桩化），比较下一步动作，并以**真实后续**作锚点。
  确定性打分（工具名 + 规范化参数）、无 LLM 裁判；8 case × 2 臂 = **$0.005**。
  实测结果：精确匹配一致率 **0/8**（含真实分歧：一臂继续排查、另一臂直接收工作答）；
  注意精确匹配**高估**分歧。
- `bench/passback-rule.mjs`：定位规则边界（多轮变体：全带/全不带/只带首/只带尾/中间不带）。
- `bench/passback-stub.mjs`：定位真正的触发条件并验证桩化可行（变体 H/K 复现 400，I 证明桩化通过）。
- 测试增至 **17 例**：桩化默认行为、多块只留一桩、drop 模式、drop+空内容兜底、自定义桩模板、
  provenance、usage、自激、开关、熔断、fail-open、兜底路径。

## [0.1.0] — 2026-09-23

首个可用版本（探针级）。

### Added

- **入口塑造核心**：订阅 `session/event`，在 `assistant/message` 追加后、下一次请求之前，
  追加一条同类表面事件（`surfaceOp: { op: 'replace' }`）处理 `reasoning` 块。
  时机依据：推理"生成于本次调用、首次回传于下一次请求"⇒ 定型不打断任何已发送的前缀 ⇒ **零断点税**。
- **两条硬约束**：`sourceEventSeqs` 原样沿用原事件（token-meter 校验器要求，否则抛错）；
  替换事件默认不复制 `usage`（否则同一步被计两次）。均可配置回退。
- **安全设计**：fail-open、自激保护、空内容保护、microtask 落地、
  免重启熔断 `~/.dsh-entry-shaper.OFF`、可注入 `logPath`/`offSentinel`。
- **文档**：`docs/PIPELINE.md`（工作管道 + 源码出处）、`docs/PROCESSING.md`（op 组合、槽位协议、里程碑）。
- **测试**：13 例。
