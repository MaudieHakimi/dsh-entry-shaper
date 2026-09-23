# 工作管道（当前实际在跑的路径）

> ⚠️ **2026-09-23 重大修正**：`assistant/message` **无法**用 `surfaceOp: replace` 替换 ——
> session 端要求 `sourceEventSeqs` 含被替换节点自身，token-meter 端要求每一项都是同 step 的
> `assistant/chunk`，两者矛盾（现场报 `must include every shadowed surface node`）。
> 因此**推理不再走表面替换**，改由 `llm/stream` 中间件在**进入会话之前**处理：
> 攒起 reasoning chunk → 推理结束时只吐出一个经 op 链处理的 chunk。
> 代价：推理不再进入会话，**界面/历史也看不到推理**。
> 表面层只保留**合法**的那条：`tool/result` 的同类替换。
>
> 下面其余内容描述的是"表面层定型"的通用机制（对 `tool/result` 仍成立），推理路径以本条为准。

> 本文描述**今天真实生效**的管道，不是规划；规划中的 op 见 `PROCESSING.md`。

---

## 1. 总图

```
┌─ 会话日志（append-only，永不变；审计与人类历史的唯一真相）───────────────────────┐
│ 17…570  assistant/chunk × N   570  assistant/message{reasoning, text, tool-call} │
└──────────────────────────────────────────────────────────────────────────────────┘
        │ ① 事件发布：ctx.on('session/event', (session, event), { global: true })
        ▼
┌─ dsh-entry-shaper ───────────────────────────────────────────────────────────────┐
│ 过滤  type === 'assistant/message' ?           否 → return                       │
│       surfaceOp === 'append' ?（自激保护）      否 → return（含本插件自己造的替换）│
│       content 里有 reasoning 块 ?              否 → return                       │
│ 定型  kept = content 去掉全部 reasoning 块                                        │
│       provenance = 原样沿用 event.sourceEventSeqs   ← token-meter 校验器要求       │
│       data 不复制 usage                            ← 否则同一步被计两次            │
│       kept 为空 → 补 [{ type:'text', text:'' }]     ← 官方要求 content 或 tool_calls│
│ 落地  queueMicrotask(() => session.append('assistant/message', data, {           │
│              surfaceOp: { op:'replace', start: seq, end: seq },                  │
│              sourceEventSeqs: provenance }))                                     │
│ 失败  任何异常 → 写日志、保持原样（fail-open，绝不进事件派发链）                     │
└──────────────────────────────────────────────────────────────────────────────────┘
        │ ② 追加一条"替换副本"（model-only）
        ▼                     ┌───────────────────────────────┐
        ├────────────────────►│ 模型可见表面 deriveMessages()   │
        │                     │ 折叠 surfaceOp ⇒ 被替换区间让位  │
        │                     │ = [S][T][U][1'][2']…[k']        │
        │                     └───────────────┬───────────────┘
        │                                     │ ③ 下一次请求 payload
        │                                     ▼
        │                        POST {baseURL}/chat/completions
        │                        （assistant 消息无 reasoning_content，实测 200 OK）
        │
        └────────────────────►┌───────────────────────────────┐
                              │ 人类转录 / 界面历史              │
                              │ 只读 append-origin 事件          │
                              │ = [S][T][U][1][2]…[k]（含推理）  │
                              │ 替换副本不占分页配额、不可见       │
                              └───────────────────────────────┘
```

**一句话**：日志里两份都在（原文 + 替换副本），但**模型只读折叠后的表面，人只读 append 原文**——
所以既省了 payload，又没有牺牲任何"看得见的东西"。

## 2. 逐步时序（含源码出处）

| # | 谁 | 做什么 | 出处 |
|---|---|---|---|
| 1 | LLM 层 | 流式产出 chunk（含 reasoning chunk） | `packages/llm/llm-deepseek/src/serialize.ts:198-232`（回传规则） |
| 2 | agent loop | 每个 chunk → `session.append('assistant/chunk')`；组装完成后 → `session.append('assistant/message')` | `packages/core/agent-loop/src/agent.ts:350` 起 |
| 3 | **本插件** | 订阅 `session/event`（global） | `packages/core/session/src/index.ts:76` |
| 4 | **本插件** | 追加替换副本（`surfaceOp: {op:'replace'}`） | 本仓库 `index.js` |
| 5 | session | 表面折叠 op、校验表面契约 | `packages/core/session/src/surface.ts:185-205`、`:331-345` |
| 6 | token-meter | 校验 provenance（source 必须是同 step 的 chunk、不重复、严格更早） | `packages/llm/token-meter/src/index.ts:279-304` |
| 7 | agent loop | `deriveMessages()` → `buildRequest()`（结果 `deepFreeze`）→ `llm.stream()` | `packages/core/agent-loop/src/agent.ts:341`、`:505` |
| 8 | provider | 前缀缓存按**逐字前缀**命中（实测 `miss=250 hit=128`） | 探针 `.research/probe-reasoning-passback.mjs` |
| 9 | host apiproxy | 界面分页只数 append-origin 消息；替换副本不计额 | `packages/host/apiproxy/src/api-proxy.ts:218-227` |

## 3. 元素生命周期：为什么这样做是免费的

| 阶段 | 时刻 | 说明 |
|---|---|---|
| 生成 | 第 k 次调用中 | 推理与正文由模型产出，尚未被任何请求携带 |
| **首次回传** | **第 k+1 次请求** | 这是唯一的"定型窗口"：在此之前改写 = 前缀从未包含旧形态 ⇒ **零断点税** |
| 之后 | 第 k+2 次起 | 已被发送过 ⇒ 再改就要付"那一刻整份 payload"的全价税（这正是"出口压缩"贵的原因） |

⇒ 本插件只在第 2 阶段动手（`queueMicrotask`，距下一次请求还隔着整个工具执行阶段）。

## 4. 现在能塑形什么 / 还差什么

| 类别 | 占追加内容（实测 453 步会话） | 现在 | 规划 |
|---|---|---|---|
| reasoning | **34.8%** | ✅ `drop` | `keep-last-k`、`summarize:llm` |
| tool 调用参数 | 40.2% | ❌ `keep` | `stub`（风险最高，最后做） |
| tool 结果 | 21.4% | ❌ `keep` | `stub`（首尾桩） |
| assistant 正文 | 1.8% | ❌ `keep` | 不建议动 |
| 用户消息 | 1.8% | ❌ `keep` | 不动 |

## 5. 失败与降级路径

```
事件不合法/无 reasoning        → 直接 return（零副作用）
session.append 抛错            → 捕获 → 写日志 FAILED → 表面保持原样（会话不受影响）
日志写不了                     → 静默忽略（不影响会话）
哨兵 ~/.dsh-entry-shaper.OFF   → 每 64 个事件查一次 → 停手（免重启）
patch 里 enabled: false        → 完全不订阅动作（需重启）
```

## 6. 三个验收观测点

| 看什么 | 期望 | 判据 |
|---|---|---|
| `~/.dsh-entry-shaper.log` | `applied … enabled=True` + `strip #1 … provenance=N 项` | provenance 项数应等于该 step 的 chunk 数 |
| 界面历史 | 推理**照常显示** | 这是"两份存"的直接验收 |
| `tools/session-cost-audit.mjs` | 每步输入下降；**未命中不出现整份 payload 尖峰** | 有尖峰 ⇒ 时机错了（变成了"出口压缩"），要立刻停手 |
