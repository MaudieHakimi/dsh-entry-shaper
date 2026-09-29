# 工作管道（当前实际在跑的路径）

> **2026-09-23 路线修正（按时间顺序）**
>
> ① `assistant/message` **无法**用 `surfaceOp: replace` 替换 —— session 端要求
> `sourceEventSeqs` 含被替换节点自身，token-meter 端要求每一项都是同 step 的
> `assistant/chunk`，两者矛盾（现场报 `must include every shadowed node`）
> ⇒ **推理不再走表面替换**，改由 `llm/stream` 中间件在进入会话之前处理。
>
> ② 随后发现**更好的落点**：与其在"进入会话之前"改，不如在**出网之前**改 ——
> 即注册一个代理 provider，把 `deriveMessages()` 的结果塑形后再交上游。
> 这样**日志与界面连推理都不丢**（原文照常进会话），而只有发出去的那一份被塑形。
> **这是现在推荐的默认路径**（`proxy.enabled: true`）。
>
> ⇒ **两条通道并存，且互斥不重复塑形**：代理开启时 `llm/stream` 过滤会**主动让路**
> （`index.js` 里有对应的 `proxyBypassNoted` 逻辑），避免双重塑形与日志丢原文。
> 表面层只保留**合法**的那条：`tool/result` 的同类替换。
>
> 下面 §1 的总图描述的是**表面层定型**的通用机制（对 `tool/result` 与实验性的
> `surfaceAssistant` 仍成立）；默认路径（代理 → wire）见 §7。

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
| 8 | provider | 前缀缓存按**逐字前缀**命中（实测 `miss=250 hit=128`） | 探针 `tools/probe-reasoning-passback.mjs` |
| 9 | host apiproxy | 界面分页只数 append-origin 消息；替换副本不计额 | `packages/host/apiproxy/src/api-proxy.ts:218-227` |

## 3. 元素生命周期：为什么这样做是免费的

| 阶段 | 时刻 | 说明 |
|---|---|---|
| 生成 | 第 k 次调用中 | 推理与正文由模型产出，尚未被任何请求携带 |
| **首次回传** | **第 k+1 次请求** | 这是唯一的"定型窗口"：在此之前改写 = 前缀从未包含旧形态 ⇒ **零断点税** |
| 之后 | 第 k+2 次起 | 已被发送过 ⇒ 再改就要付"那一刻整份 payload"的全价税（这正是"出口压缩"贵的原因） |

⇒ 本插件只在第 2 阶段动手（`queueMicrotask`，距下一次请求还隔着整个工具执行阶段）。

## 4. 现在能塑形什么 / 还差什么

> ⚠️ **本表已按 0.9.x 实际能力重写**（旧版把 reasoning 记作 `✅ drop`、其余全 `❌ keep`）。
> 现在**四个类别都由 op 链驱动**（`policy.reasoning / toolResult / toolArgs / assistantText`），
> 下表的"默认"列指**出厂 DEFAULTS**，不是能力上限。

| 类别 | 占追加内容（实测 453 步会话） | 默认 op | 可用但默认关 |
|---|---|---|---|
| reasoning | **34.8%** | ✅ `extract`（决策句，240 字符预算） | `stub` / `drop`→内核回退短桩 / `head` / `tail` / `truncate` / `summarize` / `python` |
| tool 调用参数 | 40.2% | ⬜ `keep` | 全部 op（**风险最高**：参数改坏 ⇒ 工具执行错，不是"答复变差"） |
| tool 结果 | 21.4% | ⬜ `keep` | 全部 op（官方 `tool-result-pruner` 已在做，注意别重复） |
| assistant 正文 | 1.8% | ⬜ `keep` | 全部 op（不建议动） |
| 用户消息 | — | 🚫 永不触碰 | 硬编码跳过（`shapeMessages` 对 `role==='user'` 直接放行） |

## 5. 失败与降级路径

```
事件不合法/无 reasoning        → 直接 return（零副作用）
session.append 抛错            → 捕获 → 写日志 FAILED → 表面保持原样（会话不受影响）
统计/日志段抛错                → 同上（**注意**：它抛在 append 之后 ⇒ 替换已生效、
                                  只有日志与统计被废掉，表面行为完全看不出来。
                                  这正是 `stats.blocks += reasoning.length` 那个
                                  ReferenceError 藏了很久的原因 —— 见 §6 与回归用例）
某个 op 超时/抛错              → 只跳过该 op，保留上一步结果（fail-open）
日志写不了                     → 静默忽略（不影响会话）
哨兵 ~/.dsh-entry-shaper.OFF   → 每 64 个事件查一次 → 停手（免重启）
patch 里 enabled: false        → 完全不订阅动作（需重启）
代理通道：应塑形而未塑形        → 原样转发（不拒绝请求）⇒ 不会打断正在进行的调用
```

## 6. 验收观测点

**默认路径（代理通道）**：

| 看什么 | 期望 | 判据 |
|---|---|---|
| `~/.dsh-entry-shaper.log` | `proxy registered provider=… upstream=…` | 注册成功，否则看同行的失败原因 |
| 同上 | `proxy-shape #n chars=A→B（累计 …）` | 出网字符确实下降（本机实测 −40.1%） |
| 会话 usage | 命中率 99% 量级；**每步命中量按新增量平稳递增** | 有整份 payload 尖峰 ⇒ 前缀被打断，时机/确定性出错，立即停手 |
| 界面历史 | 推理**照常显示全文** | 这是"两份存"的直接验收（塑形只作用于 wire） |

**实验路径（`surfaceAssistant: true`，默认关闭）**：

| 看什么 | 期望 | 判据 |
|---|---|---|
| `applied … enabled=true` | 已生效 | — |
| `strip #1 seq=… blocks=… chars=… provenance=N 项(首/末=…) lag=…ms` | 成功定型一次 | provenance 项数应等于该 step 的 chunk 数；**这行缺失 = 该段统计被静默跳过**（踩过） |
| `WARN 定型延迟过大 lag=…ms` | 正常情况**不该出现** | 出现即说明"定型早于首次发送"的时序假设被破坏 ⇒ 建哨兵停手排查 |
| `~/.dsh-entry-shaper.OFF` | 建后下一次请求不再塑形（`chars=A→A`） | 急停有效 |

## 7. 默认路径：代理 provider（wire 级塑形）

```
┌─ 会话日志 + 界面（append-only，永不变；推理/正文/工具结果全都在）───────────────┐
└──────────────────────────────────────────────────────────────────────────────┘
        │ agent loop: deriveMessages() → buildRequest() → ctx.llm.stream({provider,…})
        ▼
┌─ dsh-entry-shaper 代理路由（provider = proxy.provider，默认 deepseek-shaped）───┐
│ ① shouldShape()：enabled && 无哨兵 && 至少一个类别有非 keep 的 op                │
│ ② shapeMessages(messages, policy)：按**内容类别**跑 op 链                        │
│      assistant.reasoning → policy.reasoning      tool-result  → policy.toolResult│
│      assistant.text      → policy.assistantText  tool-call.args→ policy.toolArgs │
│      role==='user'       → 永不触碰                                              │
│ ③ 纯 op 天然确定；不可证明为纯的 op（exec / http / inline.code）走内容哈希缓存   │
│ ④ onShaped({before,after}) → 日志 proxy-shape #n chars=A→B（自证省幅）          │
└──────────────────────────────────────────────────────────────────────────────┘
        │ 转调上游：llm.stream({ ...options, provider: proxy.upstream })
        │  ⇒ 凭据由 llm 服务按上游 id 解析（本插件不接触任何 API key）
        │  ⇒ 上游 id ≠ 本路由 id ⇒ 不会再命中本代理（无递归）
        ▼
   POST {baseURL}/chat/completions（**塑形后的 payload**）
```

**为什么这条是免费的**（§3 的结论在这里最强）：`shapeMessages` 是**逐消息纯函数**
（不可证明为纯的 op 靠内容哈希缓存兜住确定性）⇒ 同一条旧消息在**每一次**出网都是同一个形态
⇒ 请求 n 与 n+1 的前缀逐字相同 ⇒ **全命中，零断点税**。

**实测（2026-09，两个长会话）**：出网 payload **−40.1% / −46.6%**；缓存命中
**98.41%（9 天 2739 步）/ 99.58%（7 天 1085 步）**；正常回合未命中 **1,148–4,140 token**
（≈ 每步新增量 ⇒ 零断点）；正常回合成本 **$0.019–0.038**。
取证：插件自证日志 `proxy-shape`，或 `dsh-llm-tap` 的 `~/.dsh-llm-tap/llm-tap.jsonl`。

本机实测：出网 −40.1%（13 对 `callId` 配对），命中率 99.3%，命中量按新增量平稳递增。
取证：`dsh-llm-tap` 的 `~/.dsh-llm-tap/llm-tap.jsonl`，或本插件自己的 `proxy-shape` 日志。
