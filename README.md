# dsh-entry-shaper

> 把上下文压缩从**出口**挪到**入口**：元素在被首次发送之前定型，此后永不改写 ⇒
> payload 前缀永远单调 ⇒ **零断点税**地缩小上下文。

**状态**：实验性 · **默认关闭** · 测试 61/61 · Node ≥ 20 · MIT

**实测**（本机真实会话 + 真实 API）：出网 payload **−40.1%**，缓存命中率 **99.3%**，
日志与界面保留原文。取证方法见[§ 实测数据](#实测数据)。

---

## 目录

- [问题：压缩为什么常常是亏的](#问题压缩为什么常常是亏的)
- [做法：在入口定型](#做法在入口定型)
- [它是什么 / 不是什么](#它是什么--不是什么)
- [官方栈已经做了什么（先读这个）](#官方栈已经做了什么先读这个)
- [安装](#安装)
- [配置](#配置)
- [三种挂载方式](#三种挂载方式)
- [统一协议：一切外部塑形都走同一套 I/O 约定](#统一协议一切外部塑形都走同一套-io-约定)
- [栈护栏](#栈护栏)
- [实测数据](#实测数据)
- [现状与限制](#现状与限制)
- [故障排查](#故障排查)
- [文档](#文档)
- [开发](#开发)
- [许可](#许可)

## 问题：压缩为什么常常是亏的

DSH 的 `compaction` 在**出口**改历史：把已发送的区间换成摘要检查点。这有效，但每一刀都会
打断前缀缓存 —— 从改动点往后**整份 payload 按全价重算**（"断点税"）。在缓存命中价极低的
provider 上（DeepSeek 命中/未命中 ≈ **1/50**），这笔税常常比省下的钱还贵。

本机实测（会话 `session-acde5be7-…`，见 [`docs/OFFICIAL-STACK.md`](docs/OFFICIAL-STACK.md)）：

| 通道 | 削掉的 token | 全价重算（断点税） | 比值 |
|---|---|---|---|
| 官方 `compaction-basic` **自动压缩 109 笔合计** | 3,021,022 | **6,282,630** | **0.48 : 1** ✗ 净亏 2 倍 |
| 其中最差的一笔 | 64,891 | 547,342 | 0.12 : 1 ✗ |
| 人类手动 `/compact`（一次打到底） | 729,434 | 6,176 | **118 : 1** ✓ |

机制在 `packages/compaction/compaction-basic/src/region.ts:98-133`：区间是**头锚定**的
（从最早的表面节点起切到"保留尾部"之前）⇒ 检查点落在**头部** ⇒ 它后面的缓存全部作废。
**削得越少越亏**：税 ≈ 压缩后整份 payload，收益 = 实际削掉的量。

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

| | |
|---|---|
| ✅ 代理 provider：`llm.registerAdapter()` 注册一个新路由，转调上游 | ❌ 不接管 `compaction` 服务（可与官方 `dsh-compaction-basic`、`dsh-context-slimmer` 共存） |
| ✅ 原文永远在 append-only 日志里；界面与审计读原文 | ❌ 不改写**已发送**的内容（那是"出口压缩"的领域，要付断点税） |
| ✅ 塑形是**纯函数**（或带缓存的非纯 op）⇒ 同一条旧消息每次出网形态恒定 ⇒ 前缀稳定 | ❌ 不自己发 HTTP：凭据仍由 llm 服务按上游 id 解析（**不需要新 API key**） |
| ✅ 失败即放行（fail-open）：任何异常只写日志，请求照常发 | ❌ 日志不记录消息内容（只记字符数与策略名） |

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

代理通道不依赖 1–4（它不碰会话），但继承"**确定性**"这一条：纯 op 天然确定，
非纯 op 靠缓存兜住 ⇒ 同一输入永远同一形态。

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
  ⇒ 模型可能在长轨迹上重复劳动。**界面与日志永远保留原文**，所以审计不受影响；
  觉得太紧就换 `head`（保留真实开头）或放宽 `maxChars`（代价：省幅下降）；
- **默认只塑形推理**：`toolResult` / `toolArgs` / `assistantText` 默认 `keep`。
  官方 `tool-result-pruner` 已在做工具结果剪枝，先别重复造轮子；
- **任务偏短**：agentic 基准的任务规模仍小于真实长会话，长轨迹任务（15–30 轮 + 大体量
  工具输出）还在补；
- **基准边界**：行为分歧测的是"是否被改变"，不是"是否更好"。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 模型选择器里看不到代理 | 之前踩过：`listModels()` 未把 `provider` 改盖成本路由 id ⇒ 整组被判 `INVALID_CATALOG` 而不显示。已修（0.9.3）；自查：`POST /api/llm.models` 看 `failures` |
| 日志有 `proxy 注册失败：adapter.xxx is not a function` | 适配器缺运行时要求的成员。运行时调用 `providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel` / `prepareCall` / `stream` **全部**（`packages/llm/llm/src/index.ts`）。已修（0.9.2） |
| 热挂载后行为没变 | 热挂载**不刷新模块缓存** ⇒ 代码改动必须重启；只有配置与开关能热改 |
| 看得到省了多少吗 | 日志里 `proxy-shape #n chars=A→B（累计 …）`（前 3 次 + 之后每 20 次一行） |
| 想验证出网内容 | 装 `dsh-llm-tap` 看 `~/.dsh-llm-tap/llm-tap.jsonl`，或读本插件日志的字符统计 |
| 突然行为异常 | 建 `~/.dsh-entry-shaper.OFF` 立停（原样转发），再排查 |

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/OFFICIAL-STACK.md`](docs/OFFICIAL-STACK.md) | 官方三层（pruner / compaction / command-compact）的位置与阈值、一次 `/compact` 的实测账单、本插件的空位 |
| [`docs/PIPELINE.md`](docs/PIPELINE.md) | 工作管道：总图、时序（含 harness 源码出处）、元素生命周期、降级路径、验收观测点 |
| [`docs/PROCESSING.md`](docs/PROCESSING.md) | 处理层规范：op 目录、协议、里程碑 |
| [`CHANGELOG.md`](CHANGELOG.md) | 变更记录（含被基准否掉的方案与踩过的坑） |
| [`SECURITY.md`](SECURITY.md) | 边界与失败模式 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 改动前必读 |

## 开发

```powershell
node test/run-all.mjs                                          # 单测（61 例，无需 DSH 运行时）
node test/shaping.test.mjs                                     # 同上（直接跑，沙箱友好）
node bench/replay.mjs "<session.jsonl.zstd>" --dry             # 固定轨迹重放
node bench/divergence.mjs "<session.jsonl.zstd>" --cases=20    # 行为分歧
node bench/agentic/runner.mjs --max-rounds=20                  # agentic 基准（需真实 shell）
```

> `node --test test/` 在受限沙箱下会因 `spawn EPERM`（运行器要管道）失败 ——
> 那是沙箱限制，不是测试问题；本地用 `node test/shaping.test.mjs`，CI 用 `node --test`。
> 基准与检查器需要能捕获子进程输出的真实 shell；可用 `DSH_BENCH_SHELL` 指定。

## 许可

MIT，见 [`LICENSE`](LICENSE)。
