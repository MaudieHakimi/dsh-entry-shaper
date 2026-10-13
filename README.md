# dsh-entry-shaper

> 把上下文压缩从**出口**挪到**入口**：元素在被首次发送之前定型，此后永不改写
> ⇒ 出网 payload 的前缀保持单调 ⇒ **不再产生断点税**地缩小上下文。

**状态**：实验性 · **默认关闭** · 测试 86/86 · Node ≥ 20 · MIT

> ⚠️ **这句话的确切边界**（避免过度承诺）：
> - "零断点税"指的是**本插件自身不引入**断点 —— 它不改已发送的内容、也不在 wire 上做
>   有状态变换。它**不能**消除别处产生的断点：官方自动压缩、缓存 TTL 过期、
>   换 provider、手工改配置都会照旧打断前缀（见[§ 实测数据](#实测数据)与 §1b）。
> - 前提是**确定性**：纯 op 天然满足；不可证明为纯的 op（`exec`/`http`/`inline.code`/注入函数）
>   靠内容哈希缓存兜住。若你把它关掉（`cache: false`）而实现又不确定，前缀就会抖动 ✗。
> - 当前默认只塑形**推理**一类，其余类别保持 `keep` ⇒ 省幅上限由推理在 payload 中的占比决定
>   （实测 −21% ~ −47%：推理占比低的会话接近下限，长推理会话接近上限）。

> ## 📌 来源声明
>
> **本插件的全部源码（`index.js`、测试、基准、文档与工具脚本）完全由
> DeepSeek-V4.1-Flash 生成**，人类只负责提出需求、做出取舍决策与验收。
>
> | 角色 | 承担者 |
> |---|---|
> | 需求、取舍决策、验收 | [@MaudieHakimi](https://github.com/MaudieHakimi) |
> | 代码生成（全部源码与文档） | DeepSeek-V4.1-Flash |
>
> 这意味着：
> - 代码里保留了**大量"为什么这么做"的注释**（含踩过的坑与实测数字）—— 那是生成过程中
>   真正得到的结论，不是事后补的说明；
> - 数字都尽量给**可复现的取证方式**（`bench/`、`tools/`、以及 harness 源码出处），
>   因为这个项目里出现过若干次"看起来对、实测否掉"的判断（见 `CHANGELOG.md` 的撤回记录）；
> - 若发现任何**事实性错误、过时描述或与代码不符的文档**，请当作 bug 报告 —— 那属于需要修的东西。

**实测**（本机真实会话 + 真实 API，最新一次）：

| 指标 | 实测值 |
|---|---|
| 出网 payload 缩减 | **−46.6%**（插件自证日志 `proxy-shape`，长会话 03/04 两天分别 −40.1% / −46.6%） |
| 缓存命中率 | **98.4% ~ 99.6%**（9 天 2739 步的长会话 / 7 天 1085 步的会话） |
| 正常回合的未命中 | **1,148 ~ 4,140 token**（≈ 每步新增量 ⇒ 零断点） |
| 正常回合成本 | **$0.019 ~ $0.038 / 回合** |

取证方法见[§ 实测数据](#实测数据)。

> ⚠️ **"保留原文"的准确边界**（2026-10-13 修正，此前这里写的是"日志与界面**永远保留原文**"，与实测不符）：
> 实测会话日志里**确实存在塑形形态的推理块**（`acde5be7` 2145 个推理块中 447 个带塑形痕迹），
> 也就是说**原文不保证保留**。这与本插件的设计意图（wire 级塑形、不碰会话）不符，
> 是**已知缺陷**，成因与取证见 [`docs/POLLUTION.md`](docs/POLLUTION.md)。
> 受影响的原文可用**侧路寄存表**回溯：`node tools/original.mjs`（每轮清空，只覆盖当前轮）。

---

## 目录

- [问题：出口侧的小步压缩，在命中价极低的 provider 上是净亏的](#问题出口侧的小步压缩在命中价极低的-provider-上是净亏的)
- [做法：在入口定型](#做法在入口定型)
- [它是什么 / 不是什么](#它是什么--不是什么)
- [官方栈已经做了什么（先读这个）](#官方栈已经做了什么先读这个)
- [安装](#安装)
- [配置](#配置)
- [三种挂载方式](#三种挂载方式)
- [统一协议：一切外部塑形都走同一套 I/O 约定](#统一协议一切外部塑形都走同一套-io-约定)
  - [链式组合：七条性质（全部实测）](#链式组合七条性质全部实测)
- [栈护栏](#栈护栏)
- [实测数据](#实测数据)
- [现状与限制](#现状与限制)
- [故障排查](#故障排查)
- [文档](#文档)
- [开发](#开发)
- [许可](#许可)

## 问题：**出口**侧的**小步**压缩，在**命中价极低**的 provider 上是净亏的

这一节只针对三种**具体**做法，不是泛指"压缩都不好"：

| 维度 | 会亏的做法 | 不会亏的做法 |
|---|---|---|
| **改哪里** | 改**已发送过**的历史（"出口"压缩）⇒ 打断前缀缓存 | 改**尚未发送**的内容（"入口"定型）⇒ 前缀从未包含旧形态 |
| **一次削多少** | 每次只削一小块（自动压缩按 step 触发，常见 3–9 万 token/笔） | 一次打到底（如手动 `/compact`：753K → 23.7K） |
| **按什么价折算** | 省下的是**命中价** token（便宜 50 倍） | 省掉的是**未命中价** token（全价） |

三者同时成立才会亏 —— 缺任何一条都可能反而是赚的（下表里手动 `/compact` 就是反例）。

### 亏损的机制

DSH 的 `compaction-basic` 在**出口**改历史：把已发送的区间换成摘要检查点。每一刀都会让
**改动点之后**的缓存作废 ⇒ 下一次请求从该点起**整份按全价重算**（本文称"断点税"）。

而它的**收益**只有"实际削掉的那部分"（按命中价计）⇒ 于是：

```
收益 ≈ 削掉的 token × 命中价
断点税 = 压缩后整份 payload × 未命中价
```

雪上加霜的是它的**区间选择**（`packages/compaction/compaction-basic/src/region.ts:98-133`）：
区间**头锚定** —— 从最早的表面节点起、切到"保留尾部"之前 ⇒ **检查点落在头部**
⇒ 它后面的一切都作废。所以**削得越少越亏**。

### 本机实测（一个 2739 步的长会话，见 [`docs/OFFICIAL-STACK.md`](docs/OFFICIAL-STACK.md)）

| 做法 | 削掉的 token | 断点税（全价重算） | 比值 | 判定 |
|---|---|---|---|---|
| `compaction-basic` **自动压缩 109 笔合计** | 3,021,022 | **6,282,630** | **0.48 : 1** | ✗ 净亏 2 倍 |
| 其中单笔最差 | 64,891 | 547,342 | 0.12 : 1 | ✗ 亏 8 倍 |
| 人类手动 `/compact`（一次打到底） | 729,434 | 6,176 | **118 : 1** | ✓ 大赚 |

同一套代码、同一个会话，**只因"一次削多少"不同，结论相反** —— 这正是上表第二行的意思。

## 做法：在入口定型

会话是一根**只进不出的栈**。元素在**首次回传之前**定型，前缀里就从来没出现过它的旧形态：

```
请求 n   : [S][T][U][1'][2']…[n-1']
请求 n+1 : [S][T][U][1'][2']…[n-1'][n']
           └──────── 逐字相同的前缀（全命中）────────┘ └ 新增 ┘
```

本插件的**代理通道**把这件事放在 wire 层：拿 `deriveMessages()` 产出的消息数组，
按类别跑 op 链，再交给上游 provider。**会话与日志完全不动**，只有发出去的那一份被塑形。

## 它是什么 / 不是什么

| ✅ 它是 | ❌ 它不是 |
|---|---|
| **代理 provider**：`llm.registerAdapter()` 注册一个新路由，转调上游 | 不接管 `compaction` 服务（可与官方 `dsh-compaction-basic`、`dsh-context-slimmer` 共存） |
| 原文永远在 append-only 日志里；界面与审计读原文 | 不改写**已发送**的内容（那是"出口压缩"的领域，要付断点税） |
| 塑形**逐消息确定**：纯 op，或不可证明为纯的 op 走内容哈希缓存 ⇒ 同一条旧消息每次出网形态一致 ⇒ 前缀稳定 | 在**代理通道**上不自己发 HTTP（见下）—— 它把请求交回 `llm` 服务，凭据仍由服务按上游 id 解析 ⇒ **不需要新 API key** |
| 失败即放行（fail-open）：任何异常只写日志，请求照常发 | 日志不记录消息内容（只记字符数、策略名与计数） |
| **可选**：`exec` / `http` / `inline` 三种 op 可用于"你自己接入的塑形" | 默认**不做脱敏**（无内置密钥/隐私识别规则；脱敏需你在 `redact` 槽位注入） |

> ⚠️ 最后两行的边界不要混淆：**代理通道本身不发 HTTP**（它复用 llm 服务），
> 但你**显式配置** `http` op 时它会 `POST` 到你指定的 endpoint；配 `exec` 时会起子进程。
> 两者都只在你配置之后才发生（详见 [`SECURITY.md`](SECURITY.md) 的"它会访问什么"）。

## 官方栈已经做了什么（先读这个）

**DSH 自带栈里已经有一个确定性免费剪枝器和一个摘要压缩器。** 装本插件之前请先确认你要的是
本插件的空位：

| 组件 | 触发条件 | 代价 | 模型视角 |
|---|---|---|---|
| `tool-result-pruner`（默认**开**） | 单条 tool result > `thresholdChars`（8192） | **零**（纯函数、逐条独立 ⇒ 不破前缀） | 中段换成剪枝标记，保留头 4096 + 尾 1024 |
| `compaction-basic`（默认**开**） | prompt 达 `thresholdRatio × 窗口`（0.8），保留 `retainRatio`（0.16） | **一次断点**（全价重算） | 老历史被 LLM 摘要**取代**（不可逆） |
| **本插件** | 每次出网 | **零**（前缀单调） | 按类别塑形后的版本；原文仍在日志里 |

**空位只有三处**：① 推理内容（官方剪枝器完全不碰，而它是日志里最大宗的 payload：
本机 40,916 条 `reasoning-chunks` vs 20,570 条 `assistant/chunk`）；
② 按类别的策略（官方只有一个全局字符阈值）；③ 保留原文的 wire 级塑形（压缩不可逆）。

细节与出处：[`docs/OFFICIAL-STACK.md`](docs/OFFICIAL-STACK.md)。

## 安装

```powershell
# 路径换成你放本包的位置
dsh plugin --profile web add "file:D:\plugins\dsh-entry-shaper"
```

或手动：把目录复制进 `<profile>\node_modules\`，并把 `dsh-entry-shaper` 加进 profile
`package.json` 的 `dependencies` **与 `dsh.profile.bundles`**（后者决定它是否被加载；
`dsh.bundle.patch` 必须仍指向本包的 `cordis.patch.yml`，否则启动即抛错）。

## 配置

**配置一律放在 `~/.dsh-entry-shaper.config.json`，不要写进 `cordis.patch.yml`。**
原因：patch 里含 `config:` 行会让市场**无法热挂载**（`dshmarket/lib/hot.js:295`），
只能重启生效；热配置文件则由本插件按 mtime 热读 ⇒ 改配置**不用重启** ✓。

```jsonc
{
  "enabled": true,              // 总开关（任何类别都不动就设 false）
  "shapeReasoning": true,       // 是否塑形推理这一类（旧名 dropReasoning 仍兼容）
  "policy": {                   // 按类别各给一条 op 序列（文本 → 文本 的纯函数链）
    "reasoning":     { "ops": [{ "op": "extract", "maxChars": 240 }] },
    "toolResult":    { "ops": [{ "op": "keep" }] },
    "toolArgs":      { "ops": [{ "op": "keep" }] },
    "assistantText": { "ops": [{ "op": "keep" }] }
  },
  "cache": { "enabled": true, "path": "~/.dsh-entry-shaper.cache.jsonl", "maxBytes": 8388608 },
  "proxy": { "enabled": true, "provider": "deepseek-shaped", "upstream": "deepseek-official" },
  "opTimeoutMs": 8000,
  "logPath": "~/.dsh-entry-shaper.log"
}
```

**打开代理只需改这里**（`proxy.enabled: true`），本插件会**惰性注册**该路由 —— 不必重挂载、
不必重启 ✓。随后把会话或默认 provider 换成 `proxy.provider`（默认 `deepseek-shaped`）即生效。

> ⚠️ **路径里不要写 `~`**。配置文件里的路径是**原样使用**的（没有 shell 展开），
> 写 `"logPath": "~/.dsh-entry-shaper.log"` 会在当前目录下建一个名叫 `~` 的目录 ✗。
> **省略这些键**（推荐，默认值已经是正确的绝对路径），或写绝对路径
> （如 `"D:/logs/shaper.log"`）。

### 免重启的三个开关

| 想做什么 | 怎么做 | 生效 |
|---|---|---|
| 全部停手（原样转发） | 建空文件 `~/.dsh-entry-shaper.OFF` | **立刻**，不用重启 |
| 只停某一类 | 把该类别的 ops 改成 `[{ "op": "keep" }]` | 下一次请求 |
| 完全卸载 | 市场里关掉插件（或从 `dsh.profile.bundles` 移除） | 立刻（热挂载） |

> ⚠️ **改配置会改变前缀形态** ⇒ 下一次请求整份按全价重算一次（约 $0.2）。
> 所以请一次定好，别频繁来回调。

## 三种挂载方式

| 方式 | 命令 / 操作 | 需要重启吗 | 说明 |
|---|---|---|---|
| profile bundle | `dsh plugin --profile web add "file:…"` 或手改 profile `package.json` | **需要** | 最稳，随 profile 长期加载 |
| 市场热挂载 | 在市场插件页点开关 | **不需要** | 要求 patch 是**纯 insert**（本包已满足）；窗口期不影响已有会话 |
| 直接 mount | 手工在一个 cordis 上下文里 `ctx.plugin(module)` | 不需要 | 用于实验 |

**热挂载的两条硬限制**（实测）：

1. **不刷新模块缓存** —— 重挂载只新建实例，代码改动仍需重启；
2. 热挂载条目的 id 是 `mkt-<原id>`，与 patch 层的 `- id: <原id>` **不是同一个条目**
   ⇒ patch 层的 `disabled: true` 管不住热挂载实例。

## 统一协议：一切外部塑形都走同一套 I/O 约定

**op 名只表示"传输方式"，不表示"这是 .py / 这是 LLM"**。任何语言、任何命令、任何
OpenAI 兼容端点，都通过同一套信封与返回规则接入 —— 这是本插件唯一的扩展接口。

```
                        传输（transport）
        ┌──────────────────┬──────────────────┬─────────────────┐
   exec │ 本地进程          │ http │ 任何 HTTP   │ inline │ 进程内 │
        │ python/node/pwsh │      │ 端点        │        │ 纯算法 │
        │ /你的 exe        │      │             │        │        │
        └──────────────────┴──────────────────┴─────────────────┘
                 ↕ 数据格式（protocol）
        json │ text │ lines │ argv        （exec 用；http 用 json/text）
```

### 输入信封（每次调用必送）

```json
{ "text": "<待塑形文本>", "kind": "reasoning|toolResult|toolArgs|assistantText",
  "meta": { }, "op": "exec", "protocol": 1 }
```

`protocol: 1` 是**协议版本号** —— 你的脚本可以据此判断该怎么解析。

### 返回值（三种形态都接受，按序判定）

| # | 你输出什么 | 插件怎么理解 |
|---|---|---|
| 1 | JSON 对象含字符串 `text` | 用这个 `text` |
| 2 | JSON 对象含 `"text": null` | **整块删除** |
| 3 | 其它任何字符串 | 取原文（trim 后） |

**失败只跳过该 op**（退出码≠0 / 超时 / 输出空 / 抛错）⇒ 保留上一步结果。

### `exec`：任何命令

```jsonc
{ "op": "exec", "command": "python", "script": "D:/shaper/mine.py" }
{ "op": "exec", "command": "node",   "args": ["D:/shaper/mine.mjs"] }
{ "op": "exec", "command": "pwsh",   "args": ["-File", "D:/shaper/mine.ps1"] }
{ "op": "exec", "command": "D:/tools/shaper.exe", "args": ["--mode", "fast"] }
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `command` | **必填** | 可执行文件（python / node / pwsh / 你的 exe） |
| `script` | — | 便捷写法：作为第一个参数。`args` 里的 `{}` 会被替换成它 |
| `args` | `[]` | 参数数组；`{text}` 会被替换成待塑形文本（仅 `argv` 协议需要） |
| `protocol` | `json` | 输入格式，见下 |
| `cwd` / `env` | — | 工作目录 / **追加**的环境变量（与 `process.env` 合并） |
| `timeoutMs` | 全局值 | 超时即 kill 并跳过 |

| `protocol` | stdin 收到 | 适合 |
|---|---|---|
| `json` | 一行信封 JSON | 新写的脚本（**推荐**） |
| `text` | 纯文本 | 只想要原文的现成工具 |
| `lines` | 第一行 = `kind`，其余 = 文本 | shell 友好的轻量写法 |
| `argv` | **不写 stdin**，文本作为最后一个命令行参数 | 不接受 stdin 的现成程序（注意命令行长度上限） |

> ⚠️ **Windows 上的 Python 中文乱码**：Python 往管道写非 ASCII 时默认用系统代码页
> （GBK/cp936），插件按 utf8 解码 ⇒ 中文变 `????`。**插件已替 `python` 自动设好
> `PYTHONIOENCODING=utf-8`**（你在 `env` 里给同名键即可覆盖），但脚本里自己写一句
> `sys.stdout.reconfigure(encoding="utf-8")` 更稳妥。注意 `python -X utf8` **不能**解决
> 这个问题（那条只管源码与文件，不管管道）。

### `http`：任何 OpenAI 兼容端点

```jsonc
// 标准 OpenAI 形状：system 提示词 + 待塑形文本作为 user 消息
{ "op": "http", "baseURL": "https://api.deepseek.com", "model": "deepseek-flash",
  "system": "压成 3 行要点，保留路径与数字。", "maxTokens": 200 }

// 追加一条微调指令（作为第二条 system 消息）
{ "op": "http", "url": "https://gateway/v1/chat/completions", "system": "…", "instruction": "再简短些" }

// 非 OpenAI 形状的服务：body 整包覆盖（{{text}} 会被替换成待塑形文本）
{ "op": "http", "url": "https://my.example/shaper", "body": { "input": "{{text}}", "mode": "fast" } }
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `url` | — | 完整端点（给了它就原样使用） |
| `baseURL` | `ctx.llm.baseURL` → DeepSeek 官方 | 自动补 `/chat/completions` |
| `system` | 内置中文提示词 | **系统提示词**（旧名 `prompt` 仍可用） |
| `instruction` | — | 追加的第二条 system 消息（微调用） |
| `apiKey` | `ctx.llm.apiKey` → `DEEPSEEK_API_KEY` | Bearer 令牌 |
| `model` / `maxTokens` / `temperature` / `headers` / `method` | — | 常规请求控制 |
| `body` | — | **整包覆盖**请求体（接非 OpenAI 形状时用） |
| `protocol` | `json` | `text` ⇒ 响应体当纯文本 |

响应解析（`json` 协议）按序尝试：`choices[0].message.content` → `text` → `output` → `content`
→ `data` → 响应原文。**所以大多数兼容服务不用改配置就能用。**

### `inline`：进程内算法（不必写脚本、不必起进程）

```jsonc
{ "op": "inline", "use": "firstLine", "maxLines": 3 }          // 只留前 3 行
{ "op": "inline", "use": "jsonField", "field": "a.b.c" }        // 从 JSON 里取字段
{ "op": "inline", "use": "regex", "pattern": "id=(\\d+)", "template": "#$1" }
{ "op": "inline", "use": "code", "code": "return text.split('\\n').slice(-5).join('\\n')" }
```

`use: "code"` 的 `code` 是**函数体源码字符串**（可用 `text` / `op` / `ctx`，`return` 结果）
⇒ **能写进热配置文件 ⇒ 改算法不用重启** ✓。它无法被证明是纯函数，因此**总是走缓存**。

### 纯 op：不改结构，只挑内容

| op | 参数 | 说明 |
|---|---|---|
| `keep` | — | 原样（默认） |
| `drop` | — | 整块删除（**推理块例外**：内核退回短桩，见下） |
| `stub` | — | 用 `stubTemplate`，默认 `[reasoning omitted: {chars} chars]` |
| `extract` | `maxChars`(240)<br>`marker`(true) | 只留决策句；`marker:false` 去掉省略前缀 |
| `head` / `tail` | `chars`(512) | 保留前 / 后 N 字符 |
| `truncate` | `maxChars`(512) | 首尾各半 + `…（省略 N 字符）…` |

**每个 op 都可以带** `timeoutMs`（覆盖超时）与 `cache: false`（**非纯 op 别关**）。

### 复制即用的配置片段

```jsonc
// ① 默认：推理只留决策句（最省，也最有损）
"reasoning": { "ops": [{ "op": "extract", "maxChars": 240 }] }
// ② 保守：保留推理的真实开头（不按句式挑，模型更容易接上）
"reasoning": { "ops": [{ "op": "head", "chars": 800 }] }
// ③ 两道闸：先抽取再兜底截断
"reasoning": { "ops": [{ "op": "extract", "maxChars": 400 }, { "op": "truncate", "maxChars": 300 }] }
// ④ 完全不动推理
"reasoning": { "ops": [{ "op": "keep" }] }
// ⑤ 工具结果只留首尾（注意官方 tool-result-pruner 已在做，别重复）
"toolResult": { "ops": [{ "op": "truncate", "maxChars": 1024 }] }
// ⑥ 你自己的脚本（任何语言）
"reasoning": { "ops": [{ "op": "exec", "command": "python", "script": "D:/shaper/mine.py" }] }
// ⑦ 让 LLM 来压
"reasoning": { "ops": [{ "op": "http", "system": "压成 3 行要点，保留路径与数字。", "maxTokens": 200 }] }
// ⑧ 进程内自定义算法（免重启）
"reasoning": { "ops": [{ "op": "inline", "use": "code", "code": "return text.split('\\n').slice(-5).join('\\n')" }] }
```

### 旧名（仍可用，但不建议新写）

`python` 是 `exec` 的别名（预填 `command: "python"`），`summarize` 是 `http` 的别名
（`prompt` 即 `system`）。两者走**同一套实现** ⇒ 缓存与失败语义完全一致。
它们存在的唯一理由是兼容旧配置；新配置请直接用 `exec` / `http`。

op 可任意链式组合，**可以是 async**，统一受 `opTimeoutMs`（默认 8s）约束：超时或抛错
⇒ **只跳过该 op**、保留上一步结果（fail-open）—— 最坏情况是"没省到"，绝不会挂住会话。
未知 op 名同样被跳过（拼错名字不会让整条链失效）。

### 链式组合：七条性质（全部实测）

**线性可组合性**的意思是：每个 op 都是 `文本 → 文本`（或 `→ null`），
**前一个的返回值就是后一个的入参**，而 op 的**来源完全无关**。内核里只有一个载体 ——
`applyOps` 的局部变量 `out`：

```js
let out = text
for (const op of ops) {
  const produced = await withTimeout(fn(out, op, ctx), op.timeoutMs ?? ctx.opTimeoutMs ?? 8000)
  out = produced
  if (out === null || out === undefined) return null   // ① 立即终止整条链
}
return out
```

| # | 性质 | 实测 |
|---|---|---|
| 1 | **线性**：前一个的输出即后一个的输入 | `'a-b-c'` 经 `[replace(-→+), toUpperCase, replace(+→\|)]` ⇒ `"A\|B+C"` |
| 2 | **异构混排**：纯函数 / 本地进程 / HTTP / 进程内 可插在任何位置 | `[head, exec(python), http, inline.regex, truncate]` ⇒ `"原始文本[llm]尾巴"` |
| 3 | **逐 op fail-open**：一个坏掉不毁整条链 | `[A, exec(不存在的命令), AB, ABC]` ⇒ `"ABC"`（日志：`op exec 失败，跳过`） |
| 4 | **逐 op 超时**：慢 op 被跳过，其余照常 | `[http(挂起, timeoutMs:50), inline]` ⇒ 后续 op 的结果正常返回 |
| 5 | **提前终止**：返回 `null` ⇒ 整条链立即结束 | `[stub, drop, 不应出现]` ⇒ `null`（第三个 op 根本没执行） |
| 6 | **逐 op 缓存**：纯 op 不缓存，其余各自缓存 | 同一输入跑两次，结果**逐字节相同**且真实 HTTP 只调用 **1 次** ⇒ 这就是前缀稳定的根据 |
| 7 | **逐 op 覆盖**：同 op 名可在链上多次出现、各带参数 | `[head(6), tail(3), truncate(30)]` 作用于 `一二三四五六七八九十` ⇒ `"四五六"` |

`timeoutMs` / `cache` 也可以**每个 op 单独写**。

**最实用的一条结论：换实现不动架构。** 同一个位置可以是纯函数、子进程、本地 LLM 或云端 ——
`policy` 里只改那**一个**对象。例如把默认的决策句抽取升级为"本地 LLM 语义压缩"：

```jsonc
// 之前
"reasoning": { "ops": [{ "op": "extract", "maxChars": 240 }] }
// 之后（其余一切照旧：缓存、超时、fail-open、代理链路）
"reasoning": { "ops": [{ "op": "http", "baseURL": "http://127.0.0.1:11434/v1",
                         "model": "qwen2.5:7b", "system": "压成 3 行要点。", "timeoutMs": 3000 }] }
```

⚠️ 两个实测发现的细节：
- **`inline.regex` 默认只替换第一处**，要全局替换需显式加 `"flags": "g"`；
- 直接调用导出的 `applyOps`（不经 `apply()`）时，`inline.code` 需要你自备
  `ctx.compileInline`（插件运行时由 `apply()` 提供）。

上面七条可以自己跑一遍复现：`node examples/compose-demo.mjs`（会真实启动一个 python
子进程；无法启动时 fail-open 跳过该 op，其余性质照常验证）。

### 接自己的算法：三条路怎么选

| 方式 | 写法 | 能热改吗 | 适合 |
|---|---|---|---|
| **组合内置 op** | `[{ "op": "extract" }, { "op": "truncate" }]` | ✅ | 大多数场景，先用这个 |
| **`exec` 外部脚本** | 任何语言，读 stdin / 写 stdout | ✅ | 任意算法；可单独调试 |
| **`inline.code`** | 函数体源码写在配置里 | ✅ | 不想起进程的小逻辑 |
| **`config.ops` 注入函数** | patch 里写 `config.ops` | ❌ 需重启 | 需要进程内状态/依赖时 |

> ⚠️ **注入函数会牺牲热挂载**：patch 出现 `config:` 行 ⇒ `dshmarket/lib/hot.js:295`
> 判定为"含配置行"⇒ 本插件失去热挂载能力。同一件事能用前三条做就别用第四条。
> `ctx.llm` / `ctx.redact` / `ctx.fetch` / `ctx.spawn` 同理（函数与凭据写不进 JSON）。
>
> ⚠️ **自定义 op 也会进缓存**：无法判断你的实现是否纯，而"结果漂移 ⇒ 前缀改变 ⇒ 付断点税"
> 比"多占几 KB 磁盘"贵得多。**不同实现请用不同的 op 名字** —— 缓存键里只有名字与参数。

完整配置文件见 [`examples/config.full.json`](examples/config.full.json)，
接入自定义算法的详解见 [`examples/custom-op.md`](examples/custom-op.md)。

### 非纯 op 必须缓存（前缀稳定性的前提）

`python` / `summarize` **不保证可复现**（temperature 0 也不保证：批处理、MoE 路由、服务端版本、
并发都可能变）。同一条旧消息两次出网算出不同结果 ⇒ **前缀改变 ⇒ 付断点税**。
所以非纯 op 的结果按 `sha256(配置指纹 + op 参数 + 输入文本)` 缓存：

| 性质 | 行为 |
|---|---|
| 改 prompt / model / 端点 | 键变化 ⇒ 自动失效 ✓ |
| 重启 DSH | 仍命中 ✓（启动时把 JSONL 读进内存）⇒ 重启不打断前缀 |
| 存了什么 | 只存**摘要**，不存原文 ✓ |

### 一条硬约束（踩过）

**推理块永远不会被整块删除。** thinking 模式下，当报文以 `role:'tool'` 结果结尾时缺少
`reasoning_content` 会被 API 拒绝：

```
400 The `reasoning_content` in the thinking mode must be passed back to the API.
```

换成短桩则 200 ⇒ API 要的是**字段在**，不是内容全。所以内核在链把它删空时会退回短桩
（`test/shaping.test.mjs` 有对应用例）。

## 栈护栏

| # | 护栏 | 实现 |
|---|---|---|
| 1 | 只处理原始追加事件 | `surfaceOp !== 'append'` 一律跳过 |
| 2 | 替换范围恰为自己 | `{ op: 'replace', start: seq, end: seq }` ⇒ 从不触碰更早的 seq |
| 3 | 元素若已不在当前表面（被别人替换/被压缩覆盖）⇒ 放弃 | `session.surface.nodes` 成员检查 |
| 4 | 异步 op 超时即跳过，并量"追加 → 定型"延迟 | `opTimeoutMs` + `lagWarnMs` |

代理通道在**出网的那一份 messages 上**塑形（`shapeMessages()`），但**这不等于会话不被改动**：
实测模型返回的推理 chunk 已是塑形形态，而 `agent-loop/src/agent.ts:348` 会把中间件之后的
每个 chunk `session.append` 进会话 ⇒ **会话里存的也是塑形后的文本**。
换句话说"不碰会话"这个说法**不准确**，见 [`docs/POLLUTION.md`](docs/POLLUTION.md)。
它继承"**确定性**"这一条：纯 op 天然确定，非纯 op 靠缓存兜住 ⇒ 同一输入永远同一形态。

## 实测数据

全部为本机真实会话 / 真实 API 的实测。

### 1. wire 级塑形：−40.1%，缓存命中 99.3%

用 `dsh-llm-tap` 抓到的真实出网请求，把**外层**（`deepseek-shaped`，塑形前）与
**内层**（`deepseek-official`，真正出网）按 `callId` 配对（`messageCount` 完全相同 ⇒ 同一次调用）：

| | 字符数 |
|---|---|
| 外层（塑形前） | 12,814,907 |
| 内层（塑形后） | 7,678,485 |
| **省** | **5,136,422（40.1%）**，逐对 39.6%–40.4% |

同一会话的 `assistant/message.usage`：命中 **99.3%**（如 hit 191,872 / miss 1,270），
且命中量每步按上一步新增量平稳递增 ⇒ **前缀在延长、没有被重建** ✓

**折成钱**：省下的是**命中价** token（$0.02/M）⇒ 按 193K token/步 估算约 **$0.0015/步**，
300 步的长会话约 **$0.46**（≈3 元）。**不大，但是白拿的** —— 而且与轨迹长度成正比。

> 对照：一次断点付的是**整份 payload 全价**（$1/M）。所以"省 40% 的命中价"和"招来一次断点"
> 完全不是一个量级 —— 这也是为什么**前缀单调**比"省得多"更重要。

### 1b. 成本结构实测：钱到底花在哪（2026-09 多会话审计）

这部分**与本插件无关**，但决定了它值不值 —— 实测自本机 9 天/2739 步（759,991,919 输入）
与 7 天/1085 步（380,897,683 输入）两个长会话：

| 事实 | 实测 |
|---|---|
| **成本 ≈ 步数 × payload** | 单回合 `18 步 × 峰值 payload 507,255 = 输入 9,061,476`（$0.67）；其余回合同样吻合 |
| **未命中只占输入 ~1.6%，却占 ~57% 的钱** | 命中价 / 未命中价 = `$0.02 / $1`（相差 50 倍） |
| **最大单项支出是"断点税"** | 2739 步会话：182 次断点、断点税占未命中的 **87%**（$10.59 / 总 $27.08） |
| **断点主因是"隔太久回来"（缓存 TTL）** | 间隔 1060 min → miss 497,394；间隔 7158 min → miss 266,259；而间隔 0.1 min 的步 miss 仅 ~500–1,400 |

**间隔 vs 平均命中率**（同一会话 2694 步全样本，实测）：

| 距上一步 | 样本 | 平均命中率 |
|---|---|---|
| `<1 min` | 2501 | 96.7% |
| `1–3 min` | 118 | 94.6% |
| `3–6 min` | 46 | 90.0% |
| `6–15 min` | 13 | 66.2% |
| `>15 min` | 17 | 63.2% |

⇒ **"隔一会儿回来"的罚金 = 整份 payload 全价**，而这正是本插件能间接帮上忙的地方：
payload 减半 ⇒ 同样一次隔夜回来的罚金也同比减少约 46% ✓。

**另外两个与插件无关、但会瞬间把账单打穿的放大源**（实测踩过）：

| 放大源 | 机制 | 实测 |
|---|---|---|
| **搜索** `web_search` | 一次请求 = 服务端**最多 5 个模型回合**（`max_uses` 默认 5），结果轮间累积；**这些轮次的 usage 不进会话日志** ⇒ 本地账本里是零 | 9 个会话 7 分钟内共 221 次搜索，平台账单比本地日志多 ≈ $5 |
| **子代理递归扇出** | 主会话开子代理 → 子代理**又各自开子代理**，前缀完全不共享（缓存零复用） | 1 → 3 → 9 个并行会话，全部挤在 7 分钟内 |

> 这两条的启示：**本插件不会造成任何放大**（它只在出网前做纯函数变换、不发请求），
> 但它省的量级也远小于"一次搜索风暴" —— 排障时先看这两项，再看压缩/缓存。

### 2. 离线基准（可复现）

固定轨迹重放：真实会话里同一轮内连续 12 次工具调用当剧本，两臂逐轮发前缀请求。

| 轮次 | payload 字符（full → stub） | 省 |
|---|---|---|
| 1 | 3,809 → 3,204 | 15.9% |
| 4 | 33,769 → 21,484 | 36.4% |
| 8 | 76,720 → 36,938 | 51.9% |
| **12** | **100,893 → 51,617** | **48.8%** |

命令：`node bench/replay.mjs <session.jsonl.zstd> --dry`

### 3. 行为分歧（真实历史，同一前缀发两次）

| 档位 | 纯桩 `stub` | **决策抽取 `extract`** |
|---|---|---|
| 动作类型（工具 vs 直接答复） | 12/17（71%） | **15/17（88%）** |
| 同名工具 | 2/17（12%） | **6/17（35%）** |
| 完全一致 | 0/17 | 0/17 |

⇒ `extract` 每档都 ≥ `stub`，体积只多 1.8 个百分点 ⇒ **`extract` 支配 `stub`**（默认值）。
N=17 的配对样本不足以做强断言。

### 4. agentic 基准（多轮工具调用 + 确定性判分）

8 个短任务 + 3 个长轨迹任务（初始文件 + 提示 + 检查器）：

| 臂 | 成功率 | 轮数 | 输入 token |
|---|---|---|---|
| `full`（短任务 8 个） | 8/8 | 35 | 31,580 |
| `stub`（短任务 8 个） | 8/8 | 37 | 33,322 |
| `full`（长轨迹 3 个） | 3/3 | 21 | 55,092 |
| `stub`（长轨迹 3 个） | 3/3 | 21 | 49,074 |

**质量未观察到退化**；成本列**不可信**（两臂会跑出不同的命令与输出，未命中被"这轮干了什么"
污染）⇒ 成本请看固定轨迹重放。

> ⚠️ **在线成本 A/B 不可信**：曾跑出"−77%"，但反序重跑后另一臂得到**完全相同**的数字
> ⇒ 那是"谁第二个跑谁几乎全命中"的缓存复用假象，**已撤回**。

## 现状与限制

- **默认关闭**：本包默认 `enabled: false`，需要你确认可接受"模型只看得到推理精要"这一点；
- **推理是有损的**：`extract` 只留决策句（默认 240 字符预算），探索与试错过程不进 payload
  ⇒ 模型可能在长轨迹上重复劳动。**原文可用侧路寄存表回溯**
  （`node tools/original.mjs`，每轮清空、只覆盖当前轮 —— 见 [`docs/POLLUTION.md`](docs/POLLUTION.md)）；
  觉得太紧就换 `head`（保留真实开头）或放宽 `maxChars`（代价：省幅下降）；
- **默认只塑形推理**：`toolResult` / `toolArgs` / `assistantText` 默认 `keep`。
  官方 `tool-result-pruner` 已在做工具结果剪枝，先别重复造轮子；
- **任务偏短**：agentic 基准的任务规模仍小于真实长会话，长轨迹任务（15–30 轮 + 大体量
  工具输出）还在补；
- **基准边界**：行为分歧测的是"是否被改变"，不是"是否更好"。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 模型选择器里看不到代理 | ① 之前踩过：`listModels()` 未把 `provider` 改盖成本路由 id ⇒ 整组被判 `INVALID_CATALOG` 而不显示（已修 0.9.3）；② **重启后的短暂窗口**：`ctx.get('llm')` 在 `apply()` 时尚未就绪，提供方要等注册成功才出现（1.0.1 起启动期主动重试，日志有 `proxy 等待 llm 服务就绪` / `WARN …仍未注册成功`）。自查：`POST /api/llm.models` 看 `failures`；选择器目录**按会话缓存**，刷新页面再看 |
| 日志有 `proxy 注册失败：adapter.xxx is not a function` | 适配器缺运行时要求的成员。运行时调用 `providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel` / `prepareCall` / `stream` **全部**（`packages/llm/llm/src/index.ts`）。已修（0.9.2） |
| 热挂载后行为没变 | 热挂载**不刷新模块缓存** ⇒ 代码改动必须重启；只有配置与开关能热改 |
| **改了源码、重启了、行为仍是旧的** | `dsh plugin --profile web add "file:…"` 装的是**物理副本**，不是符号链接（实测：`node_modules/dsh-entry-shaper` 既非 symlink，`realpath` 也不等于源码目录）。⇒ **只改源码目录永远不会生效**，必须把改动**复制进** `<profile>\node_modules\dsh-entry-shaper\`（或重新 `dsh plugin … add`）。自查三行：比对两处 `index.js` 的 SHA256、看 `package.json` 的 `version`、看插件日志最后一条 `applied` 的时间戳是否晚于进程启动时间 |
| 看得到省了多少吗 | 日志里 `proxy-shape #n chars=A→B（累计 …）`（前 3 次 + 之后每 20 次一行） |
| 想验证出网内容 | 装 `dsh-llm-tap` 看 `~/.dsh-llm-tap/llm-tap.jsonl`，或读本插件日志的字符统计 |
| 账单突然打穿 | **先怀疑搜索与子代理扇出，不是本插件**：`web_search` 一次请求 = 服务端最多 5 个模型回合（`max_uses` 默认 5）且这些轮次的 usage **不进会话日志**；子代理又会各自开子代理 ⇒ 并行前缀不共享、缓存零复用。见[§ 1b](#1b-成本结构实测钱到底花在哪2026-09-多会话审计) |
| 突然行为异常 | 建 `~/.dsh-entry-shaper.OFF` 立停（原样转发），再排查 |

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/OFFICIAL-STACK.md`](docs/OFFICIAL-STACK.md) | 官方三层（pruner / compaction / command-compact）的位置与阈值、一次 `/compact` 的实测账单、本插件的空位 |
| [`docs/PIPELINE.md`](docs/PIPELINE.md) | 工作管道：总图、时序（含 harness 源码出处）、元素生命周期、降级路径、验收观测点 |
| [`docs/PROCESSING.md`](docs/PROCESSING.md) | 处理层规范：统一协议、op 目录、里程碑与被否掉的方案 |
| [`docs/POLLUTION.md`](docs/POLLUTION.md) | **塑形标记如何污染模型**：wire 级取证、根治方案（默认去前缀）、原文寄存表与每轮清空策略、排查这类问题时的正确判据 |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | "省了多少"的独立核验：两路互不依赖的口径交叉验证、可信度分级、一次失败的重放尝试 |
| [`docs/USAGE-LEDGER.md`](docs/USAGE-LEDGER.md) | 权威用量账本：费用结构、为何"命中率已到顶"、费用集中度与规模趋势 |
| [`examples/custom-op.md`](examples/custom-op.md) | 接入自定义算法的五条路径 + 函数契约 + 热挂载取舍表 |
| [`tools/README.md`](tools/README.md) | 会话体检与排障脚本（11 个，只读、零依赖）：命中率/断点/成本/搜索与子代理扇出定位 |
| [`CHANGELOG.md`](CHANGELOG.md) | 变更记录（含被基准否掉的方案与踩过的坑） |
| [`SECURITY.md`](SECURITY.md) | 边界与失败模式（含"本插件不做脱敏"这一明确边界） |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 改动前必读（6 条硬规则 + 发版前验证清单） |

## 开发

```powershell
node test/run-all.mjs                                          # 单测（81 例，无需 DSH 运行时）
node test/shaping.test.mjs                                     # 同上（直接跑，沙箱友好）
node bench/replay.mjs "<session.jsonl.zstd>" --dry             # 固定轨迹重放
node bench/divergence.mjs "<session.jsonl.zstd>" --cases=20    # 行为分歧
node bench/agentic/runner.mjs --max-rounds=20                  # agentic 基准（需真实 shell）
```

> `node --test test/` 在受限沙箱下会因 `spawn EPERM`（运行器要管道）失败 ——
> 那是沙箱限制，不是测试问题；本地用 `node test/shaping.test.mjs`，CI 用 `node --test`。
> 基准与检查器需要能捕获子进程输出的真实 shell；可用 `DSH_BENCH_SHELL` 指定。
>
> 同理：`exec` op 在受限沙箱下也会遇到 `spawn EPERM`（fail-open 会跳过该 op，
> 表现为"没省到"而不是报错）—— 那是沙箱限制，不是插件问题。

### 体检自己的会话（只读、零依赖）

```powershell
node tools/session-health.mjs "$env:USERPROFILE\.dsh\sessions\--D-DSH~0020Desktop--\<会话>\session.jsonl.zstd"
node tools/recount-miss.mjs  "$env:USERPROFILE\.dsh\sessions"          # 多时间口径 + 逐小时
node tools/today-turns.mjs   "$env:USERPROFILE\.dsh\sessions"          # 按回合看成本
node tools/today-tools.mjs   "$env:USERPROFILE\.dsh\sessions"          # 哪个工具把上下文撑大
```

全部用途见 [`tools/README.md`](tools/README.md)。**账单异常时先跑这几个**，
再怀疑本插件 —— 实测最可能的原因是 `web_search`（服务端多回合、usage 不进日志）
与子代理递归扇出，两者量级都远大于本插件省下的量。

## 许可

MIT，见 [`LICENSE`](LICENSE)。
