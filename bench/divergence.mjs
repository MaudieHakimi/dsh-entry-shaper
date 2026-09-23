// 行为分歧基准：把推理桩化，会不会改变模型的"下一步动作"？
//
// 做法：从真实会话日志里捞出「工具往返」历史快照，用**同一个前缀**发两次请求——
//   臂 A（full）：assistant 消息带完整 reasoning_content（= 当前 DSH 的行为）
//   臂 B（stub）：assistant 消息的 reasoning_content 换成短桩（= 本插件塑形后的行为）
// 比较两臂产出的"下一步动作"，并与会话里**真实发生的下一步**对照。
//
// 为什么必须是 stub 而不是 drop：bench/passback-stub.mjs 实测——thinking 模式下报文以
// role:'tool' 结果结尾（延续工具回路）时，缺 reasoning_content 会被 400 拒绝
// （"must be passed back to the API"），而换成短桩后 200 ⇒ API 要的是字段在，不是内容全。
//
// 用法：
//   node bench/divergence.mjs <session.jsonl.zstd> [--cases=8] [--window=2] [--per-turn]
//                             [--model=deepseek-flash] [--max-tokens=384] [--json]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith('--'))
if (!file) {
  console.error('用法: node bench/divergence.mjs <session.jsonl.zstd> [--cases=8] [--window=2] [--model=…] [--max-tokens=384] [--json]')
  process.exit(2)
}
const numArg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : dflt
}
const strArg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : dflt
}
const CASES = numArg('cases', 8)
const WINDOW = numArg('window', 2)
const PER_TURN = argv.includes('--per-turn')
const MODEL = strArg('model', 'deepseek-flash')
const MAX_TOKENS = numArg('max-tokens', 384)
const TAIL = numArg('tail', 400)
const JSON_OUT = argv.includes('--json')
const PRICE_HIT = 0.02 / 1e6
const PRICE_MISS = 1 / 1e6

// ── 凭据（脚本自读，不进命令行）──
const credText = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const keyMatch = credText.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
if (!keyMatch) throw new Error('凭据文件里没有 DEEPSEEK_API_KEY')
const KEY = keyMatch[1]
const BASE = process.env.DSH_DEEPSEEK_BASE ?? 'https://api.deepseek.com'

// ── 读会话日志 ──
const buf = readFileSync(file)
const magics = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) magics.push(i)
}
const values = []
for (let k = 0; k < magics.length; k++) {
  const slice = buf.subarray(magics[k], k + 1 < magics.length ? magics[k + 1] : buf.length)
  for (let j = slice.length; j > 0 && j > slice.length - 4; j--) {
    let text = null
    try { text = zstdDecompressSync(slice.subarray(0, j)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue
      try { values.push(JSON.parse(line)) } catch { /* 半个 JSON */ }
    }
    break
  }
}

// ── 捞出"轮次"：assistant/message（原始追加）与其后的工具结果 ──
const events = values.filter((r) => Number.isInteger(r.seq))
const rounds = []
const usersByTurn = new Map()
for (const rec of events) {
  if (rec.type === 'user/message' && !usersByTurn.has(rec.data?.turn)) {
    const text = (rec.data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    usersByTurn.set(rec.data?.turn, text.slice(0, 4000))
  }
}
let pendingResults = []
for (const rec of events) {
  if (rec.type === 'tool/result') {
    pendingResults.push(rec)
    continue
  }
  if (rec.type !== 'assistant/message') continue
  if (rec.surfaceOp !== undefined && rec.surfaceOp !== 'append') continue
  const content = rec.data?.message?.content
  if (!Array.isArray(content)) continue
  const reasoning = content.filter((b) => b?.type === 'reasoning').map((b) => b.text ?? '').join('')
  const text = content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
  const calls = content.filter((b) => b?.type === 'tool-call')
  rounds.push({ turn: rec.data?.turn, step: rec.data?.step, reasoning, text, calls, results: pendingResults })
  pendingResults = []
}
rounds.at(-1).results = pendingResults
// 配对修正：rounds[i].results 是"出现在 assistant_i 之前"的结果（= 上一轮的响应），
// 真正**响应 assistant_i 的调用**的是 rounds[i+1].results ⇒ 记作 responses。
for (let i = 0; i < rounds.length - 1; i++) rounds[i].responses = rounds[i + 1].results
rounds.at(-1).responses = pendingResults

const usable = rounds.filter((r) => r.calls.length > 0 && (r.responses?.length ?? 0) > 0)
if (usable.length === 0) {
  console.error('这个会话里没有可用的"工具往返"轮次')
  process.exit(1)
}
const picked = []
for (let i = 0; i < CASES; i++) {
  const idx = Math.floor((usable.length - 1) * (i + 0.5) / CASES)
  picked.push(usable[idx])
}

const TOOL_TEXT = (rec) => {
  const out = []
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (k === 'text' && typeof val === 'string') out.push(val)
        else if (val && typeof val === 'object') walk(val)
      }
    }
  }
  walk(rec.data?.message?.content ?? rec.data)
  return out.join('\n').slice(0, 20000)
}

/** 构造某轮的请求 messages；mode: 'full' | 'stub' | 'stub-tail'。 */
function buildMessages(windowRounds, { mode, tailChars = 400 }) {
  const messages = [{
    role: 'system',
    content: 'You are a coding agent working in a repository via tools. '
      + 'Continue the task: decide the next action. Use a tool call when an action is needed.',
  }]
  const userText = usersByTurn.get(windowRounds[0].turn)
  if (userText) messages.push({ role: 'user', content: userText })
  for (const r of windowRounds) {
    const assistant = { role: 'assistant', content: r.text ?? '' }
    if (mode === 'full' && r.reasoning) {
      assistant.reasoning_content = r.reasoning
    } else if (mode === 'stub' && r.reasoning) {
      assistant.reasoning_content = `[reasoning omitted: ${r.reasoning.length} chars]`
    } else if (mode === 'stub-tail' && r.reasoning) {
      // 桩 + 保留思考的**尾部**（决定通常在后半段；头部多为探索）
      const tail = r.reasoning.length > tailChars ? r.reasoning.slice(-tailChars) : r.reasoning
      assistant.reasoning_content = `[reasoning omitted: ${r.reasoning.length - tail.length} chars]\n${tail}`
    }
    if (r.calls.length > 0) {
      assistant.tool_calls = r.calls.map((c, i) => ({
        id: c.id ?? `call_${r.step}_${i}`,
        type: 'function',
        function: {
          name: c.name,
          arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
        },
      }))
    }
    messages.push(assistant)
    for (const res of r.responses ?? []) {
      for (const block of res.data?.message?.content ?? []) {
        if (block?.type !== 'tool-result') continue
        messages.push({ role: 'tool', tool_call_id: block.toolCallId, content: TOOL_TEXT(res) })
      }
    }
  }
  return messages
}

const toolsOf = (windowRounds) => {
  const seen = new Map()
  for (const r of windowRounds) {
    for (const c of r.calls) if (!seen.has(c.name)) seen.set(c.name, c)
  }
  return [...seen.values()].map((c) => ({
    type: 'function',
    function: {
      name: c.name,
      description: `Tool ${c.name} (as used in this session).`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
  }))
}

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  }
  return v
}
function canonicalJson(raw) {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    return JSON.stringify(sortKeys(obj))
  } catch {
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, 400)
  }
}
const normalizeText = (t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 300).toLowerCase()

/** 动作的四档比较：kind（工具/文本）→ tool（同名工具）→ intent（意图键）→ exact（完全一致）。 */
function tierOf(action) {
  const a = String(action)
  if (!a.startsWith('text:') && !a.startsWith('ERROR')) {
    const names = [...a.matchAll(/([A-Za-z_][\w.]*)\(/g)].map((m) => m[1])
    const paths = [...a.matchAll(/[A-Za-z]:\\\\[^"\\,)]+/g)].map((m) => m[0].toLowerCase())
    const inner = [...a.matchAll(/tools\.(\w+)\(/g)].map((m) => m[1]).sort()
    return {
      kind: 'tool',
      tool: names.sort().join('+'),
      intent: `${names.sort().join('+')}|${inner.join('+')}|${paths.length > 0 ? paths.length : 'nopath'}`,
      exact: a,
    }
  }
  if (a.startsWith('ERROR')) return { kind: 'error', tool: 'error', intent: a, exact: a }
  return { kind: 'text', tool: 'text', intent: 'text', exact: a }
}
const compareTiers = (x, y) => {
  const A = tierOf(x)
  const B = tierOf(y)
  return {
    kind: A.kind === B.kind,
    tool: A.kind === B.kind && A.tool === B.tool,
    intent: A.kind === B.kind && A.intent === B.intent,
    exact: A.exact === B.exact,
  }
}

/** 把一次响应归纳成可比较的"动作"：工具名 + 规范化参数；没有工具调用则退回文本。 */
function canonicalAction(message) {
  const calls = message?.tool_calls ?? []
  if (calls.length > 0) {
    return calls
      .map((c) => `${c.function?.name}(${canonicalJson(c.function?.arguments)})`)
      .sort()
      .join(' && ')
  }
  const raw = Array.isArray(message?.content)
    ? message.content.map((b) => b?.text ?? '').join(' ')
    : message?.content ?? ''
  // 注意：模型可能"只在推理通道里作答"（content 为空、reasoning 有内容）——
  // 这种回合若只看 content 会误判成"空文本"，所以把 reasoning 一并算进文本档。
  const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : ''
  return `text:${normalizeText(`${raw} ${reasoning}`.trim())}`
}

async function call(messages, tools) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages,
      ...tools.length > 0 ? { tools } : {},
      temperature: 0,
      max_tokens: MAX_TOKENS,
    }),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
  if (!res.ok) return { ok: false, status: res.status, detail: (parsed?.error?.message ?? text).slice(0, 200) }
  return { ok: true, status: res.status, message: parsed?.choices?.[0]?.message, usage: parsed?.usage }
}

// ── 跑 ──
const rows = []
let totalMiss = 0
let totalHit = 0
for (const [i, target] of picked.entries()) {
  const idx = usable.indexOf(target)
  const windowRounds = usable.slice(Math.max(0, idx - WINDOW), idx + 1)
  if (PER_TURN && new Set(windowRounds.map((r) => r.turn)).size > 1) continue

  const tools = toolsOf(windowRounds)
  const realNext = usable[idx + 1]
  const realAction = realNext && realNext.turn === target.turn
    ? canonicalAction({
      tool_calls: realNext.calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
      content: realNext.text,
    })
    : null

  const a = await call(buildMessages(windowRounds, { mode: 'full' }), tools)
  const b = await call(buildMessages(windowRounds, { mode: 'stub' }), tools)
  const c = await call(buildMessages(windowRounds, { mode: 'stub-tail', tailChars: TAIL }), tools)
  const actionA = a.ok ? canonicalAction(a.message) : `ERROR:${a.status}`
  const actionB = b.ok ? canonicalAction(b.message) : `ERROR:${b.status}`
  const actionC = c.ok ? canonicalAction(c.message) : `ERROR:${c.status}`
  for (const r of [a, b, c]) {
    if (r.ok && r.usage) {
      totalMiss += r.usage.prompt_cache_miss_tokens ?? 0
      totalHit += r.usage.prompt_cache_hit_tokens ?? 0
    }
  }
  const tStub = compareTiers(actionA, actionB)
  const tTail = compareTiers(actionA, actionC)
  rows.push({
    case: i + 1, turn: target.turn, step: target.step,
    reasoningChars: target.reasoning.length,
    tStub, tTail,
    same: tStub.exact,
    realA: realAction === null ? null : actionA === realAction,
    realB: realAction === null ? null : actionB === realAction,
    actionA, actionB, actionC, realAction,
    errA: a.ok ? null : a.detail, errB: b.ok ? null : b.detail, errC: c.ok ? null : c.detail,
  })
  if (!JSON_OUT) process.stdout.write(`case ${i + 1}/${picked.length} 完成\r`)
}
if (!JSON_OUT) process.stdout.write(' '.repeat(30) + '\r')

const counted = rows.filter((r) => !String(r.actionA).startsWith('ERROR') && !String(r.actionB).startsWith('ERROR'))
const rate = (key, tier) => {
  const ok = counted.filter((r) => r[key][tier]).length
  return `${ok}/${counted.length}${counted.length ? `（${(ok / counted.length * 100).toFixed(0)}%）` : ''}`
}
const withReal = counted.filter((r) => r.realA !== null)
const cost = totalHit * PRICE_HIT + totalMiss * PRICE_MISS
const same = counted.filter((r) => r.tStub.exact).length

if (JSON_OUT) {
  console.log(JSON.stringify({ model: MODEL, cases: rows.length, counted: counted.length, rows, cost, totalHit, totalMiss }, null, 2))
  process.exit(0)
}

console.log('\n=== 行为分歧基准（full / stub / stub-tail 三臂）===')
console.log(`日志 ${file}`)
console.log(`模型 ${MODEL} · case ${rows.length}（历史窗口 ${WINDOW} 轮）· max_tokens ${MAX_TOKENS} · 尾部保留 ${TAIL} 字符`)
console.log('\n【四档一致率】full 为基准，比较塑形后是否给出"同一个动作"')
console.log(`  档位        纯桩(stub)      桩+尾(stub-tail)`)
console.log(`  动作类型    ${rate('tStub', 'kind').padEnd(16)}${rate('tTail', 'kind')}`)
console.log(`  同名工具    ${rate('tStub', 'tool').padEnd(16)}${rate('tTail', 'tool')}`)
console.log(`  意图键      ${rate('tStub', 'intent').padEnd(16)}${rate('tTail', 'intent')}`)
console.log(`  完全一致    ${rate('tStub', 'exact').padEnd(16)}${rate('tTail', 'exact')}`)
if (withReal.length > 0) {
  const ra = withReal.filter((r) => r.realA).length
  const rb = withReal.filter((r) => r.realB).length
  console.log(`\n【锚点】与真实后续完全一致：full ${ra}/${withReal.length} · stub ${rb}/${withReal.length}（窗口小、工具 schema 简化 ⇒ 参考价值有限）`)
}
console.log(`\n成本：未命中 ${totalMiss.toLocaleString()} + 命中 ${totalHit.toLocaleString()} ⇒ $${cost.toFixed(4)}（${rows.length} case × 3 臂）`)

const kindDiff = counted.filter((r) => !r.tStub.kind)
if (kindDiff.length > 0) {
  console.log(`\n=== 最严重的一档：动作类型都变了（${kindDiff.length} 例）===`)
  for (const d of kindDiff.slice(0, 5)) {
    console.log(`\ncase ${d.case} turn=${d.turn} step=${d.step}（推理 ${d.reasoningChars} 字符）`)
    console.log(`  full     : ${String(d.actionA).slice(0, 160)}`)
    console.log(`  stub     : ${String(d.actionB).slice(0, 160)}`)
    console.log(`  stub-tail: ${String(d.actionC).slice(0, 160)}`)
  }
}
const toolDiff = counted.filter((r) => r.tStub.kind && !r.tStub.tool)
if (toolDiff.length > 0) {
  console.log(`\n=== 同名工具但换了目标（${toolDiff.length} 例，抽样 3）===`)
  for (const d of toolDiff.slice(0, 3)) {
    console.log(`\ncase ${d.case}: full=${String(d.actionA).slice(0, 120)}`)
    console.log(`            stub=${String(d.actionB).slice(0, 120)}`)
  }
}
const errs = rows.filter((r) => r.errA || r.errB || r.errC)
if (errs.length > 0) {
  console.log(`\n=== 报错 ${errs.length} 例 ===`)
  for (const e of errs.slice(0, 3)) console.log(`  case ${e.case}: A=${e.errA ?? '-'} B=${e.errB ?? '-'} C=${e.errC ?? '-'}`)
}
console.log('\n读法：四档从上到下越来越严。"动作类型"一致 = 没有做出性质不同的决定；'
  + '"完全一致"为 0 不代表做错事（同一意图的不同写法也会判 0）。')
