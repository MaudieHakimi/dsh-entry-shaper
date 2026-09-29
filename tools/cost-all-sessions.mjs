// 跨会话真实计费汇总：读一个工作区下所有 session.jsonl.zstd，按 usage 累计。
// 价格口径：命中 $0.02/M、未命中 $1/M（可用 --hit/--miss 覆盖）。
// 断点判定：某步未命中 ≫ 常态（常态取未命中的中位数），且绝对值 > 5000。
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const base = process.argv[2]
const argOf = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? dflt : Number(hit.split('=')[1])
}
const HIT = argOf('hit', 0.02)
const MISS = argOf('miss', 1)

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
  return { events: out, bytes: buf.length }
}

const rows = []
const total = { steps: 0, hit: 0, miss: 0, out: 0, breaks: 0, tax: 0, bytes: 0, events: 0 }
for (const name of readdirSync(base)) {
  const dir = join(base, name)
  try { if (!statSync(dir).isDirectory()) continue } catch { continue }
  const file = join(dir, 'session.jsonl.zstd')
  if (!existsSync(file)) continue
  const { events, bytes } = readEvents(file)
  const steps = events.filter((e) => e.type === 'assistant/message' && e.data?.usage && Number.isInteger(e.seq))
  let hit = 0
  let miss = 0
  let outTok = 0
  const misses = []
  for (const s of steps) {
    const u = s.data.usage
    hit += u.cacheReadTokens ?? 0
    miss += u.inputTokens ?? 0
    outTok += u.outputTokens ?? 0
    misses.push(u.inputTokens ?? 0)
  }
  // 断点 = 未命中显著高于常态（常态用中位数；阈值 5000 绝对值 + 10 倍常态）
  const sorted = [...misses].sort((a, b) => a - b)
  const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]
  const breakThreshold = Math.max(5000, median * 10)
  const breakMisses = misses.filter((m) => m > breakThreshold)
  const tax = breakMisses.reduce((a, b) => a + b, 0)
  const cost = hit / 1e6 * HIT + miss / 1e6 * MISS
  rows.push({ name: name.slice(0, 34), steps: steps.length, hit, miss, outTok, cost, breaks: breakMisses.length, tax, bytes, events: events.length })
  total.steps += steps.length
  total.hit += hit
  total.miss += miss
  total.out += outTok
  total.breaks += breakMisses.length
  total.tax += tax
  total.bytes += bytes
  total.events += events.length
}

console.log(`${'会话'.padEnd(36)}${'步'.padStart(4)}${'成本$'.padStart(9)}${'输入'.padStart(12)}${'命中%'.padStart(7)}${'断点'.padStart(5)}${'断点税'.padStart(10)}`)
for (const r of rows) {
  const inTok = r.hit + r.miss
  console.log(`${r.name.padEnd(36)}${String(r.steps).padStart(4)}${r.cost.toFixed(4).padStart(9)}`
    + `${inTok.toLocaleString().padStart(12)}${(r.hit / Math.max(1, inTok) * 100).toFixed(1).padStart(7)}`
    + `${String(r.breaks).padStart(5)}${r.tax.toLocaleString().padStart(10)}`)
}
const inAll = total.hit + total.miss
console.log(`\n合计 ${rows.length} 个会话`)
console.log(`  步数 ${total.steps} · 事件 ${total.events.toLocaleString()} · 磁盘 ${(total.bytes / 1048576).toFixed(1)} MB`)
console.log(`  输入 ${inAll.toLocaleString()}（命中 ${total.hit.toLocaleString()} = ${(total.hit / Math.max(1, inAll) * 100).toFixed(1)}%，未命中 ${total.miss.toLocaleString()}）`)
console.log(`  输出 ${total.out.toLocaleString()}`)
console.log(`  成本 $${(total.hit / 1e6 * HIT + total.miss / 1e6 * MISS).toFixed(4)}` +
  ` = 命中 $${(total.hit / 1e6 * HIT).toFixed(4)} + 未命中 $${(total.miss / 1e6 * MISS).toFixed(4)}` +
  `（按 命中 $${HIT}/M、未命中 $${MISS}/M）`)
console.log(`  断点 ${total.breaks} 次 · 断点税 ${total.tax.toLocaleString()} token` +
  ` = $${(total.tax / 1e6 * MISS).toFixed(4)}（占未命中 ${(total.tax / Math.max(1, total.miss) * 100).toFixed(0)}%）`)
if (total.miss > 0) {
  console.log(`  反事实（无断点，未命中只剩非断点部分）：$${(((total.miss - total.tax) / 1e6) * MISS + (total.hit / 1e6) * HIT).toFixed(4)}`)
}
