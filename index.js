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

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-entry-shaper'

const DEFAULT_LOG = join(homedir(), '.dsh-entry-shaper.log')
const DEFAULT_OFF = join(homedir(), '.dsh-entry-shaper.OFF')
const DEFAULT_CACHE = join(homedir(), '.dsh-entry-shaper.cache.jsonl')
// 热配置：patch 里**不能**放 config（dshmarket 的 hot.js:295 明确：含配置行的 patch
// 无法热挂载，只能重启生效）⇒ 所有可调项放这个文件，运行时按 mtime 热读。
const DEFAULT_CONFIG = join(homedir(), '.dsh-entry-shaper.config.json')

// ─────────────────────────────────────────────────────────────────────────────
// 结果缓存：让"非纯 op"（LLM / 外部脚本）在**多次出网之间**产出逐字节相同的结果。
//
// 为什么必须有它：wire 级塑形对同一条旧消息**每次请求都会重算**，而 LLM 输出不保证
// 可复现（temperature 0 也不保证：批处理、MoE 路由、服务端版本、并发都会变）。
// 一旦重算结果不同 ⇒ payload 前缀改变 ⇒ 缓存全灭、付断点税（一次几毛）。
//
// 键 = sha256(生效配置指纹 + op 参数 + 输入文本) ⇒ 改了 prompt/model/端点自动失效；
// 值 = 该次塑形结果。append-only JSONL（崩溃安全、可直接查看），启动时全量读进内存。
// ─────────────────────────────────────────────────────────────────────────────

/** 只对"非纯"op 启用缓存；纯 op 本来可复现，缓存只会白占磁盘。 */
const CACHED_OPS = new Set(['summarize', 'python'])

/** 生效配置指纹：任何会改变输出的配置都必须进这个串。 */
function effectiveFingerprint(op, ctx) {
  return JSON.stringify({
    baseURL: op.baseURL ?? ctx.llm?.baseURL ?? 'https://api.deepseek.com',
    model: op.model ?? ctx.llm?.model ?? 'deepseek-flash',
    prompt: op.prompt ?? '<default>',
    maxTokens: op.maxTokens ?? 256,
    script: op.script,
    command: op.command,
    args: op.args,
  })
}

export function createOpCache(cfg, log) {
  const enabled = cfg.cache?.enabled !== false
  const path = cfg.cache?.path ?? DEFAULT_CACHE
  const maxBytes = cfg.cache?.maxBytes ?? 8 * 1024 * 1024
  const maxEntryChars = cfg.cache?.maxEntryChars ?? 16384
  const map = new Map()
  const stats = { hits: 0, misses: 0, stores: 0 }

  if (enabled) {
    try {
      const text = readFileSync(path, 'utf8')
      for (const line of text.split('\n')) {
        if (line === '') continue
        try {
          const rec = JSON.parse(line)
          if (typeof rec?.k === 'string' && typeof rec?.v === 'string') map.set(rec.k, rec.v)
        } catch { /* 坏行忽略（fail-open） */ }
      }
      if (map.size > 0) log(`cache loaded entries=${map.size} path=${path}`)
    } catch { /* 首次运行没有缓存文件，正常 */ }
  }

  return {
    enabled,
    stats,
    path,
    /**
     * 缓存键 = 生效配置指纹 + op 参数 + 输入文本。
     *
     * ⚠️ 两个**必须**遵守的细节（都踩过或差点踩到）：
     * ① `apiKey` 必须排除（否则密钥进哈希、改了密钥就整体失效）；
     * ② `__fn`（自定义 op 的实现函数）必须显式排除 —— `JSON.stringify` 本来就会丢掉函数，
     *    那会让"同名不同实现"的自定义 op 撞到**同一个键** ⇒ 拿旧实现的结果冒充新实现 ✗。
     *    唯一能进键的身份是 `op` 里的**名字**，所以自定义 op 请用不同的名字区分实现。
     */
    keyOf: (op, text, ctx) => {
      const { __fn: _ignoredFn, apiKey: _ignoredKey, ...params } = op ?? {}
      return createHash('sha256')
        .update(`${op.op}\u0000${effectiveFingerprint(op, ctx)}\u0000${JSON.stringify(params)}\u0000${text}`)
        .digest('hex')
    },
    get(key) {
      if (!enabled) return undefined
      const hit = map.get(key)
      if (hit === undefined) { stats.misses += 1; return undefined }
      stats.hits += 1
      return hit
    },
    put(key, value) {
      if (!enabled || typeof value !== 'string' || value.length > maxEntryChars) return
      map.set(key, value)
      stats.stores += 1
      try {
        appendFileSync(path, `${JSON.stringify({ k: key, v: value, t: Date.now() })}\n`, 'utf8')
        const size = statSync(path).size
        if (size > maxBytes) {
          renameSync(path, `${path}.1`)
          log(`cache rotated at ${size} bytes → ${path}.1（旧缓存留一份；内存里仍生效）`)
        }
      } catch (error) {
        log(`cache write failed: ${error?.message ?? error}（不影响会话）`)
      }
    },
  }
}

const DEFAULTS = {
  enabled: true,
  // 是否**塑形推理**这一类（旧名 dropReasoning 仍兼容，见 mergeCfg）。
  // 它不是全局总闸：工具结果 / 工具参数 / 助手文本只看 enabled。
  // （旧版把整条事件链压在推理开关下 ⇒ 写 `dropReasoning:false` 会把 toolResult 塑形一起静默关掉。）
  shapeReasoning: true,
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
  // 非纯 op（summarize / python）的结果缓存：保证同一输入在多次出网之间结果一致
  // （否则重算结果一变，payload 前缀改变 ⇒ 断点税）。纯 op 不进缓存。
  cache: {
    enabled: true,
    path: DEFAULT_CACHE,
    maxBytes: 8 * 1024 * 1024,
    maxEntryChars: 16384,
  },
  // ── 代理 provider（wire 级塑形；插件自足、不动 harness）──
  // 打开后注册一个新 provider（默认 deepseek-shaped），其适配器把 messages 塑形后转调上游。
  // 用法：在 settings.yaml 的 agent-default-model 里把 provider 换成它（或在模型选择器里选）。
  proxy: {
    enabled: false,
    provider: 'deepseek-shaped',
    upstream: 'deepseek-official',
  },
  stubTemplate: '[reasoning omitted: {chars} chars]',
  // 单个 op 的超时预算（LLM / 外部进程）；超时只跳过该 op、保留上一步结果
  opTimeoutMs: 8000,
  // "事件追加 → 定型落地"的延迟阈值：超过就写 WARN（护栏 4 的可观测证据）
  lagWarnMs: 2000,
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

  /**
   * Python 接口：把文本通过 stdin 交给用户脚本，读 stdout 作为塑形结果。
   *
   * 协议（默认 json）：stdin 收到一行 JSON `{"text": "...", "kind": "reasoning", "meta": {...}}`；
   * stdout 若是 `{"text": "..."}` 则取该字段，否则取 stdout 原文（trim 后）。
   * 退出码非 0 / 超时 / 输出为空 ⇒ 抛错 ⇒ 该 op 被跳过（fail-open，保留上一步结果）。
   *
   * 注：spawn 可经 ctx.spawn 注入（便于测试）；默认用 node:child_process。
   */
  python: async (text, op, ctx) => {
    const spawn = ctx.spawn ?? (await import('node:child_process')).spawn
    const command = op.command ?? 'python'
    const args = [op.script, ...(op.args ?? [])]
    if (!op.script) throw new Error('python op 需要配置 script 路径')
    const protocol = op.protocol ?? 'json'
    const input = protocol === 'text'
      ? String(text ?? '')
      : `${JSON.stringify({ text: text ?? '', kind: ctx.kind ?? null, meta: ctx.meta ?? {} })}\n`
    const timeout = op.timeoutMs ?? 8000

    return await new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      } catch (error) {
        reject(error)
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill() } catch { /* 忽略 */ }
        reject(new Error(`python op 超时（${timeout}ms）`))
      }, timeout)
      if (typeof timer.unref === 'function') timer.unref()

      child.stdout?.on('data', (d) => { stdout += String(d) })
      child.stderr?.on('data', (d) => { stderr += String(d) })
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(`python 退出码 ${code}${stderr ? `：${stderr.slice(0, 200)}` : ''}`))
          return
        }
        const raw = stdout.trim()
        if (raw === '') { reject(new Error('python 输出为空')); return }
        if (protocol === 'json' && raw.startsWith('{')) {
          try {
            const parsed = JSON.parse(raw)
            if (typeof parsed?.text === 'string') { resolve(parsed.text); return }
          } catch { /* 当纯文本处理 */ }
        }
        resolve(raw)
      })
      try {
        child.stdin?.end(input)
      } catch { /* 忽略 */ }
    })
  },

  /**
   * OpenAI 兼容的 LLM 塑形：`POST {baseURL}/chat/completions`，显式提示词，温度 0。
   * 出网前可经 ctx.redact 脱敏；失败/超时/空返回 ⇒ 抛错 ⇒ 该 op 跳过（fail-open）。
   * fetch / apiKey 均可注入（便于测试与复用主会话凭据）。
   */
  summarize: async (text, op, ctx) => {
    const fetchFn = ctx.fetch ?? globalThis.fetch
    if (typeof fetchFn !== 'function') throw new Error('没有可用的 fetch')
    const baseURL = (op.baseURL ?? ctx.llm?.baseURL ?? 'https://api.deepseek.com').replace(/\/+$/u, '')
    const apiKey = op.apiKey ?? ctx.llm?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? ctx.apiKey
    if (!apiKey) throw new Error('summarize op 缺少 apiKey')
    const model = op.model ?? ctx.llm?.model ?? 'deepseek-flash'
    const prompt = op.prompt
      ?? '把下面的内容压成简短要点，保留数字、路径、标识符与结论；不要添加原文没有的信息。'
    const payloadText = typeof ctx.redact === 'function' ? ctx.redact(String(text ?? '')) : String(text ?? '')
    const res = await fetchFn(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        max_tokens: op.maxTokens ?? 256,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: payloadText },
        ],
      }),
    })
    if (!res.ok) throw new Error(`LLM ${res.status}`)
    const json = await res.json()
    const out = json?.choices?.[0]?.message?.content
    if (typeof out !== 'string' || out.trim() === '') throw new Error('LLM 返回为空')
    return out.trim()
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
/**
 * 把一条 op 序列作用到文本上。op 是"文本 → 文本"的纯函数（**也可以是 async 的**，
 * 例如调用 LLM 或外部进程），因此可以任意链式组合；返回 null 表示这条内容应整块删除。
 *
 * 每个 op 都受 timeoutMs 约束（默认 ctx.opTimeoutMs = 8000）：超时/抛错 ⇒ 该 op 跳过
 * （保留上一步的结果），绝不阻断会话。
 * @param text - 原始文本
 * @param ops - op 序列（[{ op, ...参数 }]）
 * @param ctx - 上下文（stubTemplate / fetch / spawn / log / opTimeoutMs 等）
 * @returns Promise<string|null>
 */
export async function applyOps(text, ops, ctx = {}) {
  if (!Array.isArray(ops) || ops.length === 0) return text
  let out = text
  for (const op of ops) {
    // `op.__fn` 允许调用方注入自定义实现（插件运行时用它支持 `config.ops`）；
    // 直接使用导出 API 时只写 `{ op: 'extract', … }` 即可，仍然查内置表。
    const fn = typeof op?.__fn === 'function' ? op.__fn : OPS[op?.op]
    if (typeof fn !== 'function') continue // 未知 op 跳过（fail-open）
    try {
      const timeout = op.timeoutMs ?? ctx.opTimeoutMs ?? 8000
      // 非纯 op（LLM / 外部脚本）：先查缓存，命中就复用 ⇒ 同一条输入在多次出网之间
      // 得到逐字节相同的结果 ⇒ 前缀稳定（这是 wire 级塑形能"零税"的前提）。
      // 自定义 op（__fn）也走缓存 —— 我们无法判断它是否纯，**宁可多缓存**：
      // 不缓存而结果漂移 ⇒ 前缀改变 ⇒ 付断点税（比多占几 KB 磁盘贵得多）。
      const opName = op.__fn === undefined ? op.op : `custom:${op.op}`
      const useCache = Boolean(ctx.cache?.enabled) && op.cache !== false && typeof out === 'string'
        && (CACHED_OPS.has(op.op) || op.__fn !== undefined)
      const key = useCache ? ctx.cache.keyOf(op, out, ctx) : null
      if (useCache) {
        const hit = ctx.cache.get(key)
        if (hit !== undefined) {
          ctx.log?.(`op ${op.op} 缓存命中（${hit.length} 字符）`)
          out = hit
          continue
        }
      }
      const produced = await withTimeout(Promise.resolve(fn(out, op, ctx)), timeout)
      if (useCache && typeof produced === 'string') ctx.cache.put(key, produced)
      out = produced
      if (out === null || out === undefined) return null
    } catch (error) {
      ctx.log?.(`op ${op?.op} 失败，跳过：${error?.message ?? error}`)
    }
  }
  return out
}

/** 超时护栏：op（尤其 LLM / 外部进程）不能把会话挂住。 */
function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`op 超时（${ms}ms）`)), ms)
      if (typeof t.unref === 'function') t.unref()
    }),
  ])
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

/**
 * 逐消息塑形（wire 级的核心）：**只改"发出去的那一份"，不碰会话**。
 *
 * 与"表面替换"的区别：这里拿到的是 `deriveMessages()` 产出的消息数组（每次请求现算），
 * 改完直接交给真适配器 ⇒ 日志/界面永远是原文 ✓；又因为塑形是**纯函数 + 缓存**，
 * 同一条旧消息每次出网都是同一个形态 ⇒ 前缀稳定、零断点税 ✓。
 *
 * 类别映射：assistant 的 reasoning → policy.reasoning；assistant 的 text → policy.assistantText；
 * tool-call 的 arguments → policy.toolArgs（默认 keep，改动有风险）；tool-result → policy.toolResult。
 * user 消息永不触碰。
 * @param messages - deriveMessages() 产出的消息数组
 * @param policy - 按类别的 op 序列
 * @param ctx - op 上下文（cache / llm / fetch / spawn / log …）
 * @returns 塑形后的新数组（未变化的消息原样复用）
 */
export async function shapeMessages(messages, policy, ctx = {}) {
  if (!Array.isArray(messages)) return messages
  const out = []
  for (const message of messages) {
    const role = message?.role
    if (role === 'user' && !Array.isArray(message?.content)) { out.push(message); continue }
    if (!Array.isArray(message?.content)) { out.push(message); continue }
    let changed = false
    const content = []
    for (const block of message.content) {
      const type = block?.type
      let kind = null
      if (type === 'reasoning') kind = 'reasoning'
      else if (type === 'text') kind = 'assistantText'
      else if (type === 'tool-call') kind = 'toolArgs'
      else if (type === 'tool-result') kind = 'toolResult'
      if (kind === null) { content.push(block); continue }

      const ops = policy[kind]?.ops ?? []
      const pureKeep = ops.length === 0 || ops.every((o) => o?.op === 'keep' || o?.op === undefined)
      if (pureKeep) { content.push(block); continue }

      if (kind === 'toolResult') {
        const parts = []
        let partChanged = false
        for (const part of block.content ?? []) {
          if (typeof part?.text !== 'string') { parts.push(part); continue }
          const after = await applyOps(part.text, ops, { ...ctx, kind })
          if (after === null) { partChanged = true; continue }
          if (after !== part.text) { partChanged = true; parts.push({ ...part, text: after }) } else parts.push(part)
        }
        if (partChanged) { changed = true; content.push({ ...block, content: parts }) } else content.push(block)
        continue
      }

      const field = kind === 'toolArgs' ? 'arguments' : 'text'
      const before = typeof block[field] === 'string' ? block[field] : ''
      let after = await applyOps(before, ops, { ...ctx, kind })
      if (kind === 'reasoning' && (after === null || after === '')) {
        // 硬约束：reasoning 字段必须存在（否则延续工具回路会被 API 400）
        after = (ctx.stubTemplate ?? '[reasoning omitted: {chars} chars]').replace('{chars}', String(before.length))
      }
      if (after === null) { changed = true; continue }
      if (after !== before) { changed = true; content.push({ ...block, [field]: after }) } else content.push(block)
    }
    out.push(changed ? { ...message, content } : message)
  }
  return out
}

/**
 * 代理 provider：注册一个新 provider id，其适配器把 messages 塑形后**转调上游 provider**。
 *
 * 为什么用代理而不是动 harness：插件自足、checkout 保持干净快照 ✓；转调用的是
 * `llm.stream({…, provider: upstream})`（上游 id 不同 ⇒ 不会再命中本代理 ⇒ 无递归 ✓）。
 *
 * 只实现 `stream()`；`prepareCall()` 由我们自己给（基类默认只在 class 继承时才有 ✗），
 * 并借用 `llm.resolveModelInfo(upstream, …)` 把**真实模型元数据**（contextWindow 等）带过来，
 * 否则会丢掉模型信息 ✗。`listModels()` 照搬上游，方便在模型选择器里看到它。
 * @param opts - { llm, upstream, policy, ctx }
 * @returns LlmAdapter 形状的对象（仅 runtime 需要的成员）
 */
export function createProxyAdapter({ llm, upstream, policy, getPolicy, ctx, shouldShape = () => true, onShaped }) {
  const policyNow = () => (typeof getPolicy === 'function' ? getPolicy() : (policy ?? {}))
  /**
   * 估算一次 messages 的字符量（只算文本/推理/参数，忽略结构开销）。
   * 用途：给出**不依赖任何外部工具**的自证数字 —— 装了本插件就能在日志里看到省了多少，
   * 不必去抓 wire 抓包（这也是本机实测 −40% 的同一个口径）。
   */
  const measure = (messages) => {
    let chars = 0
    for (const m of messages ?? []) {
      for (const b of m?.content ?? []) {
        if (typeof b === 'string') { chars += b.length; continue }
        if (typeof b?.text === 'string') chars += b.text.length
        else if (typeof b?.arguments === 'string') chars += b.arguments.length
      }
    }
    return chars
  }
  const proxyStream = async function* proxyStream(options) {
    // 急刹与总闸在这里也要生效：不塑形就**原样转发**（而不是拒绝请求），
    // 这样哨兵一建就立刻回到"没装插件"的行为，且不会打断任何正在进行的调用。
    let messages = options?.messages
    if (shouldShape()) {
      const before = measure(messages)
      messages = await shapeMessages(messages, policyNow(), ctx)
      const after = measure(messages)
      // 只统计"塑形确实发生"的调用；before===after 时不必刷日志
      if (after !== before) {
        try { onShaped?.({ before, after }) } catch { /* 统计失败不影响请求 */ }
      }
    }
    const inner = llm.stream({ ...options, provider: upstream, messages })
    for await (const chunk of inner) yield chunk
  }
  /**
   * 借用上游的真实模型元数据（contextWindow / maxOutputTokens / reasoningEfforts…），
   * 并把 `provider` **改盖成本路由 id**。为什么必须改盖：调用方
   * `normalizeModelInfo()`（`llm/src/index.ts:663-683`）会校验
   * `resolved.provider === 本路由 id`；直接转手上游元数据时 provider 是**上游 id**，
   * 会被判为非法并抛 `INVALID_MODEL_INFO` ✗。
   */
  const borrowInfo = async (provider, model, signal) => {
    let info
    try { info = await llm.resolveModelInfo?.(upstream, model, signal) } catch { /* 拿不到就用最小信息 */ }
    if (!info || typeof info !== 'object') return { provider, id: model, name: model }
    return {
      ...info,
      provider,
      id: model,
      name: typeof info.name === 'string' && info.name.length > 0 ? info.name : model,
    }
  }
  return {
    async prepareCall(provider, model, signal) {
      return {
        model: await borrowInfo(provider, model, signal),
        stream: (options) => proxyStream(options),
      }
    },
    stream: (options) => proxyStream(options),
    /**
     * 枚举本路由的模型。**必须把 provider 改盖成本路由 id**：宿主
     * `LlmRuntime.listModels()`（`llm/src/index.ts:608-624`）逐条校验
     * `model.provider === provider`、`id` 非空且不重复、`name` 非空。直接转手上游列表
     * （其中 provider 是**上游 id**）会抛
     *   `INVALID_CATALOG: adapter returned invalid or duplicate model metadata`
     * 后果是**整组在选择器里消失** —— 实测现象：模型选择器里只剩官方那组，
     * 用户"只看到模型名"，看不到代理。
     */
    async listModels(provider) {
      try {
        const models = (await llm.listModels?.(upstream)) ?? []
        return models.map((model) => ({ ...model, provider }))
      } catch {
        return []
      }
    },
    providerInfo(provider) {
      return { id: provider, name: `${provider} (entry-shaper 代理)` }
    },
    /**
     * 运行时**必调**的成员（注册期就调：`llm/src/index.ts:414`）。
     * 基类 `LlmAdapter.providerRetryPolicy()` 本有默认实现（返回 undefined ⇒ 用 normal 默认策略），
     * 但本适配器是**普通对象、不继承基类** ⇒ 少了它就是实测踩到的：
     *   `proxy 注册失败（fail-open）：adapter.providerRetryPolicy is not a function`
     * 这里优先借用上游自己的策略，拿不到就 undefined（等价于基类默认）。
     */
    providerRetryPolicy() {
      try { return llm.providerRetryPolicy?.(upstream) } catch { return undefined }
    },
    /**
     * 运行时**必调**（`llm/src/index.ts:659`，在 `resolveModelInfo()` 内部）。
     * 语义与 `borrowInfo` 相同：基类默认只给 `{provider, id, name}`，我们额外带上游容量字段。
     */
    async resolveModel(provider, model, signal) {
      return borrowInfo(provider, model, signal)
    },
  }
}

/**
 * 合并配置源（后者覆盖前者），并把旧名 `dropReasoning` 归一成 `shapeReasoning`。
 * 为什么必须显式归一：DEFAULTS 里已经有 `shapeReasoning`，若直接 `{ ...DEFAULTS, ...hot }`，
 * 用户写在热配置里的旧名 `dropReasoning: false` 会被 DEFAULTS 的默认值静默盖掉
 * —— 与 `reasoningMode` 当初踩的坑是同一个（判据必须看用户真正写了什么，不能看合并结果）。
 * @param source - patch / 热配置文件里的原始对象。
 * @returns 归一后的配置片段（不含 dropReasoning）。
 */
export function mergeCfg(source) {
  if (!source || typeof source !== 'object') return {}
  const { dropReasoning, shapeReasoning, ...rest } = source
  if (shapeReasoning !== undefined) return { ...rest, shapeReasoning }
  if (dropReasoning !== undefined) return { ...rest, shapeReasoning: dropReasoning }
  return rest
}

export function apply(ctx, config = {}) {
  let cfg = { ...DEFAULTS, ...mergeCfg(config) }
  const CONFIG_PATH = cfg.configPath ?? DEFAULT_CONFIG
  let configStamp = -1

  /**
   * 热读配置：**patch 里不能带 config**（`dshmarket/lib/hot.js:295`：含配置行的 patch
   * 无法热挂载，只能重启生效 ⇒ 那会让本插件永远不可热插拔 ✗）。所以所有可调项放在
   * 这个 JSON 文件里，运行时按 mtime 检查、变了就重新合并 ⇒ 改配置**不需要重启** ✓，
   * 同时 patch 保持"纯 insert" ⇒ 可以被市场/`dsh plugin add` 热挂载 ✓。
   */
  let hotUsedLegacySwitch = false
  const refreshCfg = () => {
    try {
      const st = statSync(CONFIG_PATH)
      if (st.mtimeMs === configStamp) return
      configStamp = st.mtimeMs
      const hot = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      hotUsedLegacySwitch = hot.dropReasoning !== undefined && hot.shapeReasoning === undefined
      cfg = { ...DEFAULTS, ...mergeCfg(config), ...mergeCfg(hot), configPath: CONFIG_PATH }
      try { log(`配置热更新 ${CONFIG_PATH}（mtime=${new Date(st.mtimeMs).toISOString()}）`) } catch { /* 日志失败忽略 */ }
    } catch { /* 文件不存在或坏 JSON ⇒ 沿用当前配置（fail-open） */ }
  }
  refreshCfg()

  const OFF = cfg.offSentinel
  const stats = { events: 0, stripped: 0, blocks: 0, chars: 0, emptyFixed: 0, failed: 0, offSkips: 0 }
  const started = Date.now()

  const log = (line) => {
    if (!cfg.logStats) return
    try {
      appendFileSync(cfg.logPath ?? DEFAULT_LOG, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch { /* 日志失败不影响会话 */ }
  }

  log(
    `applied pid=${process.pid} enabled=${cfg.enabled} shapeReasoning=${cfg.shapeReasoning}`
    + ` policy=${Object.entries(cfg.policy ?? {}).map(([k, v]) => `${k}:${(v?.ops ?? []).map((o) => o?.op).join('→') || 'keep'}`).join(',')}`
    + ` log=${cfg.logPath ?? DEFAULT_LOG} off=${existsSync(OFF)} config=${CONFIG_PATH}`,
  )
  if (config?.dropReasoning !== undefined || hotUsedLegacySwitch) {
    log('配置使用了旧名 dropReasoning ⇒ 已归一为 shapeReasoning（效果相同，建议改新名）')
  }

  /**
   * 交给 op 的上下文：可注入 fetch/spawn（便于测试），LLM 凭据与脱敏也走这里。
   *
   * ⚠️ 注意可热配置的边界：`llm` / `redact` / `fetch` / `spawn` **只能从 patch 的
   * `config:` 传入**（函数与凭据无法写进 JSON 配置文件）⇒ 用到 `summarize` + 自定义凭据
   * 或脱敏时，就必须放弃"patch 纯 insert"⇒ 放弃热挂载（改回重启生效）。
   * 只想用内置 op（含指向你自己脚本/端点的 `python` / `summarize`）则完全不必：
   * 那些参数都在热配置文件里。
   */
  const opCache = createOpCache(cfg, log)
  const baseOpCtx = {
    stubTemplate: cfg.stubTemplate,
    opTimeoutMs: cfg.opTimeoutMs ?? 8000,
    llm: cfg.llm,
    fetch: cfg.fetch,
    spawn: cfg.spawn,
    redact: cfg.redact,
    cache: opCache,
    log,
  }

  /**
   * 用户注入的**自定义 op**：来自 patch config 的 `ops`（`{ 名字: (text, op, ctx) => string|null }`）。
   * 也支持从热配置文件按**名字引用内置 op**（`"ops": { "myalias": "extract" }`）—— 那不需要
   * 任何函数注入，纯字符串即可热改 ✓。
   *
   * ⚠️ **本机实测过的一个陷阱**：用 `ops` 注入函数 ⇒ patch 里必须出现 `config:` 行 ⇒
   * `dshmarket/lib/hot.js:295` 判定为"含配置行"⇒ **不能热挂载**（只能重启生效）。
   * 所以自定义函数的代价是"放弃热插拔"，请按需权衡；纯内置 op 的用法不受影响。
   */
  const customOps = { ...(cfg.ops ?? {}) }
  /** 解析一个 op 名 → 实现函数：自定义优先，其次内置。 */
  const resolveOpFn = (name) => {
    const custom = customOps[name]
    if (typeof custom === 'function') return custom
    if (typeof custom === 'string' && typeof OPS[custom] === 'function') return OPS[custom]
    return OPS[name]
  }
  /**
   * 把策略里的 op 名换成**已解析的实现**，再交给 applyOps。
   * 这样 `applyOps`（导出的公开 API）仍然只认内置表，而插件运行时支持自定义 op ✓。
   */
  const resolveOps = (ops) => (Array.isArray(ops)
    ? ops.map((op) => {
      const fn = resolveOpFn(op?.op)
      return typeof fn === 'function' ? { ...op, __fn: fn } : op
    })
    : ops)
  const resolvedPolicy = (policy) => Object.fromEntries(
    Object.entries(policy).map(([kind, entry]) => [kind, { ...entry, ops: resolveOps(entry?.ops ?? []) }]),
  )

  /** 策略解析（三条路径共用一处）：默认 policy + 用户 policy + legacy reasoningMode 折算。 */
  const resolvePolicy = () => {
    const policy = { ...DEFAULTS.policy, ...(cfg.policy ?? {}) }
    // 判据必须用**用户传入的** config（合并后的 cfg.policy 永远含 reasoning，
    // 会让 legacy reasoningMode 被静默忽略 —— 实测踩到过）
    if (config?.reasoningMode && !(config?.policy?.reasoning)) {
      policy.reasoning = config.reasoningMode === 'stub' || config.reasoningMode === 'drop'
        ? { ops: [{ op: 'stub' }] }
        : { ops: [{ op: 'extract', maxChars: cfg.extractMaxChars ?? 240 }] }
    }
    // 顺手把自定义/别名 op 解析成实现（applyOps 也认 op.__fn）
    return resolvedPolicy(policy)
  }

  // ── 代理 provider：wire 级塑形（可选）──
  // 注册是**惰性 + 可热开**的：apply() 时试一次，之后每次 LLM 调用前再试一次
  // （`ensureProxy()`，未注册时成本 = 一次布尔判断）。理由：装配期一次性判定会让
  // "开启代理"必须把插件关掉再打开；惰性注册则只需改热配置文件 ⇒ 真正免重启。
  // 另外 llm 服务若在 apply 时尚未就绪，惰性重试能自愈（旧版直接放弃）。
  let proxyRegistered = false
  let proxyFailLogged = ''
  const ensureProxy = () => {
    if (proxyRegistered || !cfg.proxy?.enabled) return
    try {
      const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
      if (!llm || typeof llm.registerAdapter !== 'function') return   // 服务未就绪 ⇒ 下次再试（不刷日志）
      const alias = cfg.proxy.provider ?? 'deepseek-shaped'
      const upstream = cfg.proxy.upstream ?? 'deepseek-official'
      /**
       * 代理是否需要塑形：**任一**类别存在非 keep 的 op 才算需要。
       * 旧判据是 `cfg.dropReasoning` ⇒ 只要关掉推理塑形，代理连工具结果/助手文本的塑形
       * 一起放弃（代理本就服务所有类别，不该被推理开关挟持）。
       */
      const anyShaping = () => {
        const policy = resolvePolicy()
        for (const [kind, entry] of Object.entries(policy)) {
          if (kind === 'reasoning' && cfg.shapeReasoning === false) continue
          const ops = entry?.ops ?? []
          if (ops.some((op) => op && op.op !== undefined && op.op !== 'keep')) return true
        }
        return false
      }
      const shouldShape = () => {
        refreshCfg()
        const off = existsSync(OFF)
        if (off && !stats.proxyOffNoted) {
          stats.proxyOffNoted = true
          log('proxy 侦测到哨兵文件 ⇒ 原样转发（不塑形）')
        }
        return cfg.enabled && !off && anyShaping()
      }
      const adapter = createProxyAdapter({
        llm,
        upstream,
        getPolicy: resolvePolicy,   // 每次调用现算 ⇒ 配置热改立刻生效 ✓
        ctx: baseOpCtx,
        shouldShape,
        /**
         * 每次塑形都记一行（前 3 次 + 之后每 20 次），让"到底省了多少"**不依赖任何
         * 外部抓包工具**就能看到：装了插件、看一眼日志即可验证。
         * 日志只记字符数，不记内容 ✓。
         */
        onShaped({ before, after }) {
          stats.proxyShaped = (stats.proxyShaped ?? 0) + 1
          stats.proxyCharsBefore = (stats.proxyCharsBefore ?? 0) + before
          stats.proxyCharsAfter = (stats.proxyCharsAfter ?? 0) + after
          const n = stats.proxyShaped
          if (n <= 3 || n % 20 === 0) {
            const saved = stats.proxyCharsBefore - stats.proxyCharsAfter
            log(`proxy-shape #${n} chars=${before}→${after}`
              + `（本次 −${(100 * (before - after) / Math.max(1, before)).toFixed(1)}%；`
              + `累计 ${stats.proxyCharsBefore}→${stats.proxyCharsAfter} = −${(100 * saved / Math.max(1, stats.proxyCharsBefore)).toFixed(1)}%）`)
          }
        },
      })
      llm.registerAdapter([alias], adapter)
      proxyRegistered = true
      log(`proxy registered provider=${alias} upstream=${upstream}`
        + '（把 agent-default-model.provider 换成它即生效；日志与界面仍保留原文）')
    } catch (error) {
      const message = String(error?.message ?? error)
      if (message !== proxyFailLogged) {
        proxyFailLogged = message
        log(`proxy 注册失败（fail-open，下次调用会重试）：${message}`)
      }
    }
  }
  ensureProxy()

  /**
   * ── 推理的塑造走"流过滤"，不走表面替换 ──
   *
   * 原因（现场踩到，并有源码依据）：`assistant/message` **无法**用 surfaceOp replace 替换——
   *   * session 端：`surface replace: sourceEventSeqs must include every shadowed surface node`
   *     （⇒ 必须含被替换的节点自己）；
   *   * token-meter 端：每一项都必须是同 step 的 `assistant/chunk`
   *     （⇒ 不能含它自己；主仓库注释里早写着 "`[seq, ...chunkSeqs]` 仍被拒"）。
   *   两条校验器互相矛盾 ⇒ 这条路是死的。
   *
   * 于是推理改在 `llm/stream` 中间件里处理（`dsh-llm-tap` 证明这条通道可用）：
   * 把流里的 reasoning chunk **先攒起来**，在推理结束（遇到第一个非 reasoning chunk 或流结束）时
   * **只吐出一个**经 op 链处理的 reasoning chunk ⇒ 推理**根本没进会话**，无需替换、无校验器冲突；
   * 而 payload 里仍有 reasoning_content（字段必须在，否则工具回路会被 API 400）。
   */
  const reasoningOps = () => resolvePolicy().reasoning?.ops ?? []

  const shapeReasoningStream = (options, next) => {
    refreshCfg()
    // 每次 LLM 调用前顺手确保代理已注册（未注册时成本 = 一次布尔判断）。
    // 放在这里是因为"配置里打开了 proxy"必须能**当场生效**，而不是等一次重挂载。
    ensureProxy()
    // 这条通道**只**服务推理 ⇒ 判据就该是"要不要塑形推理"（与 enabled 一起）。
    if (!cfg.enabled || cfg.shapeReasoning === false) return next(options)
    // 急刹（哨兵）对流过滤同样要生效 —— 之前只在表面事件那条路检查，是个缺口。
    if (existsSync(OFF)) return next(options)
    // 代理 provider 已启用时**必须**让流原样通过：否则内层转调（provider=upstream）会再次
    // 经过本中间件，推理就会被"在出生时"滤掉 ⇒ 日志又丢原文，代理的意义全没了。
    if (cfg.proxy?.enabled) {
      if (!stats.proxyBypassNoted) {
        stats.proxyBypassNoted = true
        log('proxy 已启用 ⇒ 推理改由 wire 层塑形，流过滤让路（避免双重塑形与日志丢原文）')
      }
      return next(options)
    }
    const ops = reasoningOps()
    const stream = next(options)
    return (async function* shapedStream() {
      let buffered = ''
      let sawReasoning = false
      const flush = async () => {
        if (!sawReasoning) return null
        const raw = buffered
        buffered = ''
        sawReasoning = false
        let out = await applyOps(raw, ops, { ...baseOpCtx, kind: 'reasoning' })
        if (out === null || out === '') out = cfg.stubTemplate.replace('{chars}', String(raw.length))
        stats.streamShaped = (stats.streamShaped ?? 0) + 1
        stats.streamChars = (stats.streamChars ?? 0) + raw.length
        if (stats.streamShaped === 1 || stats.streamShaped % 25 === 0) {
          log(`stream-shape #${stats.streamShaped} chars=${raw.length}→${out.length} ops=${ops.map((o) => o.op).join('→')}`)
        }
        return { type: 'reasoning', text: out }
      }
      for await (const chunk of stream) {
        if (chunk?.type === 'reasoning') {
          sawReasoning = true
          buffered += typeof chunk.text === 'string' ? chunk.text : ''
          continue
        }
        const flushed = await flush()
        if (flushed) yield flushed
        yield chunk
      }
      const tail = await flush()
      if (tail) yield tail
    })()
  }
  ctx.on('llm/stream', shapeReasoningStream)

  /**
   * 栈护栏（为什么不会把前缀打崩）：
   *   1. 只处理 surfaceOp === 'append' 的**刚追加**事件，替换范围恰为它自己
   *      （start === end === event.seq）⇒ **从不触碰更早的 seq**；
   *   2. 若该 seq 已不在当前表面上（被别人替换/已被压缩覆盖）⇒ 直接放弃，绝不插一脚；
   *   3. 所有 op（尤其 LLM / 外部进程）受 opTimeoutMs 约束，超时即跳过 ⇒ 最坏情况是
   *      "没省到"，不会是"改了已发送的内容"；
   *   4. 记录从事件追加到定型落地的延迟，超过阈值就告警——这是"定型早于首次发送"的
   *      可观测证据（若哪天看到它告警，说明时序假设被破坏，应立即停手排查）。
   */
  const onEvent = (session, event) => {
    void handleEvent(session, event).catch((error) => {
      stats.failed += 1
      try { log(`HANDLER FAILED seq=${event?.seq} err=${error?.message ?? error}（fail-open）`) } catch { /* 忽略 */ }
    })
  }

  async function handleEvent(session, event) {
    {
      refreshCfg()
      // 这条通道服务 toolResult / toolArgs / assistantText 等**非推理**类别 ⇒ 只看 enabled。
      // （旧版这里写的是 `!cfg.dropReasoning`，把"关掉推理塑形"误当成"整个插件停手"，
      //   结果是 toolResult 塑形静默失效 —— 与"看着能调、其实是死的旋钮"是同一类 bug。）
      if (!cfg.enabled) return
      stats.events += 1

      // 熔断：哨兵文件存在就什么都不做（每 64 个事件查一次，避免高频 stat）
      if (stats.events % 64 === 1 && existsSync(OFF)) {
        stats.offSkips += 1
        return
      }

      if (!event || !Number.isInteger(event.seq)) return
      // 只处理原始追加事件；带 replace 语义的事件（含本插件自己造的）一律跳过
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return

      // 护栏 2：该 seq 必须仍在当前表面上。若已被别人替换/被压缩覆盖，
      // 就说明它已经不是"栈顶待定型"的那个元素了 —— 放弃，绝不插一脚。
      const surfaceNodes = session?.surface?.nodes
      if (Array.isArray(surfaceNodes) && !surfaceNodes.includes(event.seq)) {
        stats.notOnSurface = (stats.notOnSurface ?? 0) + 1
        return
      }

      const policy = resolvePolicy()

      // ── 类别：tool 结果（与 assistant 消息走同一条 op 链，只是目标字段不同）──
      if (event.type === 'tool/result') {
        const blocks = event.data?.message?.content
        if (!Array.isArray(blocks)) return
        const ops = policy.toolResult?.ops ?? []
        if (ops.length === 0 || ops.every((o) => o?.op === 'keep' || o?.op === undefined)) return
        const opCtx = { ...baseOpCtx, kind: 'toolResult' }
        let changed = false
        const shaped = []
        for (const block of blocks) {
          if (block?.type !== 'tool-result' || !Array.isArray(block.content)) { shaped.push(block); continue }
          const parts = []
          for (const part of block.content) {
            if (typeof part?.text !== 'string') { parts.push(part); continue }
            const after = await applyOps(part.text, ops, opCtx)
            if (after === null) { changed = true; continue }
            if (after !== part.text) { changed = true; parts.push({ ...part, text: after }) } else parts.push(part)
          }
          shaped.push({ ...block, content: parts })
        }
        if (!changed) return
        const nextData = { ...event.data, message: { ...event.data.message, content: shaped } }
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

      // ⛔ 已知不可用（默认关闭）：`assistant/message` 无法用 surfaceOp replace 替换 ——
      // session 端要求 sourceEventSeqs 含被替换节点自身，token-meter 端要求每一项都是
      // 同 step 的 assistant/chunk，两者矛盾（现场报 "must include every shadowed surface node"）。
      // ⇒ 推理改由上面的 llm/stream 中间件处理。此处默认直接返回，不再做无谓尝试。
      if (cfg.surfaceAssistant !== true) {
        if (!stats.surfaceAssistantNoted) {
          stats.surfaceAssistantNoted = true
          log('assistant/message 不做表面替换（校验器冲突）⇒ 推理走 llm/stream 中间件；'
            + '如需继续实验该路径可设 surfaceAssistant: true')
        }
        return
      }

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
      const opCtx = { ...baseOpCtx, kind: 'assistant' }

      for (const block of content) {
        const kind = kindOf(block)
        if (kind === null) { kept.push(block); continue }
        const field = kind === 'toolArgs' ? 'arguments' : 'text'
        const before = typeof block?.[field] === 'string' ? block[field] : ''
        let after = await applyOps(before, policy[kind]?.ops ?? [], { ...opCtx, kind })

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
      // 距离下一次 LLM 请求仍有整个工具执行阶段，时序完全够（延迟会被下面量出来）。
      queueMicrotask(() => {
        try {
          session.append('assistant/message', nextData, {
            surfaceOp: { op: 'replace', start: event.seq, end: event.seq },
            sourceEventSeqs: provenance,
          })

          stats.stripped += 1
          // ⚠️ 这里曾经写的是 `reasoning.length` —— 而 `reasoning` 在本作用域**从未声明**
          //    （它只是上面循环里那个 `const reasoning = []` 收集数组，不在此作用域）。
          //    后果不是"少记一个数"：`ReferenceError` 抛在 try 内 ⇒ 本块**其后全部**语句
          //    都不执行 —— `chars`/`emptyFixed` 不记账、护栏 4 的 `lagWarnMs` 告警永不触发、
          //    `strip #1`/`strip #N` 成功日志永不输出（而 `docs/PIPELINE.md` 正把 `strip #1`
          //    列为验收观测点）。表面替换本身已经 append 成功，所以只有日志与统计被静默废掉。
          //    `kept` 才是"塑形后保留的块数组"（见上面构建处与 nextData），故用它计数。
          stats.blocks += kept.length
          stats.chars += chars
          if (emptyFixed) stats.emptyFixed += 1

          // 护栏 4：量"追加 → 定型"的延迟。这是"定型早于首次发送"的可观测证据：
          // 一旦它显著变大，说明时序假设被破坏，应当立即用哨兵停手排查。
          const appendedAt = typeof event.time === 'number' ? event.time : null
          const lagMs = appendedAt === null ? null : Date.now() - appendedAt
          if (lagMs !== null && lagMs > (cfg.lagWarnMs ?? 2000)) {
            stats.lagWarnings = (stats.lagWarnings ?? 0) + 1
            log(`WARN 定型延迟过大 lag=${lagMs}ms seq=${event.seq}（时序假设可能被破坏，考虑停手）`)
          }

          if (stats.stripped === 1) {
            log(
              `strip #1 seq=${event.seq} turn=${event.data?.turn} step=${event.data?.step}`
              + ` blocks=${kept.length} chars=${chars}${emptyFixed ? ' empty-fixed' : ''}`
              + ` provenance=${provenance.length} 项(首/末=${provenance[0]}/${provenance.at(-1)})`
              + ` lag=${lagMs ?? 'n/a'}ms`,
            )
          } else if (stats.stripped % 25 === 0) {
            log(
              `strip #${stats.stripped} seq=${event.seq} blocks=${kept.length} chars=${chars}`
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
    }
  }

  ctx.on('session/event', onEvent, { global: true })
  log('subscribed session/event (global)')
}

export default { name, apply }
