// dsh-entry-shaper —— 入口塑造（payload shaping）探针/实现
//
// 主张：会话是一根只进不出的栈。每个元素在**被首次发送之前**定型，此后永不改写，
// 那么下一次请求的 payload 就是本次的**严格前缀** ⇒ 前缀缓存全命中 ⇒ 零断点税。
//
// 当前只实现一件事：assistant/message 一被追加，就把它的 reasoning 块摘掉。
//   * reasoning 生成于本次调用，首次回传发生在**下一次**请求 ⇒ 摘掉不打断任何已发送的前缀
//   * 已实测（见 .research/probe-reasoning-passback.mjs）：DeepSeek 接受"带 tool_calls
//     但缺 reasoning_content"的 assistant 消息（200 OK，回答正确）
//   * 原始记录仍在会话日志里（append-only 不破），只是表面投影不再包含它
//
// 机制（与官方/既有插件同源）：
//   观察：ctx.on('session/event', (session, event) => …)     // core/session/src/index.ts:76
//   定型：session.append(同类型, 新payload, {
//           surfaceOp: { op: 'replace', start: seq, end: seq },
//           sourceEventSeqs: [seq],
//         })                                                  // 现有插件 engine.js:473-481 同形
//
// 安全设计：
//   * fail-open：任何异常只记日志，绝不影响会话
//   * 自激保护：只处理 surfaceOp === 'append' 的原始事件（本插件造的替换事件带 replace，会被跳过）
//   * 空内容保护：若摘完没有任何块，补一个空 text 块（官方要求 content 或 tool_calls 至少有一个）
//   * 免重启熔断：存在 ~/.dsh-entry-shaper.OFF 即停手；也可在 patch 里 enabled: false
//   * 绝不抛错进事件派发链（全部 try/catch）

import { appendFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-entry-shaper'

const DEFAULT_LOG = join(homedir(), '.dsh-entry-shaper.log')
const DEFAULT_OFF = join(homedir(), '.dsh-entry-shaper.OFF')

const DEFAULTS = {
  enabled: true,
  dropReasoning: true,
  dropUsageOnReplace: true,
  logStats: true,
  // 可注入路径：默认写用户主目录；测试/嵌入时指向别处，避免污染
  logPath: DEFAULT_LOG,
  offSentinel: DEFAULT_OFF,
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const LOG = cfg.logPath
  const OFF = cfg.offSentinel
  const stats = { events: 0, stripped: 0, blocks: 0, chars: 0, emptyFixed: 0, failed: 0, offSkips: 0 }
  const started = Date.now()

  const log = (line) => {
    if (!cfg.logStats) return
    try {
      appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch { /* 日志失败不影响会话 */ }
  }

  log(
    `applied pid=${process.pid} enabled=${cfg.enabled} dropReasoning=${cfg.dropReasoning}`
    + ` log=${LOG} off=${existsSync(OFF)}`,
  )

  const onEvent = (session, event) => {
    try {
      if (!cfg.enabled || !cfg.dropReasoning) return
      stats.events += 1

      // 熔断：哨兵文件存在就什么都不做（每 64 个事件查一次，避免高频 stat）
      if (stats.events % 64 === 1 && existsSync(OFF)) {
        stats.offSkips += 1
        return
      }

      if (!event || event.type !== 'assistant/message') return
      // 只处理原始追加事件；带 replace 语义的事件（含本插件自己造的）一律跳过
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return
      if (!Number.isInteger(event.seq)) return

      const message = event.data?.message
      const content = message?.content
      if (!Array.isArray(content) || content.length === 0) return

      const reasoning = content.filter((b) => b?.type === 'reasoning')
      if (reasoning.length === 0) return
      let kept = content.filter((b) => b?.type !== 'reasoning')

      // 官方约束：assistant 消息必须有 content 或 tool_calls。全被摘空时补一个空 text 块。
      let emptyFixed = false
      if (kept.length === 0) {
        kept = [{ type: 'text', text: '' }]
        emptyFixed = true
      }

      const chars = reasoning.reduce((a, b) => a + (typeof b?.text === 'string' ? b.text.length : 0), 0)

      // provenance 必须**原样沿用**原事件：token-meter 的校验器（packages/llm/token-meter/
      // src/index.ts:279-304）逐条要求 assistant/message 的每个 sourceEventSeq 都是
      // 同一 step 的 assistant/chunk，且不重复、严格更早。写成 [event.seq] 会直接抛错。
      const provenance = Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length > 0
        ? [...event.sourceEventSeqs]
        : [event.seq]   // 兜底：没有 provenance 的事件（正常路径不会走到）

      // 不复制 usage：meter 是按**事件**折算 usage 的（usage-projection.ts 读 event.data.usage），
      // 原事件的 usage 在追加时已入账，复制一份会被重复计一次 ⇒ 统计翻倍。
      // 若实测发现统计丢失（说明它按表面折算），把 dropUsageOnReplace 设为 false 即可。
      const { usage: _dropped, ...dataWithoutUsage } = event.data ?? {}
      const nextData = cfg.dropUsageOnReplace
        ? { ...dataWithoutUsage, message: { ...message, content: kept } }
        : { ...event.data, message: { ...message, content: kept } }

      // 在 microtask 里追加，避免在事件发布过程中嵌套派发；
      // 距离下一次 LLM 请求仍有整个工具执行阶段，时序完全够。
      queueMicrotask(() => {
        try {
          session.append('assistant/message', nextData, {
            surfaceOp: { op: 'replace', start: event.seq, end: event.seq },
            sourceEventSeqs: provenance,
          })

          stats.stripped += 1
          stats.blocks += reasoning.length
          stats.chars += chars
          if (emptyFixed) stats.emptyFixed += 1

          if (stats.stripped === 1) {
            log(
              `strip #1 seq=${event.seq} turn=${event.data?.turn} step=${event.data?.step}`
              + ` blocks=${reasoning.length} chars=${chars}${emptyFixed ? ' empty-fixed' : ''}`
              + ` provenance=${provenance.length} 项(首/末=${provenance[0]}/${provenance.at(-1)})`,
            )
          } else if (stats.stripped % 25 === 0) {
            log(
              `strip #${stats.stripped} seq=${event.seq} blocks=${reasoning.length} chars=${chars}`
              + ` | 累计 blocks=${stats.blocks} chars=${stats.chars}`
              + ` (≈${Math.round(stats.chars * 0.27)} token) 运行 ${Math.round((Date.now() - started) / 1000)}s`,
            )
          }
        } catch (error) {
          stats.failed += 1
          try {
            log(`FAILED append seq=${event?.seq} err=${error?.message ?? error} (fail-open，表面保持原样)`)
          } catch { /* 忽略 */ }
        }
      })
    } catch (error) {
      stats.failed += 1
      try {
        log(`FAILED seq=${event?.seq} type=${event?.type} err=${error?.message ?? error} (fail-open，已跳过)`)
      } catch { /* 忽略 */ }
    }
  }

  ctx.on('session/event', onEvent, { global: true })
  log('subscribed session/event (global)')
}

export default { name, apply }
