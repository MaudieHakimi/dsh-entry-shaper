# dsh-entry-shaper

DSH 插件：**入口塑造（payload shaping）**——在元素被**首次发送之前**定型，使 payload 前缀永远单调，
从而**零断点税**地缩小上下文。当前实现一件事：把 assistant 消息里的 `reasoning` **桩化**
（字段保留、内容换成 `[reasoning omitted: N chars]`，省掉 ~99% 的推理体积）。

> ⚠️ **当前默认关闭**（`cordis.patch.yml` 里 `enabled: false`）。原因：行为分歧基准显示
> 桩化推理会改变模型的下一步动作（8 个真实 case 中精确匹配一致率 0/8，含真实分歧），
> 质量代价未经确认前不要打开。见下方「基准」。

- 📐 **工作管道**（当前真实路径，含源码出处）：[docs/PIPELINE.md](docs/PIPELINE.md)
- 🧩 **处理层规范**（op 组合、槽位协议、LLM op 口径、里程碑）：[docs/PROCESSING.md](docs/PROCESSING.md)
- 📊 **经济分析**（为什么"出口压缩"在 DeepSeek 上常常亏）：同机的 `dsh-context-slimmer/docs/ECONOMICS.md`
- 🧪 **设计推导**（入口塑造 vs 出口压缩、两份存、硬约束）：`dsh-context-slimmer/docs/PAYLOAD-SHAPING.md`

> ⚠️ **源码 100% 由 LLM 撰写**（多轮 agent 会话产出，人类审核验收）。按"未经人工逐行审查的软件"对待。

---

## 30 秒理解

| 事实 | 含义 |
|---|---|
| 上下文缓存按**逐字前缀**匹配 | 前缀一旦被改写，其后全部重新计费（断点税 = 那一刻整份 payload 的全价） |
| 推理内容（`reasoning`）会跟着 assistant 消息**回传** | 它在 payload 里逐轮累积（实测占追加内容 **34.8%**） |
| 但它**生成于本次调用、首次回传在下一次请求** | ⇒ 在首次回传之前定型 = 前缀里从未有过它 = **不打断任何已发送的前缀** |
| DSH 的模型表面与人类转录**本来就是两条投影** | 替换副本是 model-only：界面/审计仍读 append 原文（含推理） |

**所以：日志留全（人看），上下文精简（模型看），一份都不用抄。**

## 安装

```powershell
dsh plugin --profile <profile> add "file:D:\DSH Desktop\dsh-entry-shaper"
```

或手动（本项目本机用法）：把目录复制进 `<profile>\node_modules\`，并在 profile 的 `package.json`
里把 `dsh-entry-shaper` 加进 `dependencies` 与 `dsh.profile.bundles`（后者决定它是否被加载）。

> 与 `dsh-context-slimmer` / 官方 `dsh-compaction-basic` **共存**：本插件**不接管 `compaction` 服务**，
> 因此不需要 bundle patch 里的 `disabled` 行。它在**入口**定型，那两者在**出口**压缩。

## 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-entry-shaper
      name: dsh-entry-shaper
      config:
        enabled: true              # 总开关
        dropReasoning: true        # 当前唯一动作
        dropUsageOnReplace: true   # 替换事件不带 usage（meter 按事件折算，复制会双计）
        logStats: true
        # logPath / offSentinel 默认在用户主目录，可注入（测试用）
```

| 安全阀 | 用法 |
|---|---|
| **免重启熔断** | 建一个空文件 `~/.dsh-entry-shaper.OFF`（每 64 个事件检查一次） |
| 配置关闭 | `enabled: false`（需重启） |
| fail-open | 任何异常只写日志、绝不抛错；表面保持原样 |
| 自激保护 | 只处理 `surfaceOp === 'append'` 的原始事件 |
| 空内容保护 | 摘完为空时补一个空 `text` 块 |

## 两条必须遵守的硬约束（踩过）

| 约束 | 出处 |
|---|---|
| 替换事件的 `sourceEventSeqs` 必须**原样沿用**原事件（每个 source 须是同 step 的 `assistant/chunk`、不重复、严格更早），否则**抛错** | `packages/llm/token-meter/src/index.ts:279-304` |
| 替换事件**不复制** `usage`，否则同一步被计两次 | `packages/llm/token-meter/src/usage-projection.ts:82-84` |

## 观测

```powershell
Get-Content "$env:USERPROFILE\.dsh-entry-shaper.log" -Tail 20
```

```
applied pid=… enabled=True dropReasoning=True log=… off=False
subscribed session/event (global)
strip #1 seq=570 turn=1 step=1 blocks=1 chars=624 provenance=553 项(首/末=17/570)
strip #25 seq=… blocks=1 chars=711 | 累计 blocks=25 chars=17820 (≈4811 token) 运行 143s
```

**账单验收**（同机 `dsh-context-slimmer` 仓库的审计工具）：

```powershell
node "D:\DSH Desktop\dsh-context-slimmer\tools\session-cost-audit.mjs" "<session.jsonl.zstd>"
```

期望：每步输入下降、**未命中不出现"整份 payload"尖峰**、命中占比略升。

## 测试

```powershell
node test/run-all.mjs      # 本机（受限沙箱下 `node --test` 会挂）
node --test test/          # CI
```

## 基准（简洁、便宜、准确）

```powershell
# 行为分歧：同一前缀发两次（full 带完整推理 / stub 桩化），比"下一步动作"
node bench/divergence.mjs "<session.jsonl.zstd>" --cases=8 --window=2
# 规则边界：到底哪些 assistant 消息必须回传 reasoning_content
node bench/passback-rule.mjs
node bench/passback-stub.mjs
```

| 问题 | 答案（实测） | 出处 |
|---|---|---|
| 缺 `reasoning_content` 会被拒吗？ | **会**，但只在"延续工具回路"时（报文以 `role:'tool'` 结果结尾）⇒ 400 "must be passed back to the API"；末尾有用户消息时不会 | `bench/passback-stub.mjs` 变体 H/K vs A/B |
| 那能不能换成短桩？ | **能**：把文本换成 `[reasoning omitted: N chars]` ⇒ 200 ✓ ⇒ **API 要的是字段在，不是内容全** | 变体 I vs H |
| 桩化会改变模型的下一步吗？ | **会**：8 个真实 case 精确匹配一致率 **0/8**（含真实分歧：一臂继续排查、另一臂直接收工作答）。注意精确匹配**高估**分歧（同一意图的不同写法会被算作不同） | `bench/divergence.mjs` |
| 成本 | 8 case × 2 臂 = **$0.005**（半分钱，前缀缓存大部分命中） | 同上 |

⇒ 这就是"简洁、便宜、准确"的基准：**真实历史 + 同一前缀 + 确定性打分 + 真实后续作锚点**。

## 未验证 / 已知代价

- **质量影响已测出方向、未测出量级**：桩化推理确实会改变下一步动作（精确匹配 0/8），
  但"是同一意图的不同写法"还是"真的做错了事"需要更粗的指标（同名工具率、意图键）
  或带评分的任务集来判定；
- tool 结果（21.4%）与 tool 参数（40.2%）**尚未塑形**——按 `docs/PROCESSING.md` §6 的风险序推进。

## 许可

MIT，见 [LICENSE](LICENSE)。变更记录见 [CHANGELOG.md](CHANGELOG.md)。
