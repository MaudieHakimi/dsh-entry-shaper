# 安全说明

本插件**很小**，但它在会话表面上动刀，所以把边界写清楚。

## 它做什么

订阅 `session/event`，对**刚追加、尚未发送**的 `assistant/message` 追加一条**同类**表面事件
（`surfaceOp: { op: 'replace' }`），其内容是原消息**去掉 `reasoning` 块**。原始事件仍在
append-only 日志里；替换副本是 **model-only**（界面/审计读 append-origin 事件）。

## 它不做什么

- **不接管 `compaction` 服务**（与官方 `dsh-compaction-basic`、`dsh-context-slimmer` 共存）；
- **不改写已发送的内容**（那会打断前缀缓存并付全价税——这正是本插件要避免的事）；
- **不发起任何网络请求**（无端点、无 LLM 调用；`summarize:llm` 是规划项，见 `docs/PROCESSING.md`）；
- **不读写用户文件**（除自身日志 `~/.dsh-entry-shaper.log` 与熔断哨兵 `~/.dsh-entry-shaper.OFF`）；
- **不记录任何消息内容**到日志（只记 seq / turn / step / 块数 / 字符数）。

## 失败模式

| 情况 | 行为 |
|---|---|
| 事件结构不符合预期 | 直接 return，零副作用 |
| `session.append` 被表面契约拒绝 | 捕获、写日志、**表面保持原样**（fail-open） |
| 日志不可写 | 静默忽略 |
| 需要紧急停手 | 建空文件 `~/.dsh-entry-shaper.OFF`（免重启，每 64 事件检查一次） |

## 数据面影响

- **模型看到的内容变少**（设计使然）：后续请求不再携带历史推理；
- **人类看到的内容不变**：界面与审计仍读 append 原文；
- **token 统计不变**：替换事件不复制 `usage`（否则会双计）。

## 报告问题

仓库 issue 即可；涉及未公开缺陷请勿在公开渠道披露细节，先联系维护者。
