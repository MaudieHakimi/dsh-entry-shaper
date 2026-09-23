# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.9.3] — 2026-09-23

**代理在模型选择器里"整组消失"的根因修复：`listModels()` 也必须改盖 provider。**

### Fixed

- **现象**：模型选择器里看不到任何代理项，只有官方那组的模型名。
  宿主目录接口给出的原因是
  `INVALID_CATALOG: adapter returned invalid or duplicate model metadata for provider "deepseek-shaped"`
  （实测：`POST /api/llm.models` 的 `failures` 里就是这条，整组被判失败）。
  根因：`LlmRuntime.listModels()`（`llm/src/index.ts:608-624`）会逐条校验
  `model.provider === provider`、`id` 非空不重复、`name` 非空；而代理的 `listModels()`
  **原样转手上游列表**（其中每条 `provider` 是**上游 id**）⇒ 抛 `INVALID_CATALOG`。
  现在逐条改盖 `provider` 为本路由 id（其余字段照搬上游）。
- 这与 0.9.2 修的 `resolveModel()` 是**同一类**错误。教训写死：**凡"转手上游元数据"的
  返回值，provider 一律改盖成本路由 id**（`listModels` / `resolveModel` / `prepareCall` 三处）。

### 测试 60/60

新增 1 例：复刻宿主 `LlmRuntime.listModels()` 的逐条校验（provider 已改盖、id 非空不重复、
name 非空、其余字段照搬上游、上游失败时返回空列表）；并把假上游改成**带 provider 字段**，
否则测不出改盖行为（这正是旧测试漏掉它的原因）。

### 记一条调试通道（本次靠它定位，值得复用）

`POST /api/llm.models`（或 `session.models`）能直接读到**模型选择器看到的同一份目录**，
含 `failures`。请求体 `{type:'client-request', rpcId, method, payload}`；
围栏只要求 Host 是回环、无 `Origin` 时放行（`packages/client/connection/src/api-request-trust.ts:96-122`）。

## [0.9.2] — 2026-09-23

**代理适配器补齐运行时契约 + 代理改为惰性可热开。**

### Fixed

- **代理注册失败**（实测现场日志）：`proxy 注册失败（fail-open）：adapter.providerRetryPolicy is not a function`。
  根因：`createProxyAdapter()` 返回的是**普通对象**，而运行时要求适配器实现
  `llm/src/index.ts` 中被调用的**全部**成员（409 `providerInfo`、414 `providerRetryPolicy`、
  610 `listModels`、659 `resolveModel`、826/910 `prepareCall`、`stream`）。基类 `LlmAdapter`
  本有这些默认实现，普通对象没有 ⇒ 注册期直接抛错。现在补齐 `providerRetryPolicy()`
  （借用上游策略，拿不到则返回 `undefined` = 基类默认）与 `resolveModel()`。
- **`resolveModel()` 必须改盖 provider**：`normalizeModelInfo()`（同文件 663-683）校验
  `resolved.provider === 本路由 id`、`resolved.id === model`、`name` 非空；直接转手上游
  元数据会因为 provider 是**上游 id** 而抛 `INVALID_MODEL_INFO` ⇒ 借用容量字段的同时把
  provider 改盖成别名。

### Changed

- **代理改为惰性注册**：装配期一次性判定会让"开启代理"必须重挂载插件。现在 `ensureProxy()`
  在 apply 时试一次、之后每次 LLM 调用前再试一次（未注册时成本 = 一次布尔判断）
  ⇒ 只改热配置文件即可开启代理，**不必重挂载**；llm 服务在 apply 时尚未就绪也能自愈
  （旧版直接放弃）。
- 注册失败改为**去重日志 + 保留重试**（旧版会每次调用都重新失败）。

### 测试 59/59

新增 2 例：① 断言适配器满足运行时的**全部**成员要求（正是这条能抓住
`providerRetryPolicy is not a function`），并验证 `resolveModel` 改盖 provider、
以及上游信息完全缺失时的合法最小兜底；② 惰性注册 —— 热开 `proxy` 后下一次 LLM 调用
即完成注册。

## [0.9.1] — 2026-09-23

**开关语义修正：`dropReasoning` → `shapeReasoning`，并把它从"总闸"降回"只管推理"。**

### Fixed

- **静默失效**：事件处理链（含 `toolResult` / `toolArgs` / `assistantText` 塑形）此前被
  `!cfg.dropReasoning` 一并掐住 —— 用户写 `dropReasoning: false`（本意"别碰推理"）会把
  **工具结果塑形一起关掉**，而且日志里看不出任何异常。现在事件链只看 `enabled`，
  推理通道（`llm/stream` 过滤 + `proxy`）才看 `shapeReasoning`。
- **代理被推理开关挟持**：`shouldShape()` 旧判据是 `cfg.enabled && cfg.dropReasoning && !off`，
  于是"关掉推理塑形"会让代理连工具结果/助手文本的塑形一起放弃。现在改为
  **任一类别存在非 keep 的 op** 才需要塑形（新增 `anyShaping()`）。
- **测试未隔离 `configPath`**：`apply()` 默认会读真实主目录的 `~/.dsh-entry-shaper.config.json`，
  本机一旦存在该文件就会污染整套测试。现在 `setup()` / `setupStream()` / 代理用例都指向
  临时目录里不存在的路径。

### Added

- `mergeCfg()`（导出，可单测）：把旧名 `dropReasoning` 归一成 `shapeReasoning`。
  必须显式归一 —— `{ ...DEFAULTS, ...hot }` 会让热配置里的旧名被 DEFAULTS 静默盖掉
  （与当初 `reasoningMode` 被静默忽略是同一个坑）。
- 启动自证行改印 `shapeReasoning=`；若配置用的是旧名，会追加一行提示。
- `docs/OFFICIAL-STACK.md`：官方栈三层（`tool-result-pruner` / `compaction-basic` /
  `command-compact`）的位置、阈值、代价，本机一次 `/compact` 的实测账单
  （539,772 token ⇒ 33,092 字符摘要，破点税仅 6,176 全价 token），以及本插件的空位定位。

### 测试 57/57

新增 4 例：`enabled=false` 两通道皆静默、`shapeReasoning=false` 只关推理不牵连 `toolResult`
（旧版此处为 0 次替换，正是这条测试抓住的 bug）、旧名 `dropReasoning` 等价、`mergeCfg`
归一与优先级。

### 运行测试的沙箱注意

`node test/shaping.test.mjs`（直接跑，进程内）可用；`node --test`（派生测试子进程 + 管道）
在受限沙箱下会以 `spawn EPERM` 失败 —— 那是运行器要管道，不是测试本身的问题。

## [0.6.0 – 0.9.0] — 2026-09-23（合并条目，未逐版细分）

- **0.9.0 代理 provider**：`proxy.enabled` 注册一个新 provider（默认 `deepseek-shaped`），
  适配器在 **wire 层**塑形后再转调上游 ⇒ **日志与界面保留原文、零断点税**；
  另有急刹（哨兵）在代理与流过滤两条路上都生效。
- **0.9.0 可热挂载**：`cordis.patch.yml` 改为**纯 insert**（不含配置行/表达式，
  见 `dshmarket/lib/hot.js:295`）⇒ 市场可热挂载；所有可调项移到
  `~/.dsh-entry-shaper.config.json`，**运行时按 mtime 热读 ⇒ 改配置不用重启**。
- **0.8.0 免重启熔断 + 结果缓存**：存在 `~/.dsh-entry-shaper.OFF` 即停手；
  非纯 op（`summarize` / `python`）的结果按内容哈希 + 配置指纹缓存，保证同一输入出网结果恒定
  （否则前缀变化 ⇒ 断点税）。
- **0.7.0 基准**：`bench/divergence.mjs`（4 档 × 3 臂）、`bench/replay.mjs`（固定轨迹、
  可 `--dry`）、`bench/agentic/`（含 8 个深任务）；结论：`extract` 在各档都不劣于 `stub`
  （动作类 15/17 vs 12/17），体积 −36.2% vs −38.0% ⇒ **默认 `extract`**。
- **0.6.0 脱敏注入口**：不再硬编码脱敏规则，改为 `redact` 回调槽位。

## [0.5.0] — 2026-09-23

**架构收口：异步 op 管线 + Python 接口 + OpenAI 兼容 LLM 塑形 + 四道栈护栏。**

### Added

- **op 支持 async**：`applyOps` 现在是 async，逐个 `await`；LLM 与外部进程因此可以当 op 用。
  每个 op 受 `opTimeoutMs`（默认 8000，可 per-op 覆盖）约束：超时/抛错 ⇒ **只跳过该 op**、
  保留上一步结果（fail-open）——最坏情况是"没省到"，绝不会挂住会话。
- **Python 接口**（`{ op: 'python', script, protocol, args, command, timeoutMs }`）：
  stdin 收一行 JSON `{"text":…,"kind":…,"meta":…}`（`protocol: text` 则收纯文本），
  stdout 回 `{"text":…}` 或纯文本；退出码非 0 / 超时 / 空输出 ⇒ 跳过该 op。
  `spawn` 可注入（测试用）。
- **OpenAI 兼容 LLM 塑形**（`{ op: 'summarize', baseURL, model, prompt, maxTokens, apiKey }`）：
  `POST {baseURL}/chat/completions`，显式 system 提示词、温度 0；出网文本可经 `redact` 脱敏；
  apiKey 依次取 `op.apiKey → llm.apiKey → DEEPSEEK_API_KEY`；`fetch` 可注入（测试用）。
- **四道栈护栏**（把"只处理栈顶"从约定变成代码）：
  ① 只认 `surfaceOp === 'append'`；② 替换范围恰为自己（`start === end === event.seq`，从不碰更早 seq）；
  ③ 元素若已不在当前表面（被别人替换/被压缩覆盖）⇒ 放弃；④ 异步 op 超时即跳过，
  并记录"追加→定型"延迟 `lag`，超过 `lagWarnMs`（默认 2000）写 `WARN` —— 这是
  "定型早于首次发送"的**可观测证据**。
- 启动自证行现在打印 `policy=reasoning:extract,toolResult:keep,…`，一眼看清实际生效的策略。

### 测试 33/33

新增 6 例：summarize（mock fetch：URL/模型/温度/提示词/鉴权头）、出网前 redact、
HTTP 失败 fail-open、op 超时护栏、python JSON 协议（mock spawn）、python 纯文本协议与退出码非 0。

## [0.4.0] — 2026-09-23

**处理层落地：从"扁平枚举"改成"按类别可组合的 op 序列"**（此前只有规范、没有实现）。

- op 内核 `OPS`（keep/drop/stub/extract/head/tail/truncate）+ `applyOps`；
- 按类别 `policy: { reasoning, toolResult, toolArgs, assistantText }`；
- **tool 结果塑形真生效**（此前 `policy.toolResult` 是死旋钮）：同类事件替换
  `tool/result` + `surfaceOp: replace` + `sourceEventSeqs: [seq]`；
- 无变化即跳过（不产生多余替换事件）；
- 修：兼容分支判据用了合并后的 `cfg.policy` ⇒ legacy `reasoningMode` 被静默忽略；
- 语义：reasoning **按块**处理；**reasoning 永不被整块删除**（`drop` 无效，退回短桩）。

## [0.3.0] — 2026-09-23

**决策抽取（`extract`）成为默认**：按句式挑决策句而非按位置截断。
同批 case 配对比较中每档一致率都 ≥ 纯桩（动作类型 15/17 vs 12/17、同名工具 6/17 vs 2/17），
体积只多花 1.8 个百分点（−36.2% vs −38.0%）。

## [0.2.0] — 2026-09-23

**桩化替代删除**，并新增行为分歧基准。

- 实测：缺 `reasoning_content` 只在"延续工具回路"（报文以 `role:'tool'` 结果结尾）时被 400 拒绝；
  换成短桩即 200 ⇒ **API 要求字段存在，不要求内容完整** ⇒ 0.1.0 的 drop 会打挂会话。
- 在线成本 A/B 不可信（provider 缓存在多次运行间复用）；自校验条款：
  **两臂共享前缀 ⇒ 未命中必须相等**。

## [0.1.0] — 2026-09-23

首个可用版本（探针级）：入口塑造核心（`session/event` + `surfaceOp: replace`）、
两条硬约束（provenance 原样沿用、不复制 usage）、fail-open 与免重启熔断、
`docs/PIPELINE.md` 与 `docs/PROCESSING.md`、13 例测试。
