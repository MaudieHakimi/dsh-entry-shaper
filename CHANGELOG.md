# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.3.0] — 2026-09-23

**新增决策抽取（`reasoningMode: extract`）**：按句式挑句子，而不是按位置截断。

### 动机

0.2.0 的实测显示"保留思考尾部 400 字符"反而更差（动作类型一致率 59% vs 纯桩 76%），
怀疑根因不是"留尾巴"本身，而是**截断点随机、割裂了半句**。于是改为按句式抽取：
只保留 `I'll / I will / let me / next / first / then / 下一步 / 接下来 / 我打算 / 先做…`
这类**决策句**，抽不到就退回最后一句（通常含结论）。

### Added

- `extractReasoning(text, maxChars)`（`index.js` 导出）：确定性、零成本、无 LLM 调用。
  切句规则：全角标点照切；ASCII 句号只在"空格 + 大写字母或汉字"时才切
  —— 否则会把 `transform.js. There`／`parse.js，` 里的文件名从中间切开（实测踩到并已修）。
- `reasoningMode: 'extract'` 与 `extractMaxChars`（默认 240）配置项。
- 基准与插件**共用同一实现**：`bench/divergence.mjs` 与 `bench/replay.mjs` 直接 import
  `extractReasoning`，避免"测的形态与跑的形态不一致"。
- 测试增至 **23 例**（新增 6 例：决策句筛选、中文决策句、退回最后一句、字符预算、空输入、
  extract 模式下字段仍在且带省略计数）。

### 实测（同批 case 配对比较，N=17）

| 档位 | `stub` | `extract` |
|---|---|---|
| 动作类型一致 | 12/17（71%） | **15/17（88%）** |
| 同名工具 | 2/17（12%） | **6/17（35%）** |
| 意图键 | 2/17（12%） | 6/17（35%） |

体积（固定轨迹重放，40 轮窗口）：`stub` −38.0%（省 $0.0173）、`extract` −36.2%（省 $0.0165）
⇒ **`extract` 在每一档上都 ≥ `stub`，体积只多花 1.8 个百分点** ⇒ 建议默认用它。
（N=17 配对样本不足以做强断言；不同批次之间因会话在增长，数值不可直接比较。）

## [0.2.0] — 2026-09-23

**桩化（stub）替代删除（drop）**，并新增"简洁便宜准确"的行为分歧基准。

### 背景：基准第一次跑就否掉了 0.1.0 的做法

`bench/divergence.mjs`（真实多轮历史）与 `bench/passback-stub.mjs` 实测发现：

- **缺 `reasoning_content` 会被 API 拒绝**，但只在"延续工具回路"时（报文以 `role:'tool'`
  结果结尾）：
  `400 The reasoning_content in the thinking mode must be passed back to the API.`
  单轮探针（1 轮工具往返、末尾带用户消息）曾返回 200，属特例，**不能代表真实会话**；
- 把推理文本换成短桩 `[reasoning omitted: N chars]` 后 **200 OK**
  ⇒ **API 要求的是字段存在，不是内容完整**。

⇒ 0.1.0 的 `drop` 在主对话路径上会把会话打挂；本版改为默认 `stub`。

### Changed

- `index.js`：新增 `reasoningMode: 'stub' | 'drop'`（默认 `stub`）与 `stubTemplate`；
  多个 reasoning 块只留一个桩。实测体积：3,500 字符 → 31 字符（省 **99.1%**）。
- `cordis.patch.yml`：**紧急关闭**（`enabled: false`）。

### Added

- `bench/divergence.mjs`：行为分歧基准（四档一致率；真实历史 + 同一前缀 + 真实后续作锚点）。
- `bench/passback-rule.mjs` / `bench/passback-stub.mjs`：规则边界与可行性的判定探针。
- `bench/replay.mjs`：固定轨迹重放（`--dry` 离线体积；在线模式因缓存复用不可信，见下）。
- 测试 17 例。

### 注意

在线成本 A/B（两臂串行发前缀请求）**不可信**：反序重跑后另一臂得到完全相同的
`103,803 / 2,056 / $0.0041` ⇒ provider 缓存在多次运行间被复用，第一次跑出的"−77%"是顺序假象。
自校验条款：**两臂共享前缀 ⇒ 未命中必须相等**。

## [0.1.0] — 2026-09-23

首个可用版本（探针级）：入口塑造核心（`session/event` + `surfaceOp: replace`）、
两条硬约束（provenance 原样沿用、不复制 usage）、fail-open 与免重启熔断、
`docs/PIPELINE.md` 与 `docs/PROCESSING.md`、13 例测试。
