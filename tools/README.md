# tools/ — 会话体检与排障脚本

全部**只读**：只解析 `session.jsonl.zstd`、llm-tap 日志，或插件的侧路寄存表，
不修改任何数据、不发网络请求。**零依赖**，只用 Node 内置模块。

## 它们回答什么问题

| 你想知道 | 用哪个 | 命令 |
|---|---|---|
| 这个会话健康吗？（命中率、断点、每回合成本） | `session-health.mjs` | `node tools/session-health.mjs "<session.jsonl.zstd>" [--tail=20]` |
| 今天/某天的 token 花在哪 | `recount-miss.mjs` | `node tools/recount-miss.mjs "<sessions 根目录>"` |
| 按**回合**看成本，验证"成本 ≈ 步数 × payload" | `today-turns.mjs` | `node tools/today-turns.mjs "<sessions 根目录>" [--day=YYYY-MM-DD] [--top=12]` |
| 今天有哪些**工具结果**进了上下文（会每步重发） | `today-tools.mjs` | `node tools/today-tools.mjs "<sessions 根目录>"` |
| 一个工作区里所有会话的总账 | `cost-all-sessions.mjs` | `node tools/cost-all-sessions.mjs "<工作区目录>" [--hit=0.02] [--miss=1]` |
| 按本地日期逐天统计 | `today-usage.mjs` | `node tools/today-usage.mjs "<sessions 根目录>" [--day=] [--top=15]` |
| 某次"整份未命中"之前发生了什么 | `why-miss.mjs` | `node tools/why-miss.mjs "<session.jsonl.zstd>" [--at=<seq>] [--n=25]` |
| 那个工作区为什么开了 9 个会话？ | `sao-fanout.mjs` | `node tools/sao-fanout.mjs "<工作区目录>"` |
| 今天的搜索请求是谁发起的 | `sao-search-attrib.mjs` | `node tools/sao-search-attrib.mjs "<sessions 根目录>"` |
| 出网 payload 真的被塑形了吗（配对取证） | `pair-wire-shaping.mjs` | `node tools/pair-wire-shaping.mjs "<llm-tap.jsonl>" [字节数]` |
| 同上，但按内容类别统计 | `verify-wire-shaping.mjs` | `node tools/verify-wire-shaping.mjs "<llm-tap.jsonl>" [条数] [字节数]` |
| **把塑形后的推理换回原文**（回溯） | `original.mjs` | `node tools/original.mjs --stats` / `--list` / `"<shaped 文本>"` |

> `original.mjs` 读的是**插件写的侧路寄存表** `~/.dsh-entry-shaper.originals.jsonl`
> （不是只读会话）—— 它是唯一能还原推理原文的地方，**每轮清空**、只覆盖当前轮。
> ⚠️ `llm-tap.jsonl` 可达 **20+ GB**，用 `pair-wire-shaping.mjs` / `verify-wire-shaping.mjs`
> 时务必只读尾部（它们已支持传入字节数参数，内部用 offset 读，不会整读）。

`sessions 根目录` 通常是 `~/.dsh/sessions`（Windows：`$env:USERPROFILE\.dsh\sessions`）；
`工作区目录` 是它下面的某一个 `--D-xxx--` 目录。

## 价格口径

默认 **命中 $0.02/M、未命中 $1/M**（本机账单口径，即命中价便宜 50 倍）。
换 provider 用 `--hit=` / `--miss=` 覆盖。**DSH 自身不含价格表**，成本都是这些脚本按你给的
价格算的。

## 断点是怎么判定的

某一步的未命中 **> max(5000, 10 × 未命中中位数)** ⇒ 计为一次"断点"
（= 前缀被打断、整份重算）。`session-health.mjs` 还会打印每个断点**距上一步的时间间隔** ——
这一点很关键：**间隔很长（几分钟到几小时）的断点是缓存 TTL 过期**，不是插件或压缩造成的。

## 已知的两类"账单打穿"来源（脚本能定位）

1. **搜索**：`web_search` 一次请求 = 服务端**最多 5 个模型回合**（`max_uses` 默认 5），
   且这些轮次的 usage **不进会话日志** ⇒ 本地账本里是零，平台账单里是真金白银。
   用 `sao-search-attrib.mjs` 看它集中在哪个时间窗；
2. **子代理递归扇出**：子代理**又各自开子代理** ⇒ 并行会话前缀不共享、缓存零复用。
   用 `sao-fanout.mjs` 还原时间线。

## 沙箱提示

受限沙箱下**不要**用 `execFileSync` / `spawn` 去调这些脚本（会 `spawn EPERM`）——
它们都是单进程直读，直接用 `node xxx.mjs` 跑即可。
