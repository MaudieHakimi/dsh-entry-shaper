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
  // 是否处理 reasoning（总闸）
  dropReasoning: true,
  // ── 处理层：按内容类别各给一条 op 序列（文本 → 文本 的纯函数链）──
  //   可用 op：keep | drop | stub | extract | head | tail | truncate
  //   未列出的类别一律 keep（默认不动）。
  policy: {
    reasoning: { ops: [{ op: 'extract', maxChars: 240 }] },
    toolResult: { ops: [{ op: 'keep' }] },
    toolArgs: { ops: [{ op: 'keep' }] },
    assistantText: { ops: [{ op: 'keep' }] },
  },
  // 兼容旧配置：reasoningMode 仍可用，会被折算成 policy.reasoning.ops（显式 policy 优先）
  reasoningMode: undefined,
  stubTemplate: '[reasoning omitted: {chars} chars]',
  dropUsageOnReplace: true,
  logStats: true,
  // 可注入路径：默认写用户主目录；测试/嵌入时指向别处，避免污染
  logPath: DEFAULT_LOG,
  offSentinel: DEFAULT_OFF,
}

/** op 实现：文本 → 文本；返回 null 表示"整块删除"。 */
export const OPS = {
  keep: (text) => text,
  drop: () => null,
  stub: (text, op, ctx) => (ctx.stubTemplate ?? '[reasoning omitted: {chars} chars]')
    .replace('{chars}', String((text ?? '').length)),
  extract: (text, op) => {
    const raw = text ?? ''
    const picked = extractReasoning(raw, op.maxChars ?? 240)
    // 默认带"省略计数"前缀：基准实测用的就是这个形态（测的必须等于跑的）。
    // 想关掉就写 { op: 'extract', marker: false }。
    if (op.marker === false || picked === '') return picked
    return `[reasoning extract: ${Math.max(0, raw.length - picked.length)} chars omitted] ${picked}`
  },
  head: (text, op) => (text ?? '').slice(0, op.chars ?? 512),
  tail: (text, op) => (text ?? '').slice(-(op.chars ?? 512)),
  truncate: (text, op) => {
    const t = text ?? ''
    const max = op.maxChars ?? 512
    if (t.length <= max) return t
    /**
     * 首尾保留：中间折叠成计数（业界常见的"工具输出截断"形态）。
     */
    const head = Math.ceil(max / 2)
    const tail = max - head
    return `${t.slice(0, head)}\n…（省略 ${t.length - max} 字符）…\n${t.slice(-tail)}`
  },
}

/**
 * 把一条 op 序列作用到文本上。op 是"文本 → 文本"的纯函数，因此可以任意链式组合；
 * 返回 null 表示这条内容应整块删除。
 * @param text - 原始文本
 * @param ops - op 序列（[{ op, ...参数 }]）
 * @param ctx - 上下文（stubTemplate 等）
 * @returns 处理后的文本，或 null（删除）
 */
export function applyOps(text, ops, ctx = {}) {
  if (!Array.isArray(ops) || ops.length === 0) return text
  let out = text
  for (const op of ops) {
    const fn = OPS[op?.op]
    if (typeof fn !== 'function') continue // 未知 op 跳过（fail-open）
    out = fn(out, op, ctx)
    if (out === null || out === undefined) return null
  }
  return out
}

/** 决策句识别（确定性、零成本）：只按句式挑，不按位置截断。 */
const DECISION_RE = /^(i'?ll|i will|i'?m going to|let me|next|now|first|then|finally|so i|i should|i need to|plan[:：]|todo)|(下一步|接下来|我现在|我先|我将|我要|我打算|先做|先看|然后|最后|计划[:：])/i

/**
 * 从推理文本里抽"决策句"。抽不到就退回最后一句（通常含着结论）。
 * @param text - 原始推理文本
 * @param maxChars - 预算（字符）
 * @returns 抽取结果（可能为空串）
 */
export function extractReasoning(text, maxChars = 240) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  // 切句：全角标点照切；ASCII 句号只在"空格 + 大写字母或汉字"时才切，
  // 否则会把 `parse.js，` / `transform.js. There` 里的文件名从中间切开（踩过）。
  const sentences = text
    .split(/(?<=[。！？!?])\s*|(?<=\.)\s+(?=[A-Z\u4e00-\u9fff])/u)
    .map((s) => s.trim())
    .filter(Boolean)
  const picked = []
  let used = 0
  for (const s of sentences) {
    if (!DECISION_RE.test(s)) continue
    if (used + s.length > maxChars) break
    picked.push(s)
    used += s.length
  }
  if (picked.length > 0) return picked.join(' ')
  const last = sentences.at(-1) ?? text
  return last.slice(-maxChars)
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

      if (!event || !Number.isInteger(event.seq)) return
      // 只处理原始追加事件；带 replace 语义的事件（含本插件自己造的）一律跳过
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return

      const policy = { ...DEFAULTS.policy, ...(cfg.policy ?? {}) }
      // 兼容旧配置：reasoningMode → policy.reasoning.ops。
      // 注意判据必须用**用户传入的 config**（不能用合并后的 cfg.policy —— 默认 policy 里
      // 永远有 reasoning，那样 legacy 的 reasoningMode 会被静默忽略，实测踩到过）。
      if (config?.reasoningMode && !(config?.policy?.reasoning)) {
        policy.reasoning = config.reasoningMode === 'drop'
          ? { ops: [{ op: 'drop' }] }
          : config.reasoningMode === 'stub'
            ? { ops: [{ op: 'stub' }] }
            : { ops: [{ op: 'extract', maxChars: cfg.extractMaxChars ?? 240 }] }
      }

      // ── 类别：tool 结果（与 assistant 消息走同一条 op 链，只是目标字段不同）──
      if (event.type === 'tool/result') {
        const blocks = event.data?.message?.content
        if (!Array.isArray(blocks)) return
        const ops = policy.toolResult?.ops ?? []
        if (ops.length === 0 || ops.every((o) => o?.op === 'keep' || o?.op === undefined)) return
        let changed = false
        const shaped = blocks.map((block) => {
          if (block?.type !== 'tool-result' || !Array.isArray(block.content)) return block
          return {
            ...block,
            content: block.content.map((part) => {
              if (typeof part?.text !== 'string') return part
              const after = applyOps(part.text, ops, { stubTemplate: cfg.stubTemplate })
              if (after === null || after === part.text) return after === null ? null : part
              changed = true
              return { ...part, text: after }
            }).filter(Boolean),
          }
        })
        if (!changed) return
        const nextData = cfg.dropUsageOnReplace
          ? { ...event.data, message: { ...event.data.message, content: shaped } }
          : { ...event.data, message: { ...event.data.message, content: shaped } }
        queueMicrotask(() => {
          try {
            session.append('tool/result', nextData, {
              surfaceOp: { op: 'replace', start: event.seq, end: event.seq },
              // tool/result 的 provenance 沿用自身（现有插件的生产用法）
              sourceEventSeqs: [event.seq],
            })
            stats.toolShaped = (stats.toolShaped ?? 0) + 1
            if (stats.toolShaped === 1 || stats.toolShaped % 25 === 0) {
              log(`tool-shape #${stats.toolShaped} seq=${event.seq} ops=${ops.map((o) => o.op).join('→')}`)
            }
          } catch (error) {
            stats.failed += 1
            log(`FAILED tool-shape seq=${event?.seq} err=${error?.message ?? error}`)
          }
        })
        return
      }

      if (event.type !== 'assistant/message') return

      const message = event.data?.message
      const content = message?.content
      if (!Array.isArray(content) || content.length === 0) return

      // ── 处理层：按内容类别跑各自的 op 序列（文本 → 文本）──
      // 类别：reasoning（reasoning 块）/ assistantText（text 块）/ toolArgs（tool-call 的 arguments）
      // 未列出的类别不动。op 只管文本；四条硬约束由内核在下面兜（op 碰不到 provenance/usage/事件类型）。
      // （policy 已在事件分流之前解析，见上面）
      const kindOf = (block) => {
        if (block?.type === 'reasoning') return 'reasoning'
        if (block?.type === 'text') return 'assistantText'
        if (block?.type === 'tool-call') return 'toolArgs'
        return null
      }

      let kept = []
      let changed = false
      let chars = 0
      let keptChars = 0
      const ctx = { stubTemplate: cfg.stubTemplate }

      for (const block of content) {
        const kind = kindOf(block)
        if (kind === null) { kept.push(block); continue }
        const field = kind === 'toolArgs' ? 'arguments' : 'text'
        const before = typeof block?.[field] === 'string' ? block[field] : ''
        let after = applyOps(before, policy[kind]?.ops ?? [], ctx)

        if (kind === 'reasoning') {
          chars += before.length
          // 硬约束（实测）：thinking 模式下"延续工具回路"（报文以 role:'tool' 结果结尾）时
          // 缺 reasoning_content 会被拒：
          //   400 The `reasoning_content` in the thinking mode must be passed back to the API.
          // 而换成短桩就 200 ⇒ API 要的是**字段在**，不是内容全 ⇒ 链把它删空时退回短桩。
          if (after === null || after === '') after = cfg.stubTemplate.replace('{chars}', String(before.length))
          keptChars += after.length
        }

        if (after === null) { changed = true; continue }   // 非 reasoning 的整块删除
        if (after !== before) {
          changed = true
          kept.push({ ...block, [field]: after })
        } else {
          kept.push(block)
        }
      }

      // 整条消息没有任何内容需要改 ⇒ 直接返回（不产生多余的替换事件）
      if (!changed) return

      // 官方约束：assistant 消息必须有 content 或 tool_calls。全被摘空时补一个空 text 块。
      let emptyFixed = false
      if (kept.length === 0) {
        kept = [{ type: 'text', text: '' }]
        emptyFixed = true
      }

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
