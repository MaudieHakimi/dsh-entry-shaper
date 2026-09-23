# 官方栈已经做了什么（以及本插件的空位）

> 结论先行：**DSH 自带栈里已经有一个"确定性免费剪枝器"和一个"摘要压缩器"**。
> 本插件不是它们的替代品 —— 本插件的空位是**推理内容**（官方剪枝器完全不碰）
> 与**保留原文的 wire 级塑形**（压缩做不到）。
>
> 如果只想"免费省 token 且不动历史"，请先调 `tool-result-pruner` 的阈值，别开本插件。

## 1. 官方三层，各有其职

| 组件 | 位置 | 触发条件 | 代价 | 模型视角 |
|---|---|---|---|---|
| `tool-result-pruner` | `packages/bundle/base/cordis.patch.yml:358-365`（`@deepseek-ai/dsh-compaction-tool-result-pruner`） | 单条 tool result 超过 `thresholdChars`（**默认 8192**） | **零**：纯函数、逐条独立 ⇒ 前缀不破、无断点税 | 中段被换成 `[... tool result middle pruned ...]`，保留 head 4096 + tail 1024 |
| `compaction-basic` | 同上 `:284-285` | prompt 达到 `thresholdRatio × contextWindow`（**默认 0.8**），压完保留 `retainRatio`（**默认 0.16**） | 一次断点（全价重算压缩后的前缀） | 老历史被 LLM 摘要**取代**（不可逆） |
| `command-compact` | 同上 `:289-290` | 人类输入 `/compact` | 同上 | 同上 |

默认值出处：`packages/compaction/compaction-basic/src/config.ts:20,23`
（`DEFAULT_THRESHOLD_RATIO = 0.8`、`DEFAULT_RETAIN_RATIO = 0.16`）、
`packages/compaction/compaction-tool-result-pruner/src/config.ts:10-14`。

**pruner 是开着的**，不是"可选建议"：base bundle 直接把它插进树里并带上配置。

## 2. 本机实测：一次 `/compact` 的真实账单

会话 `session-acde5be7-…`（D:\DSH Desktop），2026-09-23，用户手动 `/compact`：

| 观测项 | 数值 | 来源 |
|---|---|---|
| 压缩前峰值 payload | **752,397 / 753,146** token（turn 154 step 5/6） | `assistant/message.data.usage` 的 `cacheRead + input` |
| 压缩后第一步 payload | **23,712** token（命中 17,536 / 未命中 6,176） | 同上（turn 155 step 1） |
| 官方自报 | **"Compacted 1133 history items (~539772 tokens)."** | `command/done`（seq 2579863） |
| 摘要体积 | **33,092 字符** | `compaction/summary`（seq 2579860） |
| 该会话累计 | 2,296 条带 usage 的 `assistant/message`、97,051 条事件、33.7 MB | 日志统计 |
| 该会话内的 prune 次数 | **51** 次 `compaction/prune` | 同上 |

**要点：压缩的破点税很小 —— 只有 6,176 个全价 token，而它删掉的是 539,772 个 token**
（相差 **87 倍**）。原因：留下来的那点内容（摘要）本身很小，而命中 17,536 主要是系统提示词
+ 工具目录（压缩调用自己刚用过同一前缀 ⇒ 缓存直接命中）。

⇒ 所以"压缩几乎都亏"这个判断**对逐轮小破成立，对 `/compact` 这种一次性大重置不成立**：
前者每轮付一次断点税换 30–40% 的缩减，后者一次付清换 96.9% 的缩减。

## 3. 与此同时，历史是真的丢了（对人类没丢）

- **对模型**：1,133 条历史被摘要取代 ⇒ 模型再也看不到原文（payload 从 753K 掉到 23.7K 就是证据）。
- **对人与日志**：一条事件都没少（97,051 条全在），界面仍能渲染原文。

这就是"两份副本"的现状：**原始历史留在日志/界面，模型只拿到摘要**。
所以"模型丢历史"是真的 —— 丢的就是这 1,133 条；而"渲染全部推理历史"仍然成立，因为渲染走的是日志。

## 4. 空位在哪（本插件只做这三件事）

1. **推理内容没有任何官方处理。** 本会话日志里 `reasoning-chunks` **40,916** 条
   vs `assistant/chunk` **20,570** 条 —— 推理是最大宗 payload，而 pruner 只看 tool result，
   compaction 只会"整段丢"。`policy.reasoning` 的 op 链（默认 `extract`）正打在这个空位上。
2. **按类别的策略。** pruner 只有一个全局字符阈值，不区分 reasoning / toolResult / toolArgs /
   assistantText，也不认识"这条 tool result 是 200KB 日志里的一行命中"。
3. **保留原文的出网塑形。** compaction 一旦发生就不可逆；本插件的 `proxy` 通道只改发出去的
   messages，日志与界面保留原文 ⇒ 既有缩减又不丢历史。

## 5. 怎么选

| 你的诉求 | 该用什么 |
|---|---|
| 想省 token、可以接受丢老历史 | 官方 `compaction-basic`（默认阈值 0.8 / 保留 0.16，可调） |
| 想省 token、只针对超长工具输出 | 官方 `tool-result-pruner`（调 `thresholdChars`，零成本、不破前缀） |
| 不想丢历史、只想让每轮少送一点 | 本插件的 `proxy` 通道（wire 级塑形） |
| 推理占了大头 | 本插件的 `policy.reasoning`（官方完全没覆盖） |
