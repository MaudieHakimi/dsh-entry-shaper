# 接入你自己的算法（统一协议）

**op 名只表示"传输方式"，不表示"这是 .py / 这是 LLM"。**
python / node / pwsh / 你自己的 exe 都走 `exec`；任何 OpenAI 兼容端点都走 `http`；
进程内小逻辑走 `inline`。三者共用同一套信封与返回规则。

```
输入信封（每次调用必送）
  { "text": "<待塑形文本>", "kind": "reasoning|toolResult|toolArgs|assistantText",
    "meta": { }, "op": "exec", "protocol": 1 }

返回值（三种形态都接受，按序判定）
  1. JSON 对象含字符串 text  ⇒ 用它
  2. JSON 对象含 "text": null ⇒ 整块删除
  3. 其它任何字符串           ⇒ 取原文（trim 后）

失败（退出码≠0 / 超时 / 输出空 / 抛错）⇒ 只跳过该 op，保留上一步结果
```

`protocol: 1` 是协议版本号 —— 脚本可据此判断解析方式（未来不兼容变更时会递增）。

## 组合保证（可以先记这一段）

每个 op 都是 `文本 → 文本`（或 `→ null`），**前一个的返回值就是后一个的入参**；
op 的**来源无关**（纯函数 / 本地进程 / HTTP / 进程内 可插在任何位置）。由此得到：

| 保证 | 说明 |
|---|---|
| **线性** | `ops` 数组顺序 = 执行顺序，无隐藏状态 |
| **失败隔离** | 单个 op 抛错/超时只**跳过它**，保留上一步结果 —— 链不会断 |
| **提前终止** | 返回 `null` ⇒ 整条链立即结束（= 整块删除） |
| **缓存独立** | 纯 op 不缓存；`exec`/`http`/`inline.code`/注入函数各自缓存，`cache: false` 可关单个 |
| **参数独立** | 同一 op 名可在链上出现多次，各带各的参数（`timeoutMs` 也可逐 op 覆盖） |

⇒ **换实现不动架构**：把一个 op 对象从 `exec` 换成 `http`，其余（缓存、超时、fail-open、
代理链路）全部照旧。七条性质的实跑验证见 README「链式组合：七条性质」。

两个实测发现的细节：`inline.regex` **默认只替换第一处**（要全局替换加 `"flags": "g"`）；
直接调 `applyOps` 时 `inline.code` 需自备 `ctx.compileInline`（插件运行时由 `apply()` 提供）。

---

## ① 组合内置 op（先用这个）

不用写代码，改 `~/.dsh-entry-shaper.config.json` 即可，**改完立即生效**：

```jsonc
{
  "policy": {
    "reasoning": { "ops": [
      { "op": "extract", "maxChars": 400 },      // 先抽决策句
      { "op": "truncate", "maxChars": 300 }       // 再兜底截断（两道闸）
    ] }
  }
}
```

---

## ② `exec`：任何命令（任意语言）

### Python

```python
# D:/shaper/mine.py
import json, sys

# ⚠️ Windows 上务必显式指定 UTF-8：
#    Python 往**管道**写非 ASCII 时默认用系统代码页（GBK/cp936），插件按 utf8 解码
#    ⇒ 中文全变 ????（实测踩到）。两条修法任选：
#      ① 插件已替 python 自动设好 PYTHONIOENCODING=utf-8（可被你的 env 覆盖）
#      ② 脚本自己写死，最稳妥：
sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")

req = json.loads(sys.stdin.readline())   # 信封
text, kind = req["text"], req["kind"]

out = text[:200]                         # ── 你的算法 ──

print(json.dumps({"text": out}, ensure_ascii=False))
```

> 注：`python -X utf8` **不能**解决这个问题（那条只管源码与文件，不管管道）。

```jsonc
{ "op": "exec", "command": "python", "script": "D:/shaper/mine.py" }
```

### Node

```js
// D:/shaper/mine.mjs
let raw = ''
for await (const c of process.stdin) raw += c
const { text, kind } = JSON.parse(raw)
process.stdout.write(JSON.stringify({ text: text.slice(0, 200) }))
```

```jsonc
{ "op": "exec", "command": "node", "args": ["D:/shaper/mine.mjs"] }
```

### PowerShell / 你自己的 exe / 任何东西

```jsonc
{ "op": "exec", "command": "pwsh", "args": ["-NoProfile", "-File", "D:/shaper/mine.ps1"] }
{ "op": "exec", "command": "D:/tools/shaper.exe", "args": ["--mode", "fast"] }
```

### 数据格式（`protocol`）

| 值 | stdin 收到 | 适合 |
|---|---|---|
| `json`（默认） | 一行信封 JSON | 新写的脚本，**推荐** |
| `text` | 纯文本 | 只想要原文的现成工具 |
| `lines` | 第一行 = `kind`，其余 = 文本 | shell 友好的轻量写法 |
| `argv` | **不写 stdin**；文本作为**最后一个命令行参数** | 不接受 stdin 的现成程序 |

> `argv` 想自己决定文本在参数里的位置，就在 `args` 里写 `{text}` 占位符
> （注意：用了占位符**同时**也会自动追加一次 ⇒ 想只出现一次就别用占位符）。
> 另外命令行有长度上限（Windows 约 32K 字符）——长文本请用 stdin 协议。

### 其它参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `command` | **必填** | 可执行文件 |
| `script` | — | 便捷写法：作为第一个参数。`args` 里的 `{}` 会被替换成它 |
| `args` | `[]` | 参数数组 |
| `cwd` | 进程当前目录 | 工作目录 |
| `env` | — | **追加**的环境变量（与 `process.env` 合并，不是替换） |
| `timeoutMs` | 全局 `opTimeoutMs` | 超时即 kill 并跳过该 op |

调试技巧：脚本可以单独跑 —— `echo '{"text":"hello","kind":"reasoning"}' | python mine.py`。

> **会进缓存**：同一输入的结果记在 `~/.dsh-entry-shaper.cache.jsonl`
> （键 = 配置指纹 + op 参数 + 输入）。这是刻意的 —— 结果每次不同 ⇒ 出网前缀改变
> ⇒ 付断点税（比磁盘贵得多）。改了脚本请同时改一个参数或清缓存。

---

## ③ `http`：任何 OpenAI 兼容端点

```jsonc
// 标准形状：system 提示词 + 待塑形文本作为 user 消息
{ "op": "http", "baseURL": "https://api.deepseek.com", "model": "deepseek-flash",
  "system": "压成 3 行要点，保留路径与数字。", "maxTokens": 200 }

// 追加一条微调指令（作为第二条 system 消息）
{ "op": "http", "url": "https://gateway/v1/chat/completions", "system": "…", "instruction": "再简短些" }

// 非 OpenAI 形状的服务：body 整包覆盖（{{text}} 会被替换成待塑形文本）
{ "op": "http", "url": "https://my.example/shaper", "body": { "input": "{{text}}", "mode": "fast" } }
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `url` | — | 完整端点（原样使用） |
| `baseURL` | `ctx.llm.baseURL` → DeepSeek 官方 | 自动补 `/chat/completions` |
| `system` | 内置中文提示词 | 系统提示词（旧名 `prompt` 等价） |
| `instruction` | — | 追加的第二条 system 消息 |
| `apiKey` | `ctx.llm.apiKey` → `DEEPSEEK_API_KEY` | Bearer 令牌 |
| `model` / `maxTokens` / `temperature` / `headers` / `method` | — | 请求控制 |
| `body` | — | **整包覆盖**请求体（此时上面的形状参数全部忽略） |
| `protocol` | `json` | `text` ⇒ 响应体当纯文本 |

响应解析顺序（`json` 协议）：`choices[0].message.content` → `text` → `output` → `content`
→ `data` → 响应原文。**大多数兼容服务不改配置就能用。**

---

## ④ `inline`：进程内算法（不起进程）

```jsonc
{ "op": "inline", "use": "firstLine", "maxLines": 3 }
{ "op": "inline", "use": "jsonField", "field": "a.b.c" }
{ "op": "inline", "use": "regex", "pattern": "id=(\\d+)", "template": "#$1" }
{ "op": "inline", "use": "code", "code": "return text.split('\\n').slice(-5).join('\\n')" }
```

`use: "code"` 的 `code` 是**函数体源码字符串**（可用 `text` / `op` / `ctx`，用 `return` 返回）
⇒ 能写进热配置文件 ⇒ **改算法不用重启** ✓。它无法被证明是纯函数，因此**总是走缓存**。

---

## ⑤ `config.ops`：注入 JS 函数（进程内，但**要重启**）

在 `cordis.patch.yml` 里给这一行加 `config`：

```yaml
- insert:
    - id: dsh-entry-shaper
      name: dsh-entry-shaper
      config:
        ops:
          shout: !<tag:yaml.org,2002:js/function> |-
            function (text) { return '!!!' + String(text).slice(0, 4) + '!!!' }
          myalias: extract        # 纯字符串：把名字映射到内置 op（连函数都不用注入）
```

`policy` 里照常写 `{ "op": "shout" }`（仍放热配置文件 ✓）。

### 函数契约

| 约定 | 说明 |
|---|---|
| 返回 `string` | 作为该 op 的输出，交给链上下一个 op |
| 返回 `null` | 整块删除（**推理块例外**：内核退回短桩，否则 API 会 400） |
| 抛错 / 超时 | 该 op 被跳过，保留上一步结果（fail-open） |
| **必须确定** | 同一输入必须同一输出，否则前缀会变 ⇒ 付断点税。做不到就靠缓存（自动） |
| **名字要唯一** | 缓存键里只有名字与参数，函数体进不了键 ⇒ **不同实现用不同名字** |

### 为什么它会牺牲热挂载

`dshmarket/lib/hot.js:295`：**bundle patch 含配置行/表达式 ⇒ 不能热挂载，只能重启生效**。
注入函数必须往 patch 写 `config:` ⇒ 落进这一条。

| 你用了什么 | 热挂载 | 改配置要重启吗 |
|---|---|---|
| 只改 `~/.dsh-entry-shaper.config.json`（含 ①②③④ 全部参数） | ✅ 可以 | ❌ 不用 |
| patch 里写了 `config:`（⑤，或 `ctx.llm` / `ctx.redact` / `ctx.fetch` / `ctx.spawn`） | ❌ 不行 | ✅ 要重启 |

**同一件事能用前四条做，就别用第五条。** 例：让 `http` 用自己的 `baseURL` / `model` /
`apiKey` 参数（在热配置文件里 ✓），而不是 `ctx.llm`。
