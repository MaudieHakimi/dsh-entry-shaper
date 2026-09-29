// 按**时间**统计"今天"的 token 消耗，并定位未命中的来源：
//   * 每条 assistant/message 带 time（毫秒）与 usage
//   * 按本地日期分组，算命中的/未命中的
//   * 把当天 miss 最大的若干步列出来（turn/step/前一条压缩事件），看它们是不是断点
// 用法: node today-usage.mjs <sessions 根目录> [--day=2026-09-24] [--hit=0.02] [--miss=1] [--top=15]
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
const TOP = Number(arg('top', 15))
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

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

/** 本地日期（YYYY-MM-DD） */
const dayOf = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const day = arg('day', dayOf(Date.now()))

const sessions = []
for (const ws of readdirSync(root)) {
  const wsDir = join(root, ws)
  try { if (!statSync(wsDir).isDirectory()) continue } catch { continue }
  for (const s of readdirSync(wsDir)) {
    const file = join(wsDir, s, 'session.jsonl.zstd')
    if (existsSync(file)) sessions.push({ ws, s, file })
  }
}

const byDay = new Map()
const todaySteps = []
let scanned = 0
for (const { ws, s, file } of sessions) {
  const events = readEvents(file)
  scanned += 1
  // 压缩事件的时间点（用于判断某一步是不是"压缩后第一次请求"）
  const compTimes = events.filter((e) => typeof e.type === 'string' && e.type.startsWith('compaction/')).map((e) => e.time ?? 0)
  for (const e of events) {
    if (e.type !== 'assistant/message' || !e.data?.usage || typeof e.time !== 'number') continue
    const u = e.data.usage
    const key = dayOf(e.time)
    const cur = byDay.get(key) ?? { hit: 0, miss: 0, out: 0, steps: 0 }
    cur.hit += u.cacheReadTokens ?? 0
    cur.miss += u.inputTokens ?? 0
    cur.out += u.outputTokens ?? 0
    cur.steps += 1
    byDay.set(key, cur)
    if (key === day) {
      const miss = u.inputTokens ?? 0
      const nearest = compTimes.filter((t) => t <= e.time).sort((a, b) => b - a)[0]
      todaySteps.push({
        ws: ws.replace(/^--D-/, '').slice(0, 30), s: s.slice(0, 12),
        seq: e.seq, turn: e.data.turn, step: e.data.step,
        hit: u.cacheReadTokens ?? 0, miss,
        afterCompactionMs: nearest === undefined ? null : e.time - nearest,
      })
    }
  }
}

console.log(`扫描 ${scanned} 个会话；按本地日期统计（价格 命中 $${HIT}/M、未命中 $${MISS}/M）\n`)
const days = [...byDay].sort((a, b) => (a[0] < b[0] ? 1 : -1))
for (const [d, v] of days) {
  const cost = v.hit / 1e6 * HIT + v.miss / 1e6 * MISS
  const mark = d === day ? '  ← 今天' : ''
  console.log(`  ${d}  步=${String(v.steps).padStart(5)}  命中=${v.hit.toLocaleString().padStart(13)}  未命中=${v.miss.toLocaleString().padStart(11)}  输出=${v.out.toLocaleString().padStart(9)}  $${cost.toFixed(3)}${mark}`)
}
const t = byDay.get(day)
if (!t) { console.log(`\n今天（${day}）没有带 usage 的步`); process.exit(0) }
console.log(`\n今天合计：步=${t.steps}  输入=${(t.hit + t.miss).toLocaleString()}  命中=${t.hit.toLocaleString()} (${(t.hit / (t.hit + t.miss) * 100).toFixed(1)}%)  未命中=${t.miss.toLocaleString()}`)
console.log(`  $${(t.hit / 1e6 * HIT + t.miss / 1e6 * MISS).toFixed(4)}（命中 $${(t.hit / 1e6 * HIT).toFixed(4)} + 未命中 $${(t.miss / 1e6 * MISS).toFixed(4)}）`)

const sorted = todaySteps.filter((s) => s.miss > 0).sort((a, b) => b.miss - a.miss)
const totalMiss = sorted.reduce((a, b) => a + b.miss, 0)
console.log(`\n今天未命中最大的 ${TOP} 步（合计占今天未命中的 ${(sorted.slice(0, TOP).reduce((a, b) => a + b.miss, 0) / Math.max(1, totalMiss) * 100).toFixed(0)}%）：`)
console.log(`  ${'工作区'.padEnd(30)}${'会话'.padEnd(13)}${'seq'.padStart(9)}${'turn'.padStart(6)}${'step'.padStart(5)}${'命中'.padStart(10)}${'未命中'.padStart(10)}  距上次压缩`)
for (const s of sorted.slice(0, TOP)) {
  const d = s.afterCompactionMs === null ? '—' : `${Math.round(s.afterCompactionMs / 1000)}s`
  console.log(`  ${s.ws.padEnd(30)}${s.s.padEnd(13)}${String(s.seq).padStart(9)}${String(s.turn).padStart(6)}${String(s.step).padStart(5)}${s.hit.toLocaleString().padStart(10)}${s.miss.toLocaleString().padStart(10)}  ${d}`)
}
// 分类：miss 大且紧邻压缩 ⇒ 断点；否则 ⇒ 正常新增（首次请求/新会话前缀）
const brk = sorted.filter((s) => s.afterCompactionMs !== null && s.afterCompactionMs < 120000)
const brkSum = brk.reduce((a, b) => a + b.miss, 0)
console.log(`\n归因：`)
console.log(`  压缩后 2 分钟内的步：${brk.length} 个，未命中 ${brkSum.toLocaleString()} = $${(brkSum / 1e6 * MISS).toFixed(4)}（断点税）`)
console.log(`  其余（新会话首请求 / 新增内容）：${(totalMiss - brkSum).toLocaleString()} = $${((totalMiss - brkSum) / 1e6 * MISS).toFixed(4)}`)
