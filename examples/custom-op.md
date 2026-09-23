# 接入你自己的算法

三种方式，**从简单到复杂**。先用 ①，不够再往下走。

---

## ① 组合内置 op（推荐先试）

不需要写任何代码。改 `~/.dsh-entry-shaper.config.json` 的 `policy` 即可，**改完立即生效**：

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

op 是 `文本 → 文本`，链式连接，前一个的输出是后一个的输入。参数全集见 README 的
「可用 op（参数全集）」。

---

## ② 外部脚本（`python` op）—— 任意语言，也能热改

**协议**（`protocol: "json"`，默认）：stdin 收一行 JSON，stdout 回一行 JSON。

```python
# D:/shaper/my_shaper.py
import json, sys

req = json.loads(sys.stdin.readline())
text = req["text"]          # 待塑形文本
kind = req["kind"]          # "reasoning" | "toolResult" | "toolArgs" | "assistantText"
meta = req["meta"]          # 预留

# ── 你的算法在这里 ──
out = text[:200]

print(json.dumps({"text": out}, ensure_ascii=False))
```

配置：

```jsonc
{
  "policy": {
    "reasoning": { "ops": [
      { "op": "python", "script": "D:/shaper/my_shaper.py", "protocol": "json", "timeoutMs": 3000 }
    ] }
  }
}
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `script` | **必填** | 脚本路径 |
| `command` | `python` | 解释器（Windows 上可能是 `python` / `py` / 绝对路径） |
| `args` | `[]` | 追加到脚本路径之后的参数 |
| `protocol` | `json` | `json` ⇒ stdin 收 `{"text","kind","meta"}`；`text` ⇒ stdin 收纯文本 |
| `timeoutMs` | `8000` | 超时即 kill 并跳过该 op |

输出约定：`{"text": "…"}` 取该字段；否则取 stdout 原文（trim 后）。
**退出码 ≠ 0 / 超时 / 输出为空 ⇒ 跳过该 op**（fail-open，保留上一步结果）。

调试技巧：脚本可以单独跑 —— `echo '{"text":"hello","kind":"reasoning"}' | python my_shaper.py`。

> **会进缓存**：同一输入的结果被记在 `~/.dsh-entry-shaper.cache.jsonl`
> （键 = 配置指纹 + op 参数 + 输入）。这是刻意的 —— 脚本结果若每次不同，
> 出网前缀就会变 ⇒ 付断点税（比磁盘贵得多）。改了脚本请同时改一个参数或清缓存。

---

## ③ 注入 JS 函数（`config.ops`）

在进程内跑，不开子进程。**代价：失去热挂载能力**（原因见最后一节）。

### 写法

在 `cordis.patch.yml` 给这一行加 `config`：

```yaml
- insert:
    - id: dsh-entry-shaper
      name: dsh-entry-shaper
      config:
        ops:
          # 自定义 op：签名 (text, op, ctx) => string | null，可以是 async
          shout: !<tag:yaml.org,2002:js/function> |-
            function (text) { return '!!!' + String(text).slice(0, 4) + '!!!' }
          # 把名字映射到内置 op（纯字符串，连函数都不需要）
          myalias: extract
```

然后 `policy` 里用这个名字（`policy` 仍然放在热配置文件里 ✓）：

```jsonc
{ "policy": { "reasoning": { "ops": [{ "op": "shout" }] } } }
```

### 如果你更愿意写文件而不是内联 YAML

把函数放成一个模块，再用 YAML 的 `!js` 标签引用（具体标签名以你的 DSH 加载器支持为准；
本机的 profile 层已在使用这种自定义标签，例如 `dsh-better-sidebar` 的 patch）：

```yaml
        ops:
          mine: !<tag:yaml.org,2002:js/function> |-
            function (text, op, ctx) {
              // ctx 里可用：stubTemplate / opTimeoutMs / log / cache / fetch / spawn / redact
              return String(text).split('\n')[0]
            }
```

### 函数契约（必须遵守）

| 约定 | 说明 |
|---|---|
| 返回 `string` | 作为该 op 的输出，交给链上下一个 op |
| 返回 `null` | 表示**整块删除**（**推理块例外**：内核会退回短桩，否则 API 会 400） |
| 抛错 / 超时 | 该 op 被跳过，保留上一步结果（fail-open）⇒ 最坏是"没省到" |
| **必须确定** | 同一输入**必须**产出同一输出，否则前缀会变 ⇒ 付断点税。做不到就靠缓存（自动） |
| 名字要唯一 | 缓存键里只有**名字与参数**，函数体无法进键 ⇒ **不同实现请用不同名字** |

### 为什么它会牺牲热挂载

`dshmarket/lib/hot.js:295` 明确规定：**bundle patch 含配置行/表达式 ⇒ 不能热挂载，
只能重启生效**。而注入函数必须往 patch 里写 `config:` ⇒ 就落进了这一条。

| 你用了什么 | 热挂载 | 改配置要重启吗 |
|---|---|---|
| 只改 `~/.dsh-entry-shaper.config.json`（含 ② 的全部参数） | ✅ 可以 | ❌ 不用 |
| patch 里写了 `config:`（③，或 `ctx.llm` / `ctx.redact` / `ctx.fetch` / `ctx.spawn`） | ❌ 不行 | ✅ 要重启 |

**同一件事有两种干法时，优先选不需要 `config:` 的那种**（例如让 `summarize` 用 op 自己的
`baseURL` / `model` / `apiKey` 参数，而不是 `ctx.llm`）。
