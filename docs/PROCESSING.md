# 处理层规范（Processing）：把"塑形"变成可组合的 op 序列

> **本文描述已落地的处理层**，不是规划。规划中的方案要么已实现、要么已在本文件
> §6「被数据否掉的方案」里记录否决理由。

## 0. 定位

**处理层 = 元素 → 元素的纯函数链。** 每个元素进来，出去的是它的**定型形态**；
定型后钉住、永不改写 ⇒ 出网前缀单调。质量与成本的取舍全部发生在这一层。

```
两条通道
├─ 代理通道（默认路径）：deriveMessages() → op 链 → 上游 provider   ← 本文的重点
└─ 表面通道（实验性、默认关）：session/event → 同类事件替换
```

处理层的全部职责：**按内容类别，把文本从一种形态变成另一种形态**。
它不碰 provenance、不碰 usage、不碰事件类型 —— 那些约束由内核兜（见 §1）。

## 1. 不可违反的约束（任何 op 都必须满足）

| # | 约束 | 出处 / 后果 |
|---|---|---|
| 1 | **确定性**：同一输入必须产出同一输出 | 否则同一条旧消息两次出网形态不同 ⇒ 前缀改变 ⇒ 付断点税。做不到就走 `cache`（内容哈希 + 配置指纹），**禁止有状态策略**（如"只留最近 k 条"） |
| 2 | 表面替换时 `sourceEventSeqs` **原样沿用**原事件 | `packages/llm/token-meter/src/index.ts:279-304` —— 违反直接抛错 |
| 3 | 表面替换**不复制** `usage` | `packages/llm/token-meter/src/usage-projection.ts:82-84` —— 否则同一步计两次 |
| 4 | **推理块的字段必须存在** | thinking 模式下报文以 `role:'tool'` 结尾时缺 `reasoning_content` 会被 API 400 拒绝 ⇒ 内核在 op 链把它删空时**退回短桩** |
| 5 | 转手上游元数据时 `provider` 改盖成本路由 id | `resolveModel` 违者抛 `INVALID_MODEL_INFO`；`listModels` 违者抛 `INVALID_CATALOG`（代理整组从选择器消失） |
| 6 | 代理适配器必须是"全成员"的 | 运行时调用 `providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel` / `prepareCall` / `stream` **全部**（`packages/llm/llm/src/index.ts`）；本适配器是普通对象、不继承 `LlmAdapter` ⇒ 基类默认实现全都没有 |
| 7 | 配置**不得**写进 `cordis.patch.yml` | 含 `config:` 行的 patch 无法热挂载（`dshmarket/lib/hot.js:295`）⇒ 所有可调项放热配置文件 |

## 2. op 目录（统一协议）

**op 名只表示传输方式，不表示"这是 .py / 这是 LLM"。** 详见 README 的「统一协议」一节。

| 传输 | op | 数据格式 | 纯度 |
|---|---|---|---|
| 本地进程 | `exec` | `protocol`: `json`（信封，默认）｜`text`｜`lines`｜`argv` | 不可证明 ⇒ **进缓存** |
| HTTP | `http` | OpenAI 形状（可 `body` 整包覆盖） | 不可证明 ⇒ **进缓存** |
| 进程内 | `inline` | `use`: `stdout`｜`firstLine`｜`jsonField`｜`regex`｜`code` | 前四种纯；`code` 不可证明 ⇒ **进缓存** |
| 纯函数 | `keep` `drop` `stub` `extract` `head` `tail` `truncate` `stdout` | — | **纯** ⇒ 不缓存 |

**统一信封**（每次调用必送）：
`{ "text", "kind", "meta", "op", "protocol": 1 }`（`protocol` 是版本号）
**返回值**：JSON 含字符串 `text` ⇒ 用它；含 `"text": null` ⇒ 整块删除；其它字符串 ⇒ 取原文。
**失败**（退出码≠0 / 超时 / 空输出 / 抛错）⇒ 只跳过该 op，保留上一步结果。

**缓存判据**（`applyOps` 的 `provablyPure`）：**"能否证明是纯函数"**，而不是按 op 名硬编码。
证明不了就一律缓存 —— 结果漂移 ⇒ 前缀改变 ⇒ 付断点税，比多占几 KB 磁盘贵得多。

**自定义 op**（`config.ops`）：注入函数（`{ 名字: (text, op, ctx) => string|null }`）
或纯字符串映射到内置 op（`{ myalias: "extract" }`）。
⚠️ 注入**函数**需要 patch 出现 `config:` 行 ⇒ 不可热挂载。
想两者都要就用 `inline.code`（函数体**源码字符串**，可写进热配置文件）。

### 2.1 组合语义（`applyOps` 的契约）

**唯一载体是局部变量 `out`**：每个 op 读它、写它 ⇒ 线性串联，无隐藏状态：

```js
let out = text
for (const op of ops) {
  out = await withTimeout(fn(out, op, ctx), op.timeoutMs ?? ctx.opTimeoutMs ?? 8000)
  if (out === null || out === undefined) return null   // 立即终止整链
}
return out
```

| 保证 | 含义 | 实现位置 |
|---|---|---|
| 线性 | op 数组顺序即执行顺序；每个 op 只见上一步的输出 | `for` + `out` |
| 来源无关 | 只要签名是 `(text, op, ctx) => string\|null`，纯函数 / `exec` / `http` / `inline` / 注入函数都可插在任何位置 | `OPS[op.op] ?? DEPRECATED_OPS[op.op]`（或 `op.__fn`） |
| 失败隔离 | 单个 op 抛错只跳过它、保留上一步结果 | 逐 op `try/catch` |
| 超时隔离 | `timeoutMs` 可**逐 op**覆盖全局 `opTimeoutMs` | `withTimeout`（⚠️ 定时器**不得 `unref()`**：无其它 handle 的进程会提前退出、超时不触发，实测踩过） |
| 提前终止 | 返回 `null` / `undefined` ⇒ 整链立即返回 `null`（= 整块删除） | `return null` |
| 缓存独立 | 每个 op 各自算键、各自命中；`cache: false` 可关单个 | `provablyPure` 判据 |
| 参数独立 | 同名 op 可在链上出现多次、各带参数 | 每次迭代重新解析 `op` |

⇒ **换实现不动架构**：`policy.<类别>.ops` 里的**一个对象**换成另一种传输方式即可，
缓存、超时、fail-open、代理链路全部照旧。七条性质的实跑验证见 README
「链式组合：七条性质」。

## 3. 类别与理由

| 类别 | 来源 | 默认 op | 说明 |
|---|---|---|---|
| `reasoning` | assistant 的 `reasoning` 块 | `extract`(240) | 官方剪枝器完全不碰推理，而它是日志里最大宗 payload ⇒ 本插件的空位 |
| `toolResult` | `tool-result` 块的内层 `content` | `keep` | 官方 `tool-result-pruner` 已在做（8192/4096/1024），别重复造轮子 |
| `toolArgs` | `tool-call` 的 `arguments` | `keep` | **风险最高**：参数改坏 ⇒ 工具执行错，不是"答复变差" |
| `assistantText` | assistant 的 `text` 块 | `keep` | 不建议动 |
| `user` | `role === 'user'` | — | **永不触碰**（硬编码跳过） |

## 4. 非纯 op 的形状

`exec` / `http` / 自定义注入的 op **都必须过缓存**（`cache: false` 可关，但**别关**）：

- 键 = `sha256(op名 + 生效配置指纹 + op参数 + 输入文本)`；
- 指纹里**不能有函数**（`JSON.stringify` 会丢掉它们 ⇒ 同名不同实现撞同一个键）⇒
  **不同实现请用不同的 op 名字**；
- `apiKey` 显式排除（否则换密钥就整体失效）；
- 重启仍然命中（启动时把 JSONL 读进内存）⇒ 重启不打断前缀。

## 5. 配置形状（实际）

配置**只放** `~/.dsh-entry-shaper.config.json`（运行时按 mtime 热读，改完不用重启）。

```jsonc
{
  "enabled": true,
  "shapeReasoning": true,
  "policy": {
    "reasoning":     { "ops": [{ "op": "extract", "maxChars": 240 }] },
    "toolResult":    { "ops": [{ "op": "keep" }] },
    "toolArgs":      { "ops": [{ "op": "keep" }] },
    "assistantText": { "ops": [{ "op": "keep" }] }
  },
  "cache": { "enabled": true, "maxBytes": 8388608, "maxEntryChars": 16384 },
  "proxy": { "enabled": true, "provider": "deepseek-shaped", "upstream": "deepseek-official" },
  "opTimeoutMs": 8000,
  "lagWarnMs": 2000
}
```

⚠️ **路径里不要写 `~`**（没有 shell 展开）⇒ 省略这些键用默认绝对路径，或写绝对路径。

## 6. 里程碑（对照实际状态）

| # | 内容 | 状态 |
|---|---|---|
| M1 | reasoning 的 `drop` / `stub` / `extract` / `head` / `truncate` | ✅ 已实现；**`keep-last-k` 已否决**（有状态 ⇒ 破坏前缀） |
| M2 | tool 结果的塑形 | ✅ 已实现（`policy.toolResult`），**默认仍 `keep`**（官方 pruner 已在做） |
| M3 | LLM 塑形 | ✅ 已实现为 `http`（OpenAI 兼容 + 显式 system + 脱敏 + 失败跳过），**带结果缓存** |
| M4 | `shaper` 槽位化（库包/组合包 + `report-only`） | ⏳ 未做。当前是内置 op 表 + `policy`；`config.ops` / `inline.code` 已覆盖"接入自定义算法"的主要需求 |
| M5 | tool-args 塑形 | ⏳ 未做（默认 `keep`），风险最高 |
| M6 | **wire 级代理通道** | ✅ 已完成并实测（出网 −40%~−47%、命中 98.4%~99.6%）⇒ **取代**了表面替换路线。⚠️ 2026-10-13 修正：原文**不**保留在会话里，见 `docs/POLLUTION.md` + 侧路寄存表 `tools/original.mjs` |
| M7 | 可热挂载 + 配置热读 + 免重启熔断 | ✅ patch 纯 insert、配置 mtime 热读、哨兵即停 |
| M8 | **统一协议**（传输 × 数据格式） | ✅ v1.0.0：`exec` / `http` / `inline` + 统一信封与返回值；旧名 `python` / `summarize` 降为等价别名 |
| M9 | 代理提供方"启动窗口"问题 | ✅ v1.0.1：启动期主动重试注册 + 未就绪时留痕（此前有 2~3 分钟窗口，模型选择器里看不到提供方） |

**被数据否掉的方案**（别再试）：

| 方案 | 否掉的理由 |
|---|---|
| 表面替换 `assistant/message` | `surface.ts:241` 要求 `sourceEventSeqs` 含被替换节点自身，`token-meter/src/index.ts:279-304` 要求每项都是同 step 的 `assistant/chunk` —— **两者矛盾** ⇒ 这条路是死的 |
| `keep-last-k`（只留最近 k 条推理） | 有状态 ⇒ 同一条旧消息两次出网形态可能不同 ⇒ 前缀改变 ⇒ 付断点税 |
| 在线成本 A/B | 两臂共享前缀 ⇒ 后跑的那臂几乎全命中 ⇒ 数字是缓存复用假象（实测出一版 −77%，已撤回） |
| `stub-tail` / `keep-tail` | 行为分歧实测 59% vs `extract` 的 76% ⇒ 更差 |
| 把 `config:` 写进 patch 图省事 | 会让市场**无法热挂载** ⇒ 失去热插拔 |

## 7. 怎么判断"调参调对了"

- **健康度（最重要）**：`cacheReadTokens / (cacheReadTokens + inputTokens)` 保持在 99% 量级，
  且**每步命中量按新增量平稳递增**（说明前缀在延长、没被重建）。这比"省了多少"更能说明问题；
- **量**：本插件日志 `proxy-shape #n chars=A→B（累计 …）`（前 3 次 + 之后每 20 次）；
  要核对**真实出网内容**再用**出网抓包插件**（记录 `llm/stream` 请求与 chunk 的插件）；
- **钱**：本仓库 `tools/` 下的 `session-health.mjs` / `recount-miss.mjs` / `today-turns.mjs`
  / `cost-all-sessions.mjs` / `today-usage.mjs`（先看**断点数与断点税**，
  再看总账 —— 实测断点税常占未命中的 66%~87%）；
- **质**：固定任务集 A/B。agentic 基准**未观察到退化**（短任务 8/8、长轨迹 3/3），
  但任务规模仍小于真实长会话 ⇒ 强断言要等更长轨迹。

**排障顺序**（按"能瞬间打穿账单"的程度）：
① 搜索风暴（`web_search` 一次请求 = 服务端最多 5 个模型回合，其 usage **不进会话日志**）；
② 子代理递归扇出（前缀不共享、缓存零复用）；③ 缓存 TTL 过期后的整份重算（隔夜/隔天回来）；
④ 压缩断点；⑤ 工具结果体量（读进来的大内容此后每步随 payload 重发）。
