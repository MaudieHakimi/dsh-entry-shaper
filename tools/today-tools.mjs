// 今天工具结果的体量分布 —— 这些内容会永久进入上下文，此后每一步都随 payload 重发。
// 用法: node today-tools.mjs <sessions 根目录>
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2]
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

const todayStart = new Date()
todayStart.setHours(0, 0, 0, 0)
const t0 = todayStart.getTime()
const textLen = (e) => {
  let n = 0
  for (const b of e.data?.message?.content ?? []) {
    for (const p of b?.content ?? []) if (typeof p?.text === 'string') n += p.text.length
  }
  return n
}

const byName = new Map()
const calls = new Map()
let total = 0
let count = 0
for (const ws of readdirSync(root)) {
  const wd = join(root, ws)
  try { if (!statSync(wd).isDirectory()) continue } catch { continue }
  for (const s of readdirSync(wd)) {
    const file = join(wd, s, 'session.jsonl.zstd')
    if (!existsSync(file)) continue
    const events = readEvents(file)
    for (const e of events) {
      if (e.type === 'tool/call' && e.data?.callId) calls.set(e.data.callId, e.data.name)
    }
    for (const e of events) {
      if (typeof e.time !== 'number' || e.time < t0) continue
      if (e.type !== 'tool/result') continue
      const name = calls.get(e.data?.message?.source?.callId) ?? '?'
      const n = textLen(e)
      total += n
      count += 1
      const cur = byName.get(name) ?? { n: 0, chars: 0, max: 0 }
      cur.n += 1
      cur.chars += n
      cur.max = Math.max(cur.max, n)
      byName.set(name, cur)
    }
  }
}

console.log('今天工具结果（进入上下文后，此后每一步都会随 payload 重发）')
console.log(`  ${'工具名'.padEnd(22)}${'次数'.padStart(6)}${'总字符'.padStart(13)}${'平均'.padStart(10)}${'最大'.padStart(10)}`)
const rows = [...byName].sort((a, b) => b[1].chars - a[1].chars)
for (const [k, v] of rows) {
  console.log(`  ${String(k).padEnd(22)}${String(v.n).padStart(6)}${v.chars.toLocaleString().padStart(13)}${Math.round(v.chars / v.n).toLocaleString().padStart(10)}${v.max.toLocaleString().padStart(10)}`)
}
console.log('  ' + '─'.repeat(62))
console.log(`  ${count} 次调用，合计 ${total.toLocaleString()} 字符 ≈ ${Math.round(total / 3.5).toLocaleString()} token（一次性）`)
console.log('  但每个字符都在后续每一步重发 ⇒ 真实代价 ≈ 字符数 × 它之后的步数')
console.log('  ⇒ 这就是"为什么账单比想象大"的第一大来源：不是插件，是**读进来的大内容**。')
