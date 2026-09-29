// 用多种口径算未命中，(1) 本地日 / (2) UTC 日 / (3) 滚动 24h / (4) 最近 N 小时，
// 并与平台显示的"3,000,000"对比，找出到底是哪种口径 —— 或者确认真有缺口。
// 用法: node recount-miss.mjs <sessions 根目录> [--now=ISO8601]
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2]
const nowArg = process.argv.find((a) => a.startsWith('--now='))
const now = nowArg === undefined ? Date.now() : Date.parse(nowArg.split('=')[1])
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

const steps = []
for (const ws of readdirSync(root)) {
  const wsDir = join(root, ws)
  try { if (!statSync(wsDir).isDirectory()) continue } catch { continue }
  for (const s of readdirSync(wsDir)) {
    const file = join(wsDir, s, 'session.jsonl.zstd')
    if (!existsSync(file)) continue
    for (const e of readEvents(file)) {
      if (e.type !== 'assistant/message' || !e.data?.usage || typeof e.time !== 'number') continue
      steps.push({ t: e.time, hit: e.data.usage.cacheReadTokens ?? 0, miss: e.data.usage.inputTokens ?? 0, out: e.data.usage.outputTokens ?? 0, ws: ws.slice(0, 24), s: s.slice(0, 10) })
    }
  }
}
steps.sort((a, b) => a.t - b.t)
const L = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
console.log(`样本 ${steps.length} 步；最早 ${L(steps[0].t)}；最晚 ${L(steps.at(-1).t)}（本地 GMT+8）\n`)

const win = (from, to, label) => {
  const sel = steps.filter((s) => s.t >= from && s.t < to)
  const hit = sel.reduce((a, s) => a + s.hit, 0)
  const miss = sel.reduce((a, s) => a + s.miss, 0)
  const out = sel.reduce((a, s) => a + s.out, 0)
  console.log(`  ${label.padEnd(34)} 步=${String(sel.length).padStart(4)}  命中=${hit.toLocaleString().padStart(13)}  未命中=${miss.toLocaleString().padStart(11)}  输出=${out.toLocaleString().padStart(8)}`)
  return { hit, miss, out, n: sel.length }
}
// 本地日边界（GMT+8）
const localDayStart = (t) => {
  const d = new Date(t + 8 * 3600e3)
  d.setUTCHours(0, 0, 0, 0)
  return d.getTime() - 8 * 3600e3
}
const today = localDayStart(now)
const utcDayStart = (t) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime() }

console.log('=== 各种口径 ===')
win(today, today + 86400e3, '本地日（GMT+8）今天')
win(utcDayStart(now), utcDayStart(now) + 86400e3, 'UTC 日（今天）')
win(now - 86400e3, now + 1, '滚动最近 24 小时')
win(now - 12 * 3600e3, now + 1, '滚动最近 12 小时')
win(localDayStart(now - 86400e3), today, '本地日 昨天')
win(localDayStart(now - 2 * 86400e3), localDayStart(now - 86400e3), '本地日 前天')

console.log('\n=== 逐小时（本地）未命中，最近 36 小时 ===')
const byHour = new Map()
for (const s of steps) {
  if (s.t < now - 36 * 3600e3) continue
  const d = new Date(s.t + 8 * 3600e3)
  d.setUTCMinutes(0, 0, 0)
  const key = d.getTime() - 8 * 3600e3
  const cur = byHour.get(key) ?? { hit: 0, miss: 0, out: 0, n: 0 }
  cur.hit += s.hit; cur.miss += s.miss; cur.out += s.out; cur.n += 1
  byHour.set(key, cur)
}
for (const [k, v] of [...byHour].sort((a, b) => a[0] - b[0])) {
  const bar = '#'.repeat(Math.min(40, Math.round(v.miss / 20000)))
  console.log(`  ${L(k).slice(5, 16)}  步=${String(v.n).padStart(3)}  miss=${v.miss.toLocaleString().padStart(9)}  ${bar}`)
}
