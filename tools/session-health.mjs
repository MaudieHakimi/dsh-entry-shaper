// 单会话深度体检：命中率、断点、payload 曲线、每回合成本。
// 用法: node session-health.mjs <session.jsonl.zstd> [--tail=30]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const TAIL = Number((process.argv.find((a) => a.startsWith('--tail=')) ?? '--tail=20').split('=')[1])
const HIT = 0.02
const MISS = 1
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

const buf = readFileSync(file)
const magics = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) magics.push(i)
}
const events = []
for (let k = 0; k < magics.length; k++) {
  const slice = buf.subarray(magics[k], k + 1 < magics.length ? magics[k + 1] : buf.length)
  for (let j = slice.length; j > 0 && j > slice.length - 4; j--) {
    let text = null
    try { text = zstdDecompressSync(slice.subarray(0, j)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue
      try { events.push(JSON.parse(line)) } catch { /* 半行 */ }
    }
    break
  }
}

const L = (ms) => (typeof ms === 'number' ? new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 19) : '--')
const steps = events.filter((e) => e.type === 'assistant/message' && e.data?.usage && typeof e.time === 'number')
console.log(`会话 ${file.split(/[\\/]/).slice(-2)[0]}  ${(buf.length / 1048576).toFixed(1)} MB  事件 ${events.length.toLocaleString()}`)
console.log(`  步数 ${steps.length}  时段 ${L(steps[0]?.time)} → ${L(steps.at(-1)?.time)}`)

let hit = 0
let miss = 0
let outTok = 0
const byTurn = new Map()
const misses = []
for (const s of steps) {
  const u = s.data.usage
  const h = u.cacheReadTokens ?? 0
  const m = u.inputTokens ?? 0
  hit += h
  miss += m
  outTok += u.outputTokens ?? 0
  misses.push(m)
  const k = s.data.turn
  const cur = byTurn.get(k) ?? { turn: k, steps: 0, hit: 0, miss: 0, out: 0, max: 0, t0: s.time, t1: s.time }
  cur.steps += 1
  cur.hit += h
  cur.miss += m
  cur.out += u.outputTokens ?? 0
  cur.max = Math.max(cur.max, h + m)
  cur.t1 = s.time
  byTurn.set(k, cur)
}
const L2 = (h) => h / 1e6 * HIT + h / 1e6 * 0 // 占位避免误用
void L2
const cost = (r) => r.hit / 1e6 * HIT + r.miss / 1e6 * MISS
const total = hit / 1e6 * HIT + miss / 1e6 * MISS
console.log(`\n=== 总计 ===`)
console.log(`  输入 ${(hit + miss).toLocaleString()}（命中 ${hit.toLocaleString()} = ${(hit / Math.max(1, hit + miss) * 100).toFixed(2)}%，未命中 ${miss.toLocaleString()}）`)
console.log(`  输出 ${outTok.toLocaleString()}`)
console.log(`  成本 $${total.toFixed(4)}（命中 $${(hit / 1e6 * HIT).toFixed(4)} + 未命中 $${(miss / 1e6 * MISS).toFixed(4)}）`)
console.log(`  平均每步 payload ${Math.round((hit + miss) / Math.max(1, steps.length)).toLocaleString()} · 最大 ${Math.max(...steps.map((s) => (s.data.usage.cacheReadTokens ?? 0) + (s.data.usage.inputTokens ?? 0))).toLocaleString()}`)

// 断点：未命中显著高于常态（中位数 10 倍且 >5000）
const sorted = [...misses].sort((a, b) => a - b)
const median = sorted[Math.floor(sorted.length / 2)] ?? 0
const thr = Math.max(5000, median * 10)
const brk = steps.filter((s) => (s.data.usage.inputTokens ?? 0) > thr)
const tax = brk.reduce((a, s) => a + (s.data.usage.inputTokens ?? 0), 0)
console.log(`\n=== 断点 ===`)
console.log(`  常态未命中中位数 ${median} · 阈值 ${thr}`)
console.log(`  断点 ${brk.length} 次 · 断点税 ${tax.toLocaleString()} token = $${(tax / 1e6 * MISS).toFixed(4)}（占未命中 ${(tax / Math.max(1, miss) * 100).toFixed(0)}%）`)
for (const s of brk.slice(-8)) {
  const prev = steps[steps.indexOf(s) - 1]
  const gap = prev ? (s.time - prev.time) / 60000 : null
  console.log(`    ${L(s.time)} turn=${String(s.data.turn).padStart(4)} step=${String(s.data.step).padStart(2)} miss=${String(s.data.usage.inputTokens ?? 0).padStart(8)} hit=${String(s.data.usage.cacheReadTokens ?? 0).padStart(8)}${gap === null ? '' : `  间隔 ${gap.toFixed(1)}min`}`)
}

// payload 曲线（每回合峰值）
const turnRows = [...byTurn.values()]
console.log(`\n=== payload 曲线（每回合峰值，共 ${turnRows.length} 个回合）===`)
const maxTurn = Math.max(...turnRows.map((r) => r.max))
for (const r of turnRows.slice(-TAIL)) {
  const bar = '#'.repeat(Math.max(1, Math.round(r.max / maxTurn * 44)))
  console.log(`  turn ${String(r.turn).padStart(4)} 步=${String(r.steps).padStart(3)} 峰值=${r.max.toLocaleString().padStart(9)} miss=${r.miss.toLocaleString().padStart(8)} $${cost(r).toFixed(4).padStart(8)}  ${bar}`)
}
console.log(`\n=== 最贵的 6 个回合 ===`)
for (const r of [...turnRows].sort((a, b) => cost(b) - cost(a)).slice(0, 6)) {
  console.log(`  turn ${String(r.turn).padStart(4)} 步=${String(r.steps).padStart(3)} 峰值payload=${r.max.toLocaleString().padStart(9)} 输入=${(r.hit + r.miss).toLocaleString().padStart(12)} $${cost(r).toFixed(4)}`)
}
