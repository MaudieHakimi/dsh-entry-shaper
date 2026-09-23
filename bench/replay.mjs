// 固定轨迹重放：把真实会话里**已经发生**的工具序列当剧本，两臂发同一串请求，
// 只有推理（reasoning）的形态不同。这样"每轮新增内容"在两臂完全一致
// ⇒ 未命中 token 必须相等（这就是"零断点税"的直接证据），
// 而命中量的差就是插件真正省下的钱。
//
// 为什么需要它：agentic 基准里模型自己会跑不同的命令 ⇒ 未命中被"这轮干了什么"污染，
// 成本对比没有意义。重放把轨迹钉死，只留插件这一个变量。
//
// 两种模式：
//   --dry    纯离线：只算每轮 payload 的字符/估算 token（不打 API，零成本、瞬时）
//   默认     打 API：逐轮发前缀请求，统计 命中/未命中/成本（消耗真实 token，很便宜）
//
// 用法：
//   node bench/replay.mjs <session.jsonl.zstd> [--rounds=20] [--dry] [--model=deepseek-flash] [--json]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith('--'))
if (!file) {
  console.error('用法: node bench/replay.mjs <session.jsonl.zstd> [--rounds=20] [--dry] [--model=…] [--json]')
  process.exit(2)
}
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.split('=')[1] : d
}
const ROUNDS = Number(arg('rounds', 20))
const DRY = argv.includes('--dry')
const JSON_OUT = argv.includes('--json')
const MODEL = arg('model', 'deepseek-flash')
const PRICE_HIT = 0.02 / 1e6
const PRICE_MISS = 1 / 1e6

// ── 读会话 ──
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

// ── 抽"工具往返"剧本（与 divergence.mjs 同一口径）──
const events = values.filter((r) => Number.isInteger(r.seq))
const usersByTurn = new Map()
for (const rec of events) {
  if (rec.type === 'user/message' && !usersByTurn.has(rec.data?.turn)) {
    const text = (rec.data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    usersByTurn.set(rec.data?.turn, text.slice(0, 4000))
  }
}
const rounds = []
let pending = []
for (const rec of events) {
  if (rec.type === 'tool/result') { pending.push(rec); continue }
  if (rec.type !== 'assistant/message') continue
  if (rec.surfaceOp !== undefined && rec.surfaceOp !== 'append') continue
  const content = rec.data?.message?.content
  if (!Array.isArray(content)) continue
  rounds.push({
    turn: rec.data?.turn,
    step: rec.data?.step,
    reasoning: content.filter((b) => b?.type === 'reasoning').map((b) => b.text ?? '').join(''),
    text: content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(''),
    calls: content.filter((b) => b?.type === 'tool-call'),
    before: pending,
  })
  pending = []
}
for (let i = 0; i < rounds.length - 1; i++) rounds[i].responses = rounds[i + 1].before
rounds.at(-1).responses = pending

// 选一段**连续同轮**、且每轮都有工具调用的剧本（最能代表长回合）
let best = { start: 0, len: 0 }
for (let i = 0; i < rounds.length; i++) {
  let j = i
  while (j < rounds.length && rounds[j].turn === rounds[i].turn && rounds[j].calls.length > 0) j += 1
  if (j - i > best.len) best = { start: i, len: j - i }
}
let script = rounds.slice(best.start, best.start + Math.min(ROUNDS, best.len))
if (script.length === 0) {
  console.error('这段会话里找不到"同一轮内连续工具调用"的剧本')
  process.exit(1)
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

const KEYS = DRY ? null : (() => {
  const t = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const m = t.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
  if (!m) throw new Error('凭据文件里没有 DEEPSEEK_API_KEY')
  return m[1]
})()
const BASE = process.env.DSH_DEEPSEEK_BASE ?? 'https://api.deepseek.com'

const shapeReasoning = (r, arm) => {
  if (!r.reasoning) return undefined
  if (arm === 'full') return r.reasoning
  return `[reasoning omitted: ${r.reasoning.length} chars]` // stub
}

/** 生成第 k 轮（含）之前的 payload（两臂只有 reasoning 形态不同）。 */
function messagesUpTo(script, k, arm, { includeResponsesOfK }) {
  const messages = [{
    role: 'system',
    content: '你是仓库里的编码 agent，用工具干活。',
  }]
  const userText = usersByTurn.get(script[0].turn)
  if (userText) messages.push({ role: 'user', content: userText })
  for (let i = 0; i <= k; i++) {
    const r = script[i]
    const assistant = { role: 'assistant', content: r.text ?? '' }
    const reasoning = shapeReasoning(r, arm)
    if (reasoning !== undefined) assistant.reasoning_content = reasoning
    if (r.calls.length > 0) {
      assistant.tool_calls = r.calls.map((c, idx) => ({
        id: c.id ?? `call_${r.step}_${idx}`,
        type: 'function',
        function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) },
      }))
    }
    messages.push(assistant)
    if (i < k || includeResponsesOfK) {
      for (const res of r.responses ?? []) {
        for (const block of res.data?.message?.content ?? []) {
          if (block?.type !== 'tool-result') continue
          messages.push({ role: 'tool', tool_call_id: block.toolCallId, content: TOOL_TEXT(res) })
        }
      }
    }
  }
  return messages
}

const sizeOf = (messages) => messages.reduce((a, m) => a + JSON.stringify(m).length, 0)

if (DRY) {
  const rows = []
  for (let k = 0; k < script.length; k++) {
    const full = messagesUpTo(script, k, 'full', { includeResponsesOfK: true })
    const stub = messagesUpTo(script, k, 'stub', { includeResponsesOfK: true })
    rows.push({ round: k + 1, step: script[k].step, fullChars: sizeOf(full), stubChars: sizeOf(stub) })
  }
  const last = rows.at(-1)
  const saved = 1 - last.stubChars / last.fullChars
  if (JSON_OUT) { console.log(JSON.stringify({ rounds: rows.length, rows }, null, 2)); process.exit(0) }
  console.log(`\n=== 固定轨迹重放（离线模式，不打 API）===`)
  console.log(`剧本：turn=${script[0].turn} 内连续 ${script.length} 轮工具调用（来自 ${file.split(/[\\/]/).pop()}）`)
  console.log(`\n轮次  payload 字符（full → stub）        省`)
  for (const r of rows) {
    console.log(`  ${String(r.round).padStart(2)}   ${r.fullChars.toLocaleString().padStart(9)} → ${r.stubChars.toLocaleString().padStart(9)}   ${((1 - r.stubChars / r.fullChars) * 100).toFixed(1)}%`)
  }
  console.log(`\n末轮 payload：${last.fullChars.toLocaleString()} → ${last.stubChars.toLocaleString()} 字符（省 ${(saved * 100).toFixed(1)}%）`)
  console.log('注意：字符≠token，但同轨迹下比例稳定；要钱数请去掉 --dry 跑真实请求。')
  process.exit(0)
}

async function call(messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS}` },
    body: JSON.stringify({ model: MODEL, stream: false, messages, temperature: 0, max_tokens: 8 }),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(`API ${res.status}: ${(parsed?.error?.message ?? text).slice(0, 200)}`)
  return parsed.usage ?? {}
}

console.log(`\n=== 固定轨迹重放（真实请求）===`)
console.log(`模型 ${MODEL} · 剧本 ${script.length} 轮（turn=${script[0].turn}）· 每轮两臂各发一次\n`)
const ORDER = arg('order', 'full,stub').split(',')
const out = {}
for (const arm of ORDER) {
  let hit = 0
  let miss = 0
  const perRound = []
  for (let k = 0; k < script.length; k++) {
    const messages = messagesUpTo(script, k, arm, { includeResponsesOfK: true })
    let usage
    try {
      usage = await call(messages)
    } catch (error) {
      console.log(`  ${arm} 第 ${k + 1} 轮失败：${error.message}`)
      break
    }
    const h = usage.prompt_cache_hit_tokens ?? 0
    const m = usage.prompt_cache_miss_tokens ?? 0
    hit += h
    miss += m
    perRound.push({ round: k + 1, hit: h, miss: m, chars: sizeOf(messages) })
    process.stdout.write(`  ${arm} ${k + 1}/${script.length}\r`)
  }
  const cost = hit * PRICE_HIT + miss * PRICE_MISS
  out[arm] = { hit, miss, cost, perRound }
  console.log(`  ${arm.padEnd(5)} 命中 ${hit.toLocaleString()} · 未命中 ${miss.toLocaleString()} · 成本 $${cost.toFixed(4)}          `)
}

const a = out.full
const b = out.stub
console.log(`\n=== 对照 ===`)
console.log(`命中量    ${a.hit.toLocaleString()} → ${b.hit.toLocaleString()}（${((1 - b.hit / (a.hit || 1)) * 100).toFixed(1)}% 减少）`)
console.log(`未命中量  ${a.miss.toLocaleString()} → ${b.miss.toLocaleString()}（${a.miss === b.miss ? '完全相同 ⇒ **零断点税** ✓' : '有差异，需查' }）`)
console.log(`成本      $${a.cost.toFixed(4)} → $${b.cost.toFixed(4)}（${((1 - b.cost / (a.cost || 1)) * 100).toFixed(1)}% 减少）`)
if (JSON_OUT) console.log(`\n${JSON.stringify(out, null, 2)}`)
