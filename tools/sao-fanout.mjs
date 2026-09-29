// 查清"9 个会话"的成因：是子代理拉起的，还是人工开的？
// 判据：主会话里的 `tool/call` name=subagent / subagent_fork 的参数与返回值；
//       再对照同一时段新建的会话文件数与它们的首个 user/message。
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const base = process.argv[2]
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

const L = (ms) => (typeof ms === 'number' ? new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 19) : '--')

console.log('=== 各会话：创建时间 / 首条用户消息 / 子代理调用数 / 搜索数 ===')
const dirs = readdirSync(base).filter((d) => existsSync(join(base, d, 'session.jsonl.zstd')))
const rows = []
for (const d of dirs) {
  const events = readEvents(join(base, d, 'session.jsonl.zstd'))
  const first = events.find((e) => e.type === 'user/message')
  const firstText = (() => {
    const c = first?.data?.message?.content
    if (typeof c === 'string') return c.slice(0, 70)
    if (Array.isArray(c)) {
      for (const b of c) if (typeof b?.text === 'string') return b.text.slice(0, 70)
    }
    return '(无文本)'
  })()
  const subCalls = events.filter((e) => e.type === 'tool/call' && String(e.data?.name ?? '').startsWith('subagent'))
  const searches = events.filter((e) => e.type === 'web/deepseek-search-llm-request')
  const t0 = events.find((e) => typeof e.time === 'number')?.time
  rows.push({ d: d.slice(0, 20), t0, steps: events.filter((e) => e.type === 'assistant/message' && e.data?.usage).length, sub: subCalls.length, searches: searches.length, firstText })
}
for (const r of rows.sort((a, b) => (a.t0 ?? 0) - (b.t0 ?? 0))) {
  console.log(`  ${L(r.t0)}  ${r.d.padEnd(21)} 步=${String(r.steps).padStart(3)} 子代理=${r.sub} 搜索=${String(r.searches).padStart(3)}  首条:「${r.firstText}」`)
}

console.log('\n=== 主会话里的子代理调用（谁开的、开给谁）===')
for (const r of rows) {
  const events = readEvents(join(base, dirs.find((d) => d.startsWith(r.d.slice(0, 12))) ?? dirs[0], 'session.jsonl.zstd'))
  const calls = events.filter((e) => e.type === 'tool/call' && String(e.data?.name ?? '').startsWith('subagent'))
  if (calls.length === 0) continue
  console.log(`  ${r.d}:`)
  for (const c of calls) {
    let args = {}
    try { args = JSON.parse(c.data?.arguments ?? '{}') } catch { /* 忽略 */ }
    const desc = args.description ?? args.label ?? '(无描述)'
    console.log(`    ${L(c.time)} ${c.data.name}  description="${String(desc).slice(0, 50)}"`)
  }
}
