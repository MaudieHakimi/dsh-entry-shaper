# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

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
