// 归因：今天 221 次 web 搜索是谁发起的（哪个会话/工作区），以及它们与主对话的时序关系。
// 判据：`web/deepseek-search-llm-request` 事件带 time，可按会话/工作区归属；
//      再对照该会话同时段的 assistant/message 步数与未命中，看是不是"搜索风暴"。
// 用法: node sao-search-attrib.mjs <sessions 根目录>
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
const L = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 16)

const perSession = []
const hourly = new Map()
for (const ws of readdirSync(root)) {
  const wd = join(root, ws)
  try { if (!statSync(wd).isDirectory()) continue } catch { continue }
  for (const s of readdirSync(wd)) {
    const file = join(wd, s, 'session.jsonl.zstd')
    if (!existsSync(file)) continue
    const events = readEvents(file)
    const today = events.filter((e) => typeof e.time === 'number' && e.time >= t0)
    if (today.length === 0) continue
    const searches = today.filter((e) => e.type === 'web/deepseek-search-llm-request')
    const steps = today.filter((e) => e.type === 'assistant/message' && e.data?.usage)
    const subagents = today.filter((e) => e.type === 'tool/call' && e.data?.name === 'subagent')
    let hit = 0
    let miss = 0
    let out = 0
    for (const st of steps) {
      hit += st.data.usage.cacheReadTokens ?? 0
      miss += st.data.usage.inputTokens ?? 0
      out += st.data.usage.outputTokens ?? 0
    }
    for (const e of searches) {
      const d = new Date(e.time + 8 * 3600e3)
      d.setUTCMinutes(0, 0, 0)
      const k = d.getTime() - 8 * 3600e3
      hourly.set(k, (hourly.get(k) ?? 0) + 1)
    }
    if (searches.length === 0 && steps.length === 0) continue
    perSession.push({
      ws: ws.replace(/^--D-/, '').slice(0, 30), s: s.slice(0, 12),
      searches: searches.length, steps: steps.length, subagents: subagents.length,
      hit, miss, out, cost: hit / 1e6 * 0.02 + miss / 1e6,
      first: today[0].time, last: today.at(-1).time,
    })
  }
}

console.log(`${'工作区'.padEnd(32)}${'会话'.padEnd(14)}${'搜索'.padStart(6)}${'子代理'.padStart(7)}${'步'.padStart(5)}${'未命中'.padStart(11)}${'成本$'.padStart(9)}  时段`)
for (const r of perSession.sort((a, b) => b.searches - a.searches)) {
  console.log(`${r.ws.padEnd(32)}${r.s.padEnd(14)}${String(r.searches).padStart(6)}${String(r.subagents).padStart(7)}${String(r.steps).padStart(5)}${r.miss.toLocaleString().padStart(11)}${r.cost.toFixed(3).padStart(9)}  ${L(r.first)}→${L(r.last)}`)
}
const ts = perSession.reduce((a, r) => a + r.searches, 0)
const tm = perSession.reduce((a, r) => a + r.miss, 0)
const tc = perSession.reduce((a, r) => a + r.cost, 0)
const tsub = perSession.reduce((a, r) => a + r.subagents, 0)
console.log(`\n合计 搜索 ${ts} 次 · 子代理调用 ${tsub} 次 · 未命中 ${tm.toLocaleString()} · $${tc.toFixed(3)}`)

console.log('\n=== 今天搜索请求的逐小时分布 ===')
for (const [k, v] of [...hourly].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${L(k)}  ${String(v).padStart(4)} 次  ${'#'.repeat(Math.min(60, v))}`)
}
