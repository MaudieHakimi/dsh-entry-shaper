# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

> **来源声明**：本项目的全部源码（`index.js`、测试、基准、文档与工具脚本）
> **完全由 DeepSeek-V4.1-Flash 生成**，人类负责提出需求、做出取舍决策与验收。
> 详见 README 顶部的说明与 `CONTRIBUTING.md` 的「来源声明」。

## [1.0.6] — 2026-10-13

**寄存表的增长控制（1.0.5 上线后由真实运行数据暴露）。**

1.0.5 引入原文寄存表时只做了"换轮清空"，**上线后实测发现它仍在涨**：

```
文件 2328 KB / 2074 条，唯一键只有 216  →  重复写入 1858 条（90%）
时间跨度 22:09 → 22:23，跨了 2 次 turn/start，「originals purged」一条日志都没有
```

### Fixed

- **同一对 (shaped, original) 反复写盘**：wire 级塑形对**同一条旧消息每次请求都会重算**
  ⇒ 同一条推理以**逐字节相同**的 shaped 反复到达 ⇒ 反复追加。因为塑形是**单射**
  （同 shaped ⇒ 同 original），重复写入**没有任何信息增益**。已加**内存去重**（`seen` 集合）。
  实测：500 次重复只写 1 条；100 条 × 20 轮 = 仍只 101 条。
- **进程重启后旧内容永久残留**：只在"换轮"清空会漏掉重启 —— 新进程的 `turn` 初值是 `null`
  ⇒ 首次 `turn/start` 时 `turn !== next` 为假 ⇒ **不触发清空**，上一个进程遗留的内容
  就永久躺在那里（实测：22:09 的旧条目一直留到 22:23 之后）。已改为**构造时先清空一次**。
- **单轮内无上限**：加了 `maxBytes` 兜底（默认 4 MB），超限即清空并保留最近一条，
  同时记 `capped` 计数与日志。这是最后一道防线，防止去重因任何原因失效时无限增长。

### 回归用例（92 → 94）

- `原文寄存：同一对 (shaped, original) 只写一次（去重，防反复写盘）`
- `原文寄存：超过 maxBytes 自动清空（最后一道防线）`
- `原文寄存：换轮即清空` 改为**相对基线**断言（构造时已清空一次，不能写死绝对次数）

**证伪**：①关掉去重 ⇒ 去重用例变红；②关掉构造时清空 ⇒ 换轮用例变红。改回后 94/94。
**部署验收**：`verify-106.mjs` 8/8（构造清空、去重、兜底三组）。

### 文档一致性审计（一次全量核对）

逐项核对了"文档里说的"与"仓库/代码里实际有的"，修掉 6 处不一致：

| # | 问题 | 修法 |
|---|---|---|
| 1 | `README.md` 状态行仍写 **92/92**（实际 94） | 改为 **94/94** |
| 2 | `docs/FILLER-WORDS.md` 存在但 **README 文档索引没列**（不可达） | 补进索引 |
| 3 | README 索引写 tools **11 个**（实际 12） | 改为 **12 个**，并补"原文回溯" |
| 4 | README 索引写 `CONTRIBUTING.md` **6 条硬规则**（实际 12） | 改为 **12 条** |
| 5 | README 的 op 表写 `extract` 的 `marker` 默认 **true**（1.0.5 起已是 false） | 改为 **false** 并标注"会污染模型" |
| 6 | **两处悬空引用**：`docs/PIPELINE.md` → `tools/probe-reasoning-passback.mjs`、`docs/PROCESSING.md` → `dsh-context-slimmer/tools/session-cost-audit.mjs`；**两个文件都不存在** | 前者改指实际的 `bench/passback-rule.mjs`；后者移除并列出本仓库覆盖该功能的脚本 |

另修正两处**与实测不符**的旧宣称（同 1.0.5 的"保留原文"问题）：
`docs/OFFICIAL-STACK.md` 的两处"保留原文"、`docs/PROCESSING.md` 的 M6 里程碑条目。
`tools/README.md` 补注"除 `original.mjs` 外其余脚本都要求路径参数，不传会抛 `ERR_INVALID_ARG_TYPE`"。

> 审计方法（可复用）：`git grep` 抽出文档里所有 `tools/*.mjs`、`bench/*.mjs`、`docs/*.md`
> 引用并与文件系统逐个比对；再把文档里的**数量宣称**（测试数、脚本数、规则数）与实际计数比对。
> **这两类不一致（悬空引用、过期计数）是文档最容易出、也最难靠人眼发现的问题。**

### ★ 实验发现：`Let me` 才是最大的那一类自我叙述噪音（文档，未改代码）

维护者在长会话里**亲身观察到**"注意力真的全被保留的 `Let me` 吃了"。
据此测量，结果比预期严重 —— 已完整记入 [`docs/FILLER-WORDS.md`](docs/FILLER-WORDS.md) §5：

- **前提确认**：实时流式渲染与写入会话的都是**原文**；只有**出网那一份**被塑形。
  （判据修正：`session.jsonl.zstd` 只存 **1.498%** 的事件 ⇒ `assistant/chunk` 是抽样，
  **不能**用来判断流形态；正确数据源是 `reasoning-chunks`，按 **`time0`** 排序。）
- **测量**：`extract` 保留的 8764 句里，**76.9%（6738 句）是 `Let me / I will / Now I`
  这类自我叙述标记** ✗
- **结论**：这是**设计缺陷**而非调参问题 —— `DECISION_RE` 把 `let me` 当"决策句标记"，
  但它们与 `Hmm` 属**同一类**（自我叙述填充，只是更长、信息量同样≈0）
  ⇒ **插件压掉了短的自我叙述，却系统性保留并回灌了长的**（token 更多）。
- **对算法的启示**：判据应从"**是不是决策句**"改为"**有没有信息增量**" ——
  意图句（将来式）信息量最低却最易匹配句式模板；结论句（事实/完成态）才是后续推理需要的。
- **候选方向（未实施，需先量化）**：①剥离自我叙述前缀；②偏好结论句；③新增可组合 pure op
  （如 `stripNarration`）。三者都只影响出网那一份，界面实时流仍是原文。

> 本轮**刻意未改代码**：先把现象与数据固化，避免在没量化收益前动默认策略。
> 这也是本项目的一条纪律 —— 观察到问题先取证，再动手。

## [1.0.5] — 2026-10-13

**根治"塑形标记污染模型"（本插件自己制造的副作用）+ 新增原文寄存表。**
### Fixed

- **塑形前缀污染模型**（`OPS.extract`）：旧默认给每个塑形结果加
  `[reasoning extract: N chars omitted] ` 前缀。该前缀随 assistant 消息进入**之后每一次
  请求**（`surface.ts:deriveEventMessage()` 对 `assistant/message` 原样返回），
  模型把它当成**自己思维链的一部分**并**逐字继续生成**它。
  **wire 级取证**：llm-tap 的输出流分片为 `"[" "reason" "ing" " extract" ":" …`，
  即模型是**主动写出**这个格式的，不是被动携带 ⇒ 自我强化。
  出网侧同样验证：历史推理 **179 塑形 / 12 原文**（94% 是塑形形态）。
  ⇒ 讽刺之处：本插件本为去掉 "Hmm" 这类自我强化的填充噪音，却自己引入了一个
  更规整、更易被精确模仿的同类噪音。
  **修法**：`extract` **默认不带任何前缀**，需要人类审计时显式写 `{ marker: true }`。
  **顺带收益**：实测 4,872 个真实块，压缩率 **92.11% → 93.72%**（额外省 169,334 字符）
  —— 两个方向一致，无取舍。
- **README 三处"永远保留原文"的宣称与实测不符**（`:43`、`:464`、`:571`）：
  实测会话与 trace 里存的都是**塑形后**文本，原文不保留。已改为准确表述。

### Added

- **原文寄存表**（`createOriginalsStore`，侧路，**只写不读 ⇒ 不可能回灌模型**）：
  `~/.dsh-entry-shaper.originals.jsonl`，键为 `sha256(shaped)`、值为原文。
  - 用内容哈希做键的依据：塑形是**单射**（4,872 真实块 + 400 条极端构造样本实测：
    撞键 0、最大扇出 1）；且塑形发生在 `llm/stream` 中间件里，**那一刻还没有事件 seq**
    ⇒ 没有稳定顺序键可用，内容哈希是唯一可行解。
  - **换轮即清空**：不清空会随会话线性增长 ⇒ 硬盘会爆。清空后仅覆盖当前轮，
    峰值 ≈0.3 MB（实测单轮原文均值 23K~37K 字符、最大 272K）。
    清空点放在 `onEvent` 的 `turn/start`（不放 `handleEvent`：熔断/关闭期间换轮也要清）。
- **`tools/original.mjs`**：原文回溯工具（`--list` / `--stats` / 查一条）。
- **`docs/POLLUTION.md`**：污染的完整取证、根治方案、以及"排查这类问题时的正确判据"
  （含本轮栽过的三个坑：分片拼接假阳性、中间件顺序、llm-tap 不可整读）。

### 回归用例（87 → 92）

- `污染防护：默认塑形结果里不含任何"记账格式"字串`（本轮最重要的不变量）
- `抽取：绝不比原文长（短块原样返回）`（原"短块不撑大"升级为全长度区间不变量）
- `抽取：marker:true 才带省略计数前缀（非默认）`
- `原文寄存：侧路记下 shaped→original，且只写不读`
- `原文寄存：换轮即清空（防硬盘随会话线性增长）`
- `原文寄存：默认关闭时完全不写盘`、`原文寄存：运行时接上`

**证伪**：把 `extract` 改回"无条件加前缀"，**6 条用例变红**（含污染防护那条）；改回后 92/92。

### 其它

- 发现并修正一条**靠 bug 才通过**的用例：`链式 op：extract → truncate 依次生效`
  原先依赖"extract 会加 ~40 字符前缀撑到 279+"才让 `truncate` 触发 —— 它测的
  其实不是链式组合。现已改为让 `extract` 产出仍长于 `truncate` 阈值。

### 文档

- **README 新增核心价值主张一节**：`留下填充词的增益，去掉它的代价`。
  把插件定位从"省 token"提升为准确描述它在做什么：推理模型（R1 这一类）经 RL 涌现的
  `Wait`/`Hmm` 这类反思标记，在**生成时**是真实增益、在**进入上下文后**是纯负担；
  本插件只保留前者、去掉后者 —— **不改变模型"怎么想"，只改变它"之后看到自己曾经想过什么"**。
  出处：R1 的 RL 涌现（*Nature*、arXiv 2501.12948）、填充词影响注意力分配
  （*Decoding Hidden Computation across Filler Tokens*）、定向抑制不损性能
  （*Wait, We Don't Need to "Wait"!* 等）。**同时标注了本插件未验证的边界**：
  没有做"去掉填充词后是否变聪明"的行为对照 ⇒ **"更干净"是实测的，"更聪明"不是本插件的声明**。
- 修正 README 中两处与实测不符的表述：`做法：在入口定型`里的"**会话与日志完全不动**"、
  以及"它是什么/不是什么"表里的"原文永远在 append-only 日志里；界面与审计读原文"。
- README 状态行测试数 86/86 → **92/92**（与 1.0.5 的用例数一致）。

## [1.0.4] — 2026-10-12

**两个"看起来对、实际反着做"的修复（都由真实运行日志暴露）。**

### Fixed

- **`extract` 把短推理块撑大**（`index.js` 的 `OPS.extract`）：原来**无条件**加
  `[reasoning extract: N chars omitted] ` 前缀，而该前缀本身约 37~39 字符 ⇒
  **任何短于约 279 字符的推理块都被净增字节**。实测（`maxChars=240`）：10 / 20 / 40 / 120 /
  157 / 234 字符的输入**全部 +37**，258 → +20，直到 **279 字符才第一次转正（−1）**。
  对话里这类短块很常见（"Let me check."、"OK."），每个都涨，是**净亏**（更多出网字符，
  且塑形本身还可能触发断点税）。判据改为"**最终是否比原文短**"，不满足就退回原文。
  注意判据**不是**"省了没有"：`[reasoning extract: 0 chars omitted]` 这种"省略 0 字符"的
  和其余短块一样会涨。
- **纯 op 在运行时路径下被当成非纯 op 缓存**（`applyOps` 的 `provablyPure`）：
  `resolveOps` 会把策略里的**内置** op 也解析成 `{...op, __fn: fn}`（为了让公开 API
  `applyOps` 只认内置表），而判据原来写成 `op.__fn === undefined && PURE_OPS.has(op.op)`
  ⇒ 运行时路径下 `__fn` 永远存在 ⇒ **内置的 extract/keep/... 全被写入缓存**。
  实测代价：日志被 `op extract 缓存命中` 刷屏（当日 34,596 行里 **34,583 行**是这一种），
  缓存文件里堆着可复现的 `extract` 结果。判据改为认**实现身份**
  （`fn === OPS[op.op] || fn === DEPRECATED_OPS[op.op]`），注入的自定义 op 仍照常缓存。

### Added

- **4 条回归用例（82/82 → 86/86）**，其中两条针对"为什么这个 bug 能活下来"：
  - `流过滤：短推理块不撑大` —— 原来那条流过滤用例喂的是 **47 字符**的推理，
    **正因为 bug 才通过**（它断言"必须带 extract 前缀"）；现已改成够长的推理，
    并单列一条短块用例。
  - `缓存：运行时路径下，内置纯 op 也不进缓存` —— 原来那条
    `缓存：纯 op 不进缓存` 用 `applyOps` **直呼**（没有 `__fn`）⇒ 一直是绿的，
    完全测不到运行时装配。新用例走真实事件入口。
  - 另两条：`抽取：短块不撑大`（含 ~279 边界的两侧）、`自定义注入的 op 仍然进缓存`
    （防"修过头"）。

### 说明

- 两条修复都按 `CONTRIBUTING.md` 的硬规则「**修复要证伪**」逐一验过：
  把对应代码改回旧行为，新用例**确实变红**（分别 2 条 / 1 条），改回后 86/86 全绿。

## [1.0.3] — 2026-09-29

**加来源声明 + 推送前清理。**

### Added

- **来源声明**（README 顶部醒目区块 + `CONTRIBUTING.md` 独立一节 + 本文件顶部）：
  全部源码由 **DeepSeek-V4.1-Flash** 生成，人类只负责提需求、做取舍与验收。
  声明里同时点明两条对贡献者的实际要求：① **事实性错误按 bug 处理**（文档/注释与代码不符、
  源码行号过期、实测数字不可复现都要修）；② 仍需遵守 `CONTRIBUTING.md` 的硬规则 ——
  尤其「修复要证伪」与「凡有统计/告警的路径都要有读日志文件的用例」，这两条正是为了防
  "看起来对、实际没生效的代码"。

### Fixed

- `CONTRIBUTING.md` 的验证清单里 `dshmarket` 解析器路径写死成 `C:/Users/<本机用户名>/…`
  （个人信息泄漏）⇒ 改为从 `DSH_HOME`（或 `~/.dsh`）推导，可直接复制运行（已实测）。

### 其它

- README 状态行测试数 81/81 → **82/82**（上一条修复带来的回归用例）。

## [1.0.2] — 2026-09-29

**文档与仓库对齐到最新实现 + 把实测出来的成本结构落盘。**

### Added

- **`tools/`（11 个只读体检脚本，零依赖）+ `tools/README.md` 索引**：
  `session-health.mjs`（单会话体检：命中率/断点与断点税/每回合 payload 曲线与成本，
  并打印每个断点**距上一步的时间间隔**以区分"TTL 过期"与"真断点"）、
  `recount-miss.mjs`（多时间口径 + 逐小时直方图）、`today-turns.mjs`（按回合聚合）、
  `today-tools.mjs`（按工具统计当日工具结果体量）、`cost-all-sessions.mjs`、
  `today-usage.mjs`、`why-miss.mjs`、`sao-fanout.mjs`（子代理扇出时间线）、
  `sao-search-attrib.mjs`（搜索归属）、`pair-wire-shaping.mjs` / `verify-wire-shaping.mjs`
  （从 llm-tap 配对取证塑形前后的出网字符数）。全部**已逐个冒烟测试通过**。
  之前这些散落在本机临时目录里、文档却引用了它们 ⇒ 引用悬空；现正式入库。

### Changed

- **README 全面对齐**：
  - 状态行从「测试 61/61」更正为 **81/81**，并补上最新实测表
    （出网 **−46.6%**、命中 **98.4%~99.6%**、正常回合未命中 **1,148~4,140**、
    正常回合成本 **$0.019~0.038**）；
  - 新增 **§1b「成本结构实测：钱到底花在哪」** —— 把 2026-09 多会话审计的结论写进文档：
    `成本 ≈ 步数 × payload`、未命中占输入 1.6% 却占 57% 的钱、
    断点税占未命中 **66%~87%**、**间隔 vs 命中率**实测表（<1min 96.7% → >15min 63.2%）、
    以及两个"能瞬间打穿账单"的放大源（搜索 / 子代理扇出）；
  - 故障排查表补两条：**"账单突然打穿"先怀疑搜索与子代理扇出**（附量级对比），
    以及"选择器里看不到代理"的第二种成因（启动窗口，1.0.1 已修，自查 `POST /api/llm.models`）；
  - 开发段补 `tools/` 用法与「沙箱下 `exec` op 会遇到 `spawn EPERM`（fail-open 跳过）」提示。
- **`docs/PROCESSING.md` 重写**：原文自述"这是设计规范，不是已实现的功能"，
  且 §2–§5 仍停在 `keep-last-k` / `summarize:llm` / `shaper` 槽位等**从未实现或已否决**的设计。
  现改为描述**已落地**的处理层：7 条不可违反的约束（含"确定性与禁止有状态策略"、
  "转手上游元数据必须改盖 provider"、"适配器必须全成员"、"config 不得写进 patch"）、
  统一协议下的 op 目录与纯度判据、非纯 op 的缓存形状、实际配置形状、
  **M1–M9 里程碑实际状态**、**被数据否掉的方案表**，以及按"能瞬间打穿账单"排序的排障顺序。
- **`docs/PIPELINE.md`**：§7 缓存描述从 `summarize/python` 改为统一协议名；
  补实测数字（−40.1%/−46.6%、命中 98.41%/99.58%）。
- **`SECURITY.md`**：能力表按统一协议名更新（`exec`/`http`/`inline.code`），
  新增 **`inline.code` 等价于在 DSH 进程内执行用户代码** 的明确提示；
  边界段补"本插件不参与排障、不会导致账单放大"。
- **`CONTRIBUTING.md`**：新增第 8–12 条硬规则（新增 op 必须走统一协议、纯度判据、
  测试必须隔离 `cache.path`、**凡有统计/告警的路径都要有读日志文件的用例**、
  **修复要证伪**），并把发版前验证清单补全（导出面检查 + patch 纯 insert 检查）。
- `package.json` 的 `files` 白名单加入 `tools/`。

### 验证

- 测试 **81/81**；语法 OK；`patch` 仍为纯 insert；导出面完整
  （`DEPRECATED_OPS, OPS, apply, applyOps, createOpCache, createProxyAdapter, extractReasoning,
  mergeCfg, name, parseShaped, shapeMessages`）；
- **文档相对链接 15 个，失效 0 个**（含新增的 `tools/README.md`）；
- 11 个 `tools/` 脚本逐个冒烟测试通过。

## [1.0.1] — 2026-09-24

**修「重启后一段时间里模型选择器看不到代理提供方」。**

### Fixed

- **根因是时机而非失败**：`ctx.get('llm')` 在 `apply()` 时尚未就绪（旧实现静默 `return`），
  提供方要等**第一次 LLM 调用**触发惰性 `ensureProxy()` 才注册 —— 本机实测该窗口长达
  **2 分 46 秒**（进程 17:40:13 启动 → 09:40:24Z applied 未注册 → 09:43:00Z 才 registered），
  期间 `llm.models` 里没有该组，而日志一片安静 ⇒ 用户只会以为"插件没生效"。
- 修法：**启动期主动重试**（unref 定时器 0/50/150/400/1000/2500/5000/10000 ms）
  把窗口压到毫秒级；惰性路径保留作兜底；最终仍失败则写 `WARN`（不再静默）。

### Added

- 服务未就绪时写一条**留痕日志**（`proxy 等待 llm 服务就绪（此刻尚未注册 ⇒ 模型选择器里暂时看不到该提供方）`），
  让"看不到提供方"这件事从无声变成可诊断。

### 测试 81/81

新增 1 例：llm 服务未就绪时必须留下"等待"日志（此前该路径完全无声）。

### 附：一条实测到的宿主行为（易踩）

模型选择器的**模型目录按会话缓存**，提供方晚注册时页面里那份是旧的 ⇒ 需刷新页面/重开选择器。
自查用 `POST /api/llm.models`（body `{type:'client-request',rpcId,method,payload:{}}`）直接读宿主的目录与 `failures`。

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
