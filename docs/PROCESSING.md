# 处理层规范（Processing）：把"塑形"变成可组合的 op 序列

> 这是设计规范，不是已实现的功能。当前实现只有 `reasoning → drop` 一个 op（见 `../index.js`）。
> 目标：让"要不要砍、砍多少、怎么砍"变成**处理层的 op 组合 + 参数**，而不是写死在代码里。

---

## 0. 定位

**处理层 = 元素 → 元素的纯函数链。** 每个"刚追加、尚未发送"的元素（一个消息 + 它的若干内容块）
进来，出去的是它的**定型形态**；定型后钉住、永不改写（见
`dsh-context-slimmer/docs/PAYLOAD-SHAPING.md`）。质量与成本的取舍全部发生在这一层。

```
append 事件 ──► [处理层] ──► 定型事件（surfaceOp: replace，model-only）
                  │
                  ├─ 分类：reasoning / tool-args / tool-result / assistant-text
                  ├─ 选 op：keep | drop | stub | keep-last-k | summarize:llm | redact
                  └─ 失败即 skip（保留原样，绝不阻断会话）
```

## 1. 不可违反的四条硬约束（任何 op 都必须满足）

| # | 约束 | 出处 |
|---|---|---|
| 1 | 替换事件必须是**同类**表面事件（`assistant/message` → `assistant/message`） | `core/session/src/surface.ts`（`SURFACE_EVENT_TYPES` 只有三种） |
| 2 | `sourceEventSeqs` **原样沿用**原事件（每个 source 必须是同 step 的 `assistant/chunk`、不重复、严格更早） | `llm/token-meter/src/index.ts:279-304`（违反即抛错） |
| 3 | 替换事件**默认不复制** `usage`（meter 按事件折算 usage，复制会双计） | `llm/token-meter/src/usage-projection.ts:82-84` |
| 4 | 摘空时补一个空 `text` 块（assistant 消息必须有 content 或 tool_calls） | `llm/llm-deepseek/src/serialize.ts:215-222` |

**两条不需要做的**（DSH 已保证）：原文仍在 append-only 日志里；替换副本是 **model-only**，
界面/审计读 append-origin 事件，因此**不需要我们另存一份原文**
（`core/session/src/surface.ts:40-68`、`host/apiproxy/src/api-proxy.ts:218-227`）。

## 2. op 目录

| op | 语义 | 适用类别 | 成本 | 质量风险 |
|---|---|---|---|---|
| `keep` | 原样保留 | 全部（默认） | — | — |
| `drop` | 整块删除（空则补空 text） | reasoning | 免费 | 低（当前实现） |
| `keep-last-k` | 只保留最近 k 个 reasoning 块（更早的 drop） | reasoning | 免费 | 低，且保留"当前思路" |
| `stub` | 首尾保留 + 计数省略（`…省略 N 行…`） | tool-result、tool-args | 免费 | 中（当步新信息被截断） |
| `summarize:llm` | 用 LLM 生成压缩形态 | reasoning、tool-result | 一次小调用 | 低（比 drop 保守） |
| `redact` | 出网前抹掉机密（复用 `redactor` 槽位语义） | 全部 | 免费 | 无（安全向） |

**调参即组合**：例如"reasoning 保留最近 3 条 + 更早的用 LLM 摘要成一句 + tool 结果首尾 2K"，
就是三条规则，不需要改代码。

## 3. 槽位协议（`shaper` 槽位）

与 `dsh-context-slimmer` 的槽位体系同构（库包 / 组合包两种写法，`requiredHostVersion` 握手，
失败跳过并记诊断）：

```js
// 库包形态：导出一个声明 + 一个函数
export const id = 'shaper:reasoning-policy'
export const requiredHostVersion = 1
export default {
  // 只声明"我想处理哪一类"，内核负责取块、组事件、守四条硬约束
  match: (element) => element.kind === 'reasoning',
  plan: (element, ctx) => ({ ops: [{ op: 'keep-last-k', k: 3 }, { op: 'drop' }], mode: 'enforce' }),
  // 或者自己做完整决策（进阶）：拿到 host，返回定型后的 element
  shape: (element, host) => element,
}
```

**内核负责**（任何 shaper 都不必重复实现）：分类、按序调用、拼接、四条硬约束的校验、
`surfaceOp` 组装、失败降级、日志与统计、`report-only` 模式（只算不写）。

## 4. LLM 型 op 的形状

与现有插件的 `builtin-llm-direct.js` 同一口径，避免引入新端点或新信任面：

- **标准 URL**：`POST {baseURL}/chat/completions`（OpenAI 兼容），`baseURL` 与 key 来自配置，
  默认**不**继承主会话 provider（可显式指定为同一 endpoint 以复用缓存）；
- **显式提示词**：system + user 两段，写死在 op 定义里（可被配置覆盖），温度 0、`max_tokens` 由
  `ops.summarize.maxTokens` 控制（默认 256）；
- **工具**：`tools` 白名单显式声明（默认空 = 不给工具）；要复用**主会话那套工具**则显式打开
  `ops.summarize.useSessionTools: true`（Roadmap 第 3 条）；
- **出网前脱敏**：所有出网文本先过 `redactor`；
- **失败即 skip**：超时（默认 5s）、非 200、解析失败 ⇒ 该 op 不生效，元素保持原样，绝不阻断会话；
- **不进会话**：LLM 调用本身不产生会话事件（否则自己就成了上下文污染源）。

## 5. 配置形状（草案）

```yaml
config:
  enabled: true
  mode: enforce            # enforce | report-only
  policy:
    reasoning:   { ops: [{ op: drop }] }                       # 当前实现
    toolResult:  { ops: [{ op: keep }] }                       # 默认不动
    toolArgs:    { ops: [{ op: keep }] }                       # 默认不动
    assistantText: { ops: [{ op: keep }] }                     # 永不建议动
  ops:
    stub: { headTokens: 512, tailTokens: 512 }
    summarize: { maxTokens: 256, timeoutMs: 5000, useSessionTools: false }
```

## 6. 里程碑（对照实际状态，2026-09-23）

| # | 内容 | 状态 |
|---|---|---|
| M1 | reasoning 的 `drop` / `keep-last-k`（可配置 k） | ✅ `drop`/`stub`/`extract`/`head`/`truncate` 均已实现；**`keep-last-k` 已否决**（有状态策略 ⇒ 同一条旧消息在不同出网批次形态不同 ⇒ 破坏前缀，见 §7） |
| M2 | tool 结果的 `stub`（首尾桩） | ✅ 已实现（`toolResult` + `truncate`），**默认仍 `keep`** —— 官方 `tool-result-pruner`（8192/4096/1024）已在做，先别重复造轮子 |
| M3 | `summarize:llm`（OpenAI 标准 URL + 显式提示词 + 脱敏 + 失败 skip） | ✅ 已实现，**带结果缓存**（非纯 op 不缓存 ⇒ 前缀抖动 ⇒ 断点税） |
| M4 | `shaper` 槽位化（库包/组合包两种写法 + `report-only`） | ⏳ 未做。当前是内置 op 表 + `policy` 配置；槽位化的动机在 `dsh-slimmer-seams` 里另行验证过 |
| M5 | tool-args 的 `stub`（风险最高，最后做） | ⏳ 未做（默认 `keep`）；风险与 M2 不同：参数一旦改坏，工具会**执行错**而不是"答复变差" |
| M6 | **wire 级代理通道**（原计划里没有） | ✅ 已完成并实测：出网 −40.1%、缓存命中 99.3%、日志/界面保留原文 ⇒ **取代**了原先"表面替换"的路线（那条路被两个互相矛盾的校验器堵死，见 `index.js` 顶部注释） |
| M7 | 可热挂载 + 配置热读 + 免重启熔断 | ✅ patch 纯 insert（市场可热挂载）、配置放 `~/.dsh-entry-shaper.config.json` 热读、哨兵即停 |

**被数据否掉的方案**（别再试）：

| 方案 | 否掉的理由 |
|---|---|
| 表面替换 `assistant/message` | `surface.ts:241` 要求 `sourceEventSeqs` 含被替换节点自身，`token-meter/src/index.ts:279-304` 要求每项都是同 step 的 `assistant/chunk` —— **两者矛盾** ⇒ 这条路是死的 |
| `keep-last-k`（只留最近 k 条推理） | 有状态 ⇒ 同一条旧消息两次出网形态可能不同 ⇒ 前缀改变 ⇒ 付断点税 |
| 在线成本 A/B | 两臂共享前缀 ⇒ 后跑的那臂几乎全命中 ⇒ 数字是缓存复用假象（实测出一版 −77%，已撤回） |
| `stub-tail` / `keep-tail` | 行为分歧实测 59% vs `extract` 的 76% ⇒ 更差 |

## 7. 怎么判断"调参调对了"

- **钱**：`dsh-context-slimmer/tools/session-cost-audit.mjs` —— 看每步输入是否下降、
  未命中是否**没有**整份 payload 尖峰（有尖峰 = 引入了断点税，说明时机错了）；
- **量（不依赖外部工具）**：`~/.dsh-entry-shaper.log` 里的
  `proxy-shape #n chars=A→B（累计 …）` —— 这是本插件自己的出网字符统计；
  要看**真实出网内容**再用 `dsh-llm-tap`（`~/.dsh-llm-tap/llm-tap.jsonl`）核对；
- **质**：固定任务集 A/B（开/关各若干次），指标 = 任务成功率 / 返工步数 / 结论保真。
  agentic 基准目前**未观察到退化**（短任务 8/8、长轨迹 3/3），但任务规模仍小于真实长会话
  ⇒ 任何"不影响质量"的强断言在更长轨迹上测出来之前都不成立。

> **一条与"调参"无关但更重要的判据**：只要 `cacheReadTokens / (cacheReadTokens + inputTokens)`
> 保持在 99% 量级且每步命中量按新增量平稳递增，就说明前缀没被打断 ——
> 这比"省了多少"更能说明健康度。

