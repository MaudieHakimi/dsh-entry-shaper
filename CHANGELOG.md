# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [1.0.0] — 2026-09-23

**统一协议：外部塑形不再按"是什么类型"硬编码，而是按"传输 × 数据格式"两维组织。**

### Changed（破坏性）

- **`python` / `summarize` 不再是"类型"，而是别名**。op 名只表示**传输方式**：
  - `exec` —— 任何本地命令（`python` / `node` / `pwsh` / 你自己的 exe）。
    数据格式由 `protocol` 决定：`json`（默认，信封 JSON）｜`text`｜`lines`｜`argv`。
    新增 `cwd` / `env`；`args` 支持 `{}`（脚本路径）与 `{text}`（待塑形文本）占位符；
    `argv` 协议**完全不碰 stdin**。
  - `http` —— 任何 HTTP 端点。新增：`url`（完整端点）、`method`、`headers`、`instruction`
    （追加第二条 system 消息）、`body`（**整包覆盖**请求体，`{{text}}` 占位符 ⇒ 可接
    非 OpenAI 形状的服务）、`protocol: text`。
    响应解析按序尝试 `choices[0].message.content` → `text` → `output` → `content` → `data`
    → 响应原文 ⇒ 多数兼容服务不改配置即可用。
  - `inline` —— **进程内**算法（不必写脚本、不必起进程）：`use: stdout | firstLine |
    jsonField | regex | code`。
- **统一信封与返回值**（写进 README 与 `examples/custom-op.md`）：
  输入 `{ text, kind, meta, op, protocol: 1 }`（`protocol` 是版本号）；
  返回值三种形态 —— JSON 含字符串 `text` ⇒ 用它；含 `"text": null` ⇒ 整块删除；
  其它字符串 ⇒ 取原文。失败只跳过该 op（fail-open）。
- **缓存判据改成"能否证明是纯函数"**（`PURE_OPS` 白名单 + `inline.code` 例外），
  不再按 op 名硬编码 `CACHED_OPS`。后果：自定义 op 与 `inline.code` 一律进缓存 ——
  无法证明纯就不赌，因为"结果漂移 ⇒ 前缀改变 ⇒ 付断点税"比多占磁盘贵得多。
- **`inline.code` 让"进程内自定义算法"也能热改**：`code` 是**函数体源码字符串**
  （`new Function` 编译并按源码缓存）⇒ 可以写在热配置文件里，
  不必像 `config.ops` 注入函数那样因 patch 出现 `config:` 行而失去热挂载。

### Added

- `parseShaped()`（导出）：把外部结果按统一规则解析为文本 / `null`。
- `DEPRECATED_OPS`（导出）：旧名 `python` / `summarize` 的等价别名，走同一套实现
  ⇒ 缓存与失败语义完全一致。**旧配置继续可用**。

### Fixed

- 实现过程中被既有测试抓住的两个真问题（都不是新写的测试发现的，说明原套件有效）：
  ① 新 `http` 一度丢了 `ctx.llm.baseURL` 回退链；
  ② `summarize` 别名一度预填 `baseURL`，把 `ctx.llm.baseURL` **短路**掉
  （测试注入的端点被忽略、请求打到官方端点）。
- `inline.code` 的 `code` 参数类型变了（现在是字符串，不再是函数）—— 属破坏性变更，
  但该 form 是本版新增的，无既有用户。

### 测试 79/79

新增 12 例：`exec` 用 node（不再是 python 专用）、信封字段完整（含 `protocol: 1`）、
`argv` 不碰 stdin、`lines` 送 kind、`{text:null}` 删除、退出码非 0 只跳过该 op、
`env`/`cwd` 生效（并注明 Windows 上环境变量叫 `Path` 不是 `PATH`）、`http` 自定义 `body`、
`instruction` 追加 system、`inline` 三种 form、`inline.code` 走缓存、旧名与统一协议等价。
另修 5 个旧 mock：统一协议下 `http` 会先取响应**原文**，只实现 `json()` 的旧 mock 会让 op
抛错并被 fail-open 跳过（表现为"返回原文"，像功能坏了）—— 已在测试文件里标注这个坑。

## [0.9.6] — 2026-09-23

**自定义算法真正可用了 + 文档补上"怎么配上去"（此前 README 只有一张名词表）。**

### Added

- **`config.ops`：可注入自定义 op**。此前 `ops` 表是硬编码的 `const OPS`，
  使用者**没有任何入口**接入自己的算法，只能改源码。现在两种写法：
  - 注入函数：`ops: { 名字: (text, op, ctx) => string|null }`（由 patch 的 `config:` 传入）；
  - 纯字符串映射到内置 op：`ops: { myalias: "extract" }` —— **不需要注入函数**，
    因此这条路径仍然**可以热改** ✓。
  `applyOps()` 支持 `op.__fn`；策略解析处（`resolvePolicy()`）统一把名字解析成实现，
  因此**导出的 `applyOps` 公开 API 不变**（仍然只认内置表）。
- **自定义 op 也进缓存**（`cache: false` 可关）。理由：无法判断用户函数是否纯，而
  "结果漂移 ⇒ 前缀改变 ⇒ 付断点税"比"多占几 KB 磁盘"贵得多 ⇒ **宁可多缓存**。
- `examples/config.full.json`（一个完整可用的配置）与 `examples/custom-op.md`
  （接入自定义算法的三种方式 + 函数契约 + 取舍表）。

### Fixed

- **缓存键会漏掉"同名不同实现"**：`keyOf()` 原用 `JSON.stringify({ ...op, apiKey: undefined })`，
  而 `JSON.stringify` 会**丢掉函数** ⇒ 两个同名不同实现的自定义 op 撞到**同一个键**
  ⇒ 拿旧实现的结果冒充新实现 ✗。现在显式剔除 `__fn`，并把"名字是唯一身份、
  不同实现请用不同名字"写进注释与文档。
- `README` 补上**配置片段**（7 个复制即用的 `policy` 写法）与 op 的**参数全集表**
  （此前只有 op 名与一句语义，`maxChars` / `chars` / `protocol` / `args` 等参数名都没写）。

### Docs

- **写清了两处"照抄就踩坑"的地方**：
  ① 配置文件里的路径**没有 `~` 展开**（代码用 `join(homedir(), …)`，而配置字符串原样使用）
  ⇒ 写 `"~/.dsh-entry-shaper.log"` 会在当前目录建一个叫 `~` 的目录；
  ② 注入函数 / `ctx.llm` / `ctx.redact` / `ctx.fetch` / `ctx.spawn` **只能从 patch 的 `config:`
  传入** ⇒ patch 出现 `config:` 行就**失去热挂载**（`dshmarket/lib/hot.js:295`）。
  并把"同一件事优先选不需要 `config:` 的干法"写成规则（例：`summarize` 用自己的
  `baseURL`/`model`/`apiKey` 参数，而不是 `ctx.llm`）。

### 测试 67/67

新增 4 例：① `config.ops` 注入的函数经 `policy` 引用后真的生效；② 字符串别名解析到内置 op；
③ 未知名字被跳过且链上后续 op 仍生效；④ 缓存键：同名不同参数不得同键、`apiKey` 不得进键。

## [0.9.5] — 2026-09-23

**外部审计发现的真实缺陷：`ReferenceError` 静默废掉整段统计与护栏。**

### Fixed

- **`index.js` 的 `stats.blocks += reasoning.length` 引用了未声明标识符**（审计报告 L983；
  实际共 **3 处**：统计行 + `strip #1` + `strip #N` 两行日志）。
  `reasoning` 只是**别处的局部变量**（上面循环里的收集数组），本作用域从未声明 ⇒ 抛
  `ReferenceError`。危害不是"少记一个数"：它抛在 `queueMicrotask` 的 `try` 内、且位置在
  `session.append` **之后**，因此
  ① 表面替换**照常成功**（所以表面行为完全看不出来）；
  ② 其后**全部**语句不执行 —— `chars` / `emptyFixed` 不记账；
  ③ **护栏 4 的 `lagWarnMs` 延迟告警永不触发**（它就在抛错行之后）；
  ④ `strip #1` / `strip #N` 成功日志**永不输出** —— 而 `docs/PIPELINE.md` 正把 `strip #1`
     列为验收观测点 ⇒ **"只声明未执行"的护栏**。
  修法：改用本作用域里真正表示"塑形后保留的块数组"的 `kept.length`（顺带让该计数
  表示"保留了多少块"，比原来想记的语义更清楚）。
- 影响范围：仅 `surfaceAssistant: true` 这条**默认关闭**的实验路径（默认路径是代理通道），
  故不影响生产行为；但缺陷本身是真的。
- **漏掉它的原因**：61 个用例里**没有任何一个读过日志文件**，而抛错不改变表面行为。
  本次补 2 例回归用例（见下），并**用 `git stash` 撤掉修复验证过它们确实会失败**
  （修复前 61 pass / 2 fail，修复后 63/63）—— 不这么验一遍，就是两条假测试。

### Added

- `DEFAULTS` 补上 `opTimeoutMs: 8000` 与 `lagWarnMs: 2000`：代码一直在读这两个键，
  但 `DEFAULTS` 里没有 ⇒ 配置面不完整（审计报告也指出了 `lagWarnMs`"未出现在 DEFAULTS"）。

### Docs

- `cordis.patch.yml` 的配置示例：`dropReasoning` → `shapeReasoning`（旧名仍由 `mergeCfg()`
  兼容，但示例不该教旧名），并注明"全部可调键以 `DEFAULTS` 为准"。
- `docs/PIPELINE.md`：§1 顶部补上**完整的路线修正**（表面替换 ✗ → `llm/stream` 过滤 →
  最终定为**代理 provider**，并说明两条通道**互斥不重复塑形**）；§4 类别表按实际能力重写
  （四个类别都由 op 链驱动，默认值与能力分开列）；§5 降级路径补上"统计段抛错"这一类
  （并写明它为什么难以从表面发现）；§6 验收观测点按两条路径分别列出；**新增 §7 代理路径总图**。

### 测试 63/63

新增 2 例：① 实验路径**成功日志真的写出来**且无 `FAILED append`；② `lagWarnMs: 0` 时
**护栏 4 的告警真的写出来**（两者都直接读日志文件断言 —— 这正是原缺口）。

### 一条方法论（值得带走）

**"表面行为正确"不能证明"代码执行完整"。** 失败被 `try` 吞掉、又发生在副作用之后时，
从外部只能看到"一切正常"。所以：**凡是有统计/告警的路径，都要有一条读日志的用例。**

## [0.9.4] — 2026-09-23

**发版前的文档与自证能力补齐。**

### Added

- **`proxy-shape` 自证日志**：每次代理塑形都记账（前 3 次 + 之后每 20 次一行），
  格式 `proxy-shape #n chars=A→B（本次 −X%；累计 A→B = −Y%）`。
  动机：在此之前"到底省了多少"只能靠第三方抓包（`dsh-llm-tap`）看，用户装了插件
  却无法自证；现在**看一眼自己的日志就够**。日志只记字符数，不记内容 ✓。
  `createProxyAdapter()` 相应新增 `onShaped({ before, after })` 回调（可注入，便于测试）。
- `README.md` **全文重写**：修掉三处已经过期的内容 ——
  ① 旧版把 `config:` 写进 `cordis.patch.yml`（那正是**导致无法热挂载**的写法）；
  ② 旧版用 `dropReasoning`（现名 `shapeReasoning`）；③ 测试数与"只做 reasoning"的描述过期。
  新增：目录、三种挂载方式对照、热挂载的两条硬限制、故障排查表、`docs/OFFICIAL-STACK.md` 入口。
- `docs/PROCESSING.md` 里程碑表按**实际状态**重写（M1–M7），并新增两节：
  **被数据否掉的方案**（表面替换 / `keep-last-k` / 在线 A/B / `stub-tail`）与
  **健康度判据**（命中率 + 每步命中量是否按新增量平稳递增，比"省了多少"更重要）。

### 测试 61/61

新增 1 例：`onShaped` 上报的 `before` / `after` 必须与实际 `shapeMessages()` 结果一致，
且**未塑形时不上报**（否则会把"原样转发"记成"省了 0%"）。
（注：该用例第一版手抄字符数抄错了 8 个字符 —— 现已改为直接用 `shapeMessages()` 现算期望值。）

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
