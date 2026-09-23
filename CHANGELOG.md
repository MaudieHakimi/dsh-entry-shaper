# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.4.0] — 2026-09-23

**处理层落地：从"扁平枚举"改成"按类别可组合的 op 序列"**（此前只有规范、没有实现）。

### 背景（用户指出的文档与实现脱节）

`docs/PROCESSING.md` 写的是 op 组合 + 多类别策略，但 0.3.x 的实现只有一句
`if (reasoningMode === 'stub' || 'extract')`，配置里也只有一个枚举值 —— 规范没有落地。

### Added

- **op 内核**：`OPS`（`keep` / `drop` / `stub` / `extract` / `head` / `tail` / `truncate`）
  与 `applyOps(text, ops, ctx)`（导出）。op 是"文本 → 文本"的纯函数，可任意链式组合
  （如 `extract → truncate`）；未知 op 跳过（fail-open）；返回 `null` 表示整块删除。
- **按类别策略** `policy: { reasoning, toolResult, toolArgs, assistantText }`，每类一条 op 序列；
  未列出的类别不动。
- **tool 结果塑形**：`policy.toolResult` 现在**真的生效**（此前配置暴露了旋钮但内核只处理
  `assistant/message`，即"摆了个不生效的开关"）。实现为同类事件替换
  （`tool/result` + `surfaceOp: replace` + `sourceEventSeqs: [seq]`，沿用现有插件的生产用法）。
- **tool 参数塑形**：`policy.toolArgs` 作用于 `tool-call` 块的 `arguments` 字段。
- **无变化即跳过**：整条消息没有任何内容需要改时**不产生替换事件**（避免无谓事件）。

### Fixed

- 兼容分支的判据错误：原实现看**合并后**的 `cfg.policy`（默认里永远有 `reasoning`），
  导致 legacy `reasoningMode` **被静默忽略**；改为看用户传入的 `config`。
- `extract` op 默认带 `[reasoning extract: N chars omitted]` 前缀 —— 与基准实测的形态保持一致
  （"测的形态必须等于跑的形态"）；`{ op: 'extract', marker: false }` 可关闭。

### 语义变化（测试同步）

- reasoning 按**块**逐个处理（不再把多块折叠成一个桩）；
- **reasoning 永远不会被整块删除**：`drop` 对它无效，内核会退回短桩（缺字段会被 API 400）。

### 测试 27/27

新增 5 例：链式 op、`policy.reasoning` 链式生效、tool 结果 truncate（含同类替换与 provenance）、
全 keep 时不产生事件、未知 op fail-open / drop 返回 null。

## [0.3.0] — 2026-09-23

**新增决策抽取（`reasoningMode: extract`）**：按句式挑句子，而不是按位置截断。
实测同批 case 配对比较中每一档一致率都 ≥ 纯桩（动作类型 15/17 vs 12/17、同名工具 6/17 vs 2/17），
体积只多花 1.8 个百分点（−36.2% vs −38.0%）⇒ 默认改为 extract。
同日 0.3.1 把 `reasoningMode: extract` 写进 patch。

## [0.2.0] — 2026-09-23

**桩化（stub）替代删除（drop）**，并新增行为分歧基准。

- 实测发现缺 `reasoning_content` 只在"延续工具回路"（报文以 `role:'tool'` 结果结尾）时被 400 拒绝；
  换成短桩即 200 ⇒ **API 要求字段存在，不要求内容完整** ⇒ 0.1.0 的 drop 会打挂会话，改为 stub。
- 新增 `bench/divergence.mjs`（四档一致率）、`bench/passback-rule.mjs`、`bench/passback-stub.mjs`。
- 在线成本 A/B 不可信（provider 缓存在多次运行间复用），自校验条款：
  **两臂共享前缀 ⇒ 未命中必须相等**。

## [0.1.0] — 2026-09-23

首个可用版本（探针级）：入口塑造核心（`session/event` + `surfaceOp: replace`）、
两条硬约束（provenance 原样沿用、不复制 usage）、fail-open 与免重启熔断、
`docs/PIPELINE.md` 与 `docs/PROCESSING.md`、13 例测试。
