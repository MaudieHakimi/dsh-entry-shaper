// 严格配对 + 量化：证明「外层(塑形前) → 内层(塑形后)」是同一次调用，并给出缩减比例。
// 配对判据：tap 记录的 callId。代理转调 llm.stream() 时，内层会拿到同一个调用上下文，
// 因此两条记录的 callId 应有稳定的对应关系（同一前缀/同一后缀）。
// 另外 content 字段是字符串 ⇒ 先看它到底是什么。
import { openSync, readSync, closeSync, statSync } from 'node:fs'

const file = process.argv[2]
const bytes = Number(process.argv[3] ?? 20_000_000)
const size = statSync(file).size
const from = Math.max(0, size - bytes)
const fd = openSync(file, 'r')
const buf = Buffer.alloc(size - from)
readSync(fd, buf, 0, buf.length, from)
closeSync(fd)

const recs = []
for (const line of buf.toString('utf8').split('\n')) {
  if (!line.startsWith('{')) continue
  try { recs.push(JSON.parse(line)) } catch { /* 半行 */ }
}
const reqs = recs.filter((r) => r.kind === 'request')
console.log(`取样 ${(buf.length / 1048576).toFixed(1)} MB；request ${reqs.length} 条\n`)

console.log('=== 每条 request 的 callId / provider / inputChars ===')
for (const r of reqs) {
  console.log(`  callId=${String(r.callId).padEnd(28)} provider=${String(r.provider).padEnd(18)} inputChars=${String(r.inputChars).padStart(9)} messageCount=${r.messageCount}`)
}

console.log('\n=== content 字段到底是什么 ===')
const last = reqs.at(-1)
const c = last?.content
console.log(`  typeof=${typeof c}${typeof c === 'string' ? ` length=${c.length}` : ''}`)
if (typeof c === 'string') console.log(`  前 300 字符: ${c.slice(0, 300).replace(/\s+/g, ' ')}`)

// 配对：按出现顺序，把 shaped 与其后紧邻的 official 配成一对（同一 turn 的外层/内层）
console.log('\n=== 外层(shaped=塑形前) / 内层(official=塑形后) 配对 ===')
const pairs = []
for (let i = 0; i < reqs.length; i++) {
  if (reqs[i].provider !== 'deepseek-shaped') continue
  const inner = reqs.slice(i + 1).find((r) => r.provider === 'deepseek-official')
  if (!inner) continue
  pairs.push({ outer: reqs[i], inner })
}
console.log(`配对 ${pairs.length} 对：`)
let sumOuter = 0
let sumInner = 0
for (const p of pairs) {
  const saved = p.outer.inputChars - p.inner.inputChars
  sumOuter += p.outer.inputChars
  sumInner += p.inner.inputChars
  console.log(`  外层 ${String(p.outer.inputChars).padStart(9)} → 内层 ${String(p.inner.inputChars).padStart(9)}` +
    `  省 ${String(saved).padStart(9)} 字符 (${(saved / p.outer.inputChars * 100).toFixed(1)}%)  消息 ${p.outer.messageCount}→${p.inner.messageCount}`)
}
if (pairs.length > 0) {
  console.log(`\n合计 ${sumOuter.toLocaleString()} → ${sumInner.toLocaleString()} 字符` +
    ` ⇒ 省 ${(sumOuter - sumInner).toLocaleString()}（${((sumOuter - sumInner) / sumOuter * 100).toFixed(1)}%）`)
}
