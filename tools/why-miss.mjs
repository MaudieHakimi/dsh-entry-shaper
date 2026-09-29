// 定位"整份未命中"的成因：在某次大 miss 之前，会话里刚刚发生了什么？
// 判据：查 miss 之前最近的若干事件类型 —— 压缩 / 插件变更 / provider 变更 / 会话重启
// 用法: node why-miss.mjs <session.jsonl.zstd> [--at=seq] [--n=25]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`))
  return h === undefined ? d : h.split('=')[1]
}
const AT = Number(arg('at', 0))
const N = Number(arg('n', 25))
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

const steps = events.filter((e) => e.type === 'assistant/message' && e.data?.usage)
console.log(`事件 ${events.length}；带 usage 的步 ${steps.length}`)

// 全部"整份未命中"的步（miss 占比 > 80% 且 > 50000）
console.log('\n=== 整份未命中的步（miss/(miss+hit) > 80% 且 miss > 50000）===')
for (const s of steps) {
  const u = s.data.usage
  const miss = u.inputTokens ?? 0
  const hit = u.cacheReadTokens ?? 0
  if (miss > 50000 && miss / Math.max(1, miss + hit) > 0.8) {
    console.log(`  seq=${s.seq} turn=${s.data.turn} step=${s.data.step} miss=${miss.toLocaleString()} hit=${hit.toLocaleString()}`)
  }
}

if (AT > 0) {
  const idx = events.findIndex((e) => e.seq === AT)
  console.log(`\n=== seq=${AT} 之前的 ${N} 条事件 ===`)
  for (const e of events.slice(Math.max(0, idx - N), idx + 2)) {
    const d = e.data ?? {}
    const extra = []
    if (d.turn !== undefined) extra.push(`turn=${d.turn}`)
    if (d.step !== undefined) extra.push(`step=${d.step}`)
    if (d.usage) extra.push(`miss=${(d.usage.inputTokens ?? 0).toLocaleString()}/hit=${(d.usage.cacheReadTokens ?? 0).toLocaleString()}`)
    if (e.surfaceOp) extra.push(`surfaceOp=${typeof e.surfaceOp === 'string' ? e.surfaceOp : JSON.stringify(e.surfaceOp)}`)
    if (typeof e.type === 'string' && e.type.startsWith('compaction/')) extra.push('◀ 压缩')
    const t = typeof e.time === 'number' ? new Date(e.time).toISOString().slice(11, 19) : '--:--:--'
    console.log(`  ${t} seq=${String(e.seq).padStart(9)} ${String(e.type).padEnd(24)} ${extra.join(' ')}`)
  }
}
