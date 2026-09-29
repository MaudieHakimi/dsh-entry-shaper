// 按**回合（turn）**聚合今天的实际消耗：看清"每一步都要重发整个会话"是怎么堆出总账的。
// 用法: node today-turns.mjs <sessions 根目录> [--day=YYYY-MM-DD] [--top=12] [--hit=0.02] [--miss=1]
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2]
const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`))
  return h === undefined ? d : h.split('=')[1]
}
const HIT = Number(arg('hit', 0.02))
const MISS = Number(arg('miss', 1))
const TOP = Number(arg('top', 12))
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const dayOf = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const day = arg('day', dayOf(Date.now()))

function readEvents(file) {
  const buf = readFileSync(file)
  const magics = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) magics.push(i)
  }
  const out = []
  for (let k = 0; k < magics.length; k++) {
    const slice = buf.subarray(magics[k], k + 1 < magics.length ? magics[k + 1] : buf.length)
    for (let j = slice.length; j > 0 && j > slice.length - 4; j--) {
      let text = null
      try { text = zstdDecompressSync(slice.subarray(0, j)).toString('utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue
        try { out.push(JSON.parse(line)) } catch { /* 半行 */ }
      }
      break
    }
  }
  return out
}

const turns = []
let dayTot = { steps: 0, hit: 0, miss: 0, out: 0 }
for (const ws of readdirSync(root)) {
  const wsDir = join(root, ws)
  try { if (!statSync(wsDir).isDirectory()) continue } catch { continue }
  for (const s of readdirSync(wsDir)) {
    const file = join(wsDir, s, 'session.jsonl.zstd')
    if (!existsSync(file)) continue
    const steps = readEvents(file).filter((e) => e.type === 'assistant/message' && e.data?.usage && typeof e.time === 'number')
    const byTurn = new Map()
    for (const e of steps) {
      if (dayOf(e.time) !== day) continue
      const u = e.data.usage
      const key = `${ws.slice(0, 26)}|${s.slice(0, 10)}|${e.data.turn}`
      const cur = byTurn.get(key) ?? { ws: ws.replace(/^--D-/, '').slice(0, 26), s: s.slice(0, 10), turn: e.data.turn, steps: 0, hit: 0, miss: 0, out: 0, maxPayload: 0, t0: e.time, t1: e.time }
      cur.steps += 1
      cur.hit += u.cacheReadTokens ?? 0
      cur.miss += u.inputTokens ?? 0
      cur.out += u.outputTokens ?? 0
      cur.maxPayload = Math.max(cur.maxPayload, (u.cacheReadTokens ?? 0) + (u.inputTokens ?? 0))
      cur.t1 = e.time
      byTurn.set(key, cur)
    }
    for (const v of byTurn.values()) turns.push(v)
  }
}
for (const t of turns) {
  dayTot.steps += t.steps
  dayTot.hit += t.hit
  dayTot.miss += t.miss
  dayTot.out += t.out
}
const cost = (t) => t.hit / 1e6 * HIT + t.miss / 1e6 * MISS
console.log(`今天（${day}）回合数 ${turns.length}，步数 ${dayTot.steps}`)
console.log(`  输入 ${(dayTot.hit + dayTot.miss).toLocaleString()}（命中 ${dayTot.hit.toLocaleString()}，未命中 ${dayTot.miss.toLocaleString()}）  输出 ${dayTot.out.toLocaleString()}`)
const tot = cost(dayTot)
console.log(`  $${tot.toFixed(4)}（命中 $${(dayTot.hit / 1e6 * HIT).toFixed(4)} + 未命中 $${(dayTot.miss / 1e6 * MISS).toFixed(4)}）`)
console.log(`  平均每步 payload ${Math.round((dayTot.hit + dayTot.miss) / Math.max(1, dayTot.steps)).toLocaleString()} token`)
console.log(`  平均每回合 ≈ ${Math.round((dayTot.hit + dayTot.miss) / Math.max(1, turns.length)).toLocaleString()} 输入 token、$${(tot / Math.max(1, turns.length)).toFixed(4)}`)

console.log(`\n=== 最贵的 ${TOP} 个回合 ===`)
console.log(`  ${'工作区'.padEnd(28)}${'会话'.padEnd(12)}${'turn'.padStart(5)}${'步'.padStart(4)}${'峰值payload'.padStart(12)}${'输入'.padStart(12)}${'成本$'.padStart(9)}  时长`)
for (const t of [...turns].sort((a, b) => cost(b) - cost(a)).slice(0, TOP)) {
  const mins = (t.t1 - t.t0) / 60000
  console.log(`  ${t.ws.padEnd(28)}${String(t.s).padEnd(12)}${String(t.turn).padStart(5)}${String(t.steps).padStart(4)}${t.maxPayload.toLocaleString().padStart(12)}${(t.hit + t.miss).toLocaleString().padStart(12)}${cost(t).toFixed(4).padStart(9)}  ${mins.toFixed(1)}min`)
}
const topSum = [...turns].sort((a, b) => cost(b) - cost(a)).slice(0, TOP).reduce((a, t) => a + cost(t), 0)
console.log(`  ↑ 这 ${TOP} 个回合 = $${topSum.toFixed(4)}，占今天 ${(topSum / Math.max(1e-9, tot) * 100).toFixed(0)}%`)

// 关键洞察：payload 越大、步数越多 ⇒ 成本按"步数 × payload"增长
console.log('\n=== 为什么这么大：每步都要重发整个会话 ===')
const ranked = [...turns].sort((a, b) => b.maxPayload - a.maxPayload).slice(0, 6)
for (const t of ranked) {
  console.log(`  峰值 payload ${t.maxPayload.toLocaleString().padStart(9)} × ${String(t.steps).padStart(3)} 步 ⇒ 输入 ${(t.hit + t.miss).toLocaleString().padStart(12)}（≈ ${(t.steps * t.maxPayload).toLocaleString()}）`)
}
