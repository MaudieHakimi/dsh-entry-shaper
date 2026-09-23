# dsh-entry-shaper

> 把上下文压缩从**出口**挪到**入口**：元素在被首次发送之前定型，此后永不改写 ⇒
> payload 前缀永远单调 ⇒ **零断点税**地缩小上下文。

**状态**：实验性 · **默认关闭** · 测试 17/17 · [为什么默认关闭](#现状与限制)

---

## 问题

DSH 的 `compaction` 在**出口**改历史：把已发送的区间换成检查点。这有效，但每一刀都会打断
前缀缓存——从改动点往后**整份 payload 全价重发**（"断点税"）。在缓存命中价极低的 provider 上
（DeepSeek 命中/未命中 ≈ 1/50），这笔税常常比省下的钱还贵。

## 做法

会话是一根**只进不出的栈**。元素在被**首次回传之前**定型，前缀里就从来没出现过它的旧形态：

```
请求 n   : [S][T][U][1'][2']…[n-1']
请求 n+1 : [S][T][U][1'][2']…[n-1'][n']
           └──────── 逐字相同的前缀（全命中）────────┘ └ 新增 ┘
```

本插件当前只做一件事：把 `assistant` 消息里的 `reasoning`（思考）**换成一个短桩**。
推理的量很大（实测占追加内容 34.8%），而它**生成于本次调用、首次回传在下一次请求** ——
唯一的定型窗口就在这两者之间。

## 它是什么 / 不是什么

| | |
|---|---|
| ✅ 表面层插件，订阅 `session/event`，用 `surfaceOp: { op: 'replace' }` 定型 | ❌ 不接管 `compaction` 服务（与官方 `dsh-compaction-basic`、`dsh-context-slimmer` 共存） |
| ✅ 原文仍在 append-only 日志里；替换副本是 **model-only**，界面/审计读 append 原文 | ❌ 不改写**已发送**的内容（那是"出口压缩"的领域，要付断点税） |
| ✅ 失败即放行（fail-open）：任何异常只写日志，表面保持原样 | ❌ 不发起任何网络请求、不读写用户文件（除自身日志与熔断哨兵）；日志不记录消息内容 |

## 快速开始

```powershell
# 安装（profile 名按需替换）
dsh plugin --profile web add "file:D:\DSH Desktop\dsh-entry-shaper"
```

或手动：把目录复制进 `<profile>\node_modules\`，并在 profile 的 `package.json` 中把
`dsh-entry-shaper` 加进 `dependencies` 与 `dsh.profile.bundles`（后者决定它是否被加载）。

配置（`cordis.patch.yml`）——**处理层是可组合的 op 序列**：

```yaml
- insert:
    - id: dsh-entry-shaper
      name: dsh-entry-shaper
      config:
        enabled: false             # 默认关闭；确认可接受质量代价后再打开
        dropReasoning: true        # 是否处理 reasoning（总闸）
        policy:                    # 按内容类别各给一条 op 序列（文本 → 文本 的纯函数链）
          reasoning:      { ops: [{ op: extract, maxChars: 240 }] }               # 决策抽取
          toolResult:     { ops: [{ op: truncate, maxChars: 1024 }] }             # 首尾桩；默认 keep
          toolArgs:       { ops: [{ op: keep }] }
          assistantText:  { ops: [{ op: keep }] }
        dropUsageOnReplace: true   # 替换事件不带 usage（否则 token 统计双计）
```

**可用 op**：`keep` · `drop` · `stub` · `extract` · `head` · `tail` · `truncate`（首尾保留 + 省略计数）。
op 可任意链式组合，例如 `[{op: extract}, {op: truncate, maxChars: 80}]`；
未知 op 会被跳过（fail-open）。

> 兼容旧配置：`reasoningMode: extract | stub | drop` 仍然可用，会被折算成 `policy.reasoning.ops`
> （显式 `policy` 优先）。注意 **reasoning 永远不会被整块删除**——thinking 模式下缺字段会被 API
> 拒绝（400），内核会把它退回短桩。

**免重启熔断**：在用户主目录建一个空文件 `~/.dsh-entry-shaper.OFF` 即停手。

验证：

```powershell
Get-Content "$env:USERPROFILE\.dsh-entry-shaper.log" -Tail 20
# applied pid=… enabled=True …            ← 已生效
# strip #1 seq=570 blocks=1 chars=624 provenance=553 项(首/末=17/570)
```

## 实测数据

全部为本机真实会话/真实 API 的实测，脚本在 `bench/`，可复现。

### 1. 规则（决定哪些算法可用）

| 问题 | 结论 | 脚本 |
|---|---|---|
| 缺 `reasoning_content` 会被拒吗？ | 延续工具回路时**会**（400）；末尾有用户消息时不会 | `bench/passback-stub.mjs` |
| 那换成短桩呢？ | **可以**（200）⇒ API 要求**字段在**，不要求内容全 | 同上（变体 I） |
| 体积 | 3,500 字符 → 31 字符（**−99.1%**） | `test/` + 探针 |

### 2. 行为分歧（真实历史，同一前缀发两次）

来源：真实会话的"工具往返"快照，`full`（推理原样）vs 两种塑形；四档一致率（**同批 case 配对比较**）。

| 档位 | 纯桩 `stub` | **决策抽取 `extract`** |
|---|---|---|
| 动作类型（工具 vs 直接答复） | 12/17（71%） | **15/17（88%）** |
| 同名工具 | 2/17（12%） | **6/17（35%）** |
| 意图键 | 2/17（12%） | 6/17（35%） |
| 完全一致 | 0/17 | 0/17 |

**读法**：`extract`（只留"我打算/下一步/I'll"那类决策句）在每一档上都 ≥ `stub`，
而体积只多花 1.8 个百分点（见下表）⇒ **`extract` 支配 `stub`**。
注意 N=17 的配对样本不足以做强断言；且不同批次之间（会话在增长）数值不可直接比较。

### 3. 固定轨迹重放（把成本从"模型行为漂移"里剥出来）

真实会话里同一轮内**连续 12 次工具调用**当剧本，两臂逐轮发前缀请求，只有推理形态不同：

| 轮次 | payload 字符（full → stub） | 省 |
|---|---|---|
| 1 | 3,809 → 3,204 | 15.9% |
| 4 | 33,769 → 21,484 | 36.4% |
| 8 | 76,720 → 36,938 | 51.9% |
| **12** | **100,893 → 51,617** | **48.8%** |

⇒ **末轮 payload 省 38~49%**（离线可复现，与缓存无关）。命令：`node bench/replay.mjs <session> --dry`

**折成钱是多少**（解析换算：少发的都是**命中价** token）：

| 尺度 | 少发 token | 省（$0.02/M） |
|---|---|---|
| 单个长回合（12 轮工具调用，`stub`） | 90,444 | **$0.0018** |
| 更长回合（40 轮窗口内，`stub` −38.0% / `extract` −36.2%） | 866,220 / 823,401 | **$0.0173 / $0.0165** |
| 会话尺度（本机实测 3.95 亿命中 token 的会话 × 40%） | 158,000,000 | **≈ $3** |

⇒ **一个长回合只省一两美分**（省下的是最便宜的命中价 token），但**整段长会话能到几美元**。
这也解释了它的价值命题：**与轨迹长度成正比**，短会话上可以忽略。

> ⚠️ **在线成本 A/B 不可信**：先跑出过"−77%"，但反序重跑后另一臂得到**完全相同**的数字
> ⇒ 那是"谁第二个跑谁几乎全命中"的**缓存复用假象**，已撤回。
> 要账单口径的 ground truth，只能对比真实会话"插件开/关"两个阶段（`session-cost-audit.mjs`）。

### 4. agentic 基准（多轮工具调用 + 确定性判分）

8 个短任务 + 3 个长轨迹任务（初始文件 + 提示 + 检查器），工具回路 `read_file` / `write_file` / `run_shell`：

| 臂 | 成功率 | 轮数 | 工具调用 | 输入 token | 成本 |
|---|---|---|---|---|---|
| `full`（短任务 8 个） | 8/8 | 35 | 36 | 31,580 | $0.0086 |
| `stub`（短任务 8 个） | 8/8 | 37 | 44 | 33,322 | $0.0086 |
| `full`（长轨迹 3 个） | 3/3 | 21 | 43 | 55,092 | $0.0096 |
| `stub`（长轨迹 3 个） | 3/3 | 21 | 40 | 49,074 | $0.0117 |

**读法**：质量未观察到退化（短任务 8/8、长轨迹 3/3）；成本列**不可信**——两臂会跑出不同的
命令与输出，未命中被"这轮干了什么"污染 ⇒ 成本请看上面的固定轨迹重放。

## 现状与限制

- **默认关闭**：行为分歧显示桩化会改变下一步动作（76% 同一"动作类型"，41% 同一工具），
  质量代价需在长轨迹任务上确认；
- **只处理 `reasoning`**：tool 结果（21.4%）与 tool 参数（40.2%）尚未塑形，
  路线与风险序见 [`docs/PROCESSING.md`](docs/PROCESSING.md)；
- **基准边界**：行为分歧测的是"是否被改变"，不是"是否更好"；agentic 基准目前任务偏短，
  长轨迹任务（15~30 轮 + 大体量工具输出）正在补。

## 两条硬约束（踩过，写下来）

| 约束 | 出处 |
|---|---|
| 替换事件的 `sourceEventSeqs` 必须**原样沿用**原事件（每个 source 须是同 step 的 `assistant/chunk`、不重复、严格更早），否则**抛错** | `packages/llm/token-meter/src/index.ts:279-304` |
| 替换事件**不复制** `usage`，否则同一步被计两次 | `packages/llm/token-meter/src/usage-projection.ts:82-84` |

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/PIPELINE.md`](docs/PIPELINE.md) | 当前工作管道：总图、逐步时序（含 harness 源码出处）、元素生命周期、降级路径、验收观测点 |
| [`docs/PROCESSING.md`](docs/PROCESSING.md) | 处理层规范：op 目录、`shaper` 槽位协议、LLM op 口径、里程碑 |
| [`CHANGELOG.md`](CHANGELOG.md) | 变更记录（含 0.1.0 的 `drop` 被基准否掉的完整背景） |
| [`SECURITY.md`](SECURITY.md) | 边界与失败模式 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 改动前必读 |

## 开发

```powershell
node test/run-all.mjs                                          # 单测（17 例，无需 DSH 运行时）
node bench/divergence.mjs "<session.jsonl.zstd>" --cases=20     # 行为分歧
node bench/agentic/runner.mjs --max-rounds=20                   # agentic 基准（需真实 shell）
node bench/passback-stub.mjs                                    # 规则边界探针
```

> 基准与检查器需要能捕获子进程输出的真实 shell（受限沙箱会拦 Node 的管道 spawn）；
> shell 可用 `DSH_BENCH_SHELL` 指定，默认自动探测。

## 许可

MIT，见 [`LICENSE`](LICENSE)。
