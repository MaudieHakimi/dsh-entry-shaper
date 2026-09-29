// 从 llm-tap 的巨型 jsonl 尾部取样，验证「wire 级塑形是否真的生效」。
// 只读文件末尾若干 MB（文件已 6.7GB，不能整读）。
// 关键：本插件代理会**转调 llm.stream()** ⇒ tap 挂在内层，记录的就是**塑形后**的出网请求 ✓
import { openSync, readSync, closeSync, statSync } from 'node:fs'

const file = process.argv[2]
const want = Number(process.argv[3] ?? 4)          // 取最后几条 request
const bytes = Number(process.argv[4] ?? 4_000_000) // 从尾部读多少字节
const size = statSync(file).size
const from = Math.max(0, size - bytes)
const fd = openSync(file, 'r')
const buf = Buffer.alloc(size - from)
readSync(fd, buf, 0, buf.length, from)
closeSync(fd)

const lines = buf.toString('utf8').split('\n')
const recs = []
for (const line of lines) {
  if (!line.startsWith('{')) continue
  try { recs.push(JSON.parse(line)) } catch { /* 半行 */ }
}
const kinds = new Map()
for (const r of recs) kinds.set(r.kind ?? '?', (kinds.get(r.kind ?? '?') ?? 0) + 1)
console.log(`尾部 ${(buf.length / 1048576).toFixed(1)} MB：${recs.length} 条记录，kind 分布 = ${[...kinds].map(([k, c]) => `${k}:${c}`).join(', ')}`)

const reqs = recs.filter((r) => r.kind === 'request')
console.log(`request 记录 ${reqs.length} 条\n`)

/** 统计一条 tap request 记录里 content 的形态（content 是消息数组或 {messages:[]}） */
function analyze(r) {
  const c = r.content
  const msgs = Array.isArray(c) ? c : (Array.isArray(c?.messages) ? c.messages : null)
  if (!msgs) return { msgs: null, shape: typeof c === 'object' ? Object.keys(c ?? {}).join(',') : typeof c }
  const s = { msgs: msgs.length, reasoning: 0, reasoningChars: 0, extracted: 0, stub: 0, text: 0, toolCall: 0, toolResult: 0, msgChars: 0 }
  for (const m of msgs) {
    for (const b of m?.content ?? []) {
      if (typeof b === 'string') { s.msgChars += b.length; continue }
      if (typeof b?.text === 'string') s.msgChars += b.text.length
      else if (typeof b?.arguments === 'string') s.msgChars += b.arguments.length
      if (b?.type === 'reasoning') {
        s.reasoning += 1
        s.reasoningChars += (b.text ?? '').length
        if ((b.text ?? '').startsWith('[reasoning extract:')) s.extracted += 1
        else if ((b.text ?? '').startsWith('[reasoning omitted:')) s.stub += 1
      } else if (b?.type === 'text') s.text += 1
      else if (b?.type === 'tool-call') s.toolCall += 1
      else if (b?.type === 'tool-result') s.toolResult += 1
    }
  }
  return s
}

for (const r of reqs.slice(-want)) {
  const a = analyze(r)
  console.log(`provider=${String(r.provider).padEnd(18)} model=${String(r.model).padEnd(26)} messageCount=${String(r.messageCount).padStart(4)} inputChars=${String(r.inputChars).padStart(9)} effort=${r.reasoningEffort}`)
  if (a.msgs === null) { console.log(`   ⚠ content 形态不同: ${a.shape}`); continue }
  console.log(`   content.messages=${a.msgs}  统计字符=${a.msgChars}`)
  console.log(`   reasoning 块=${a.reasoning}（已塑形 extract=${a.extracted} stub=${a.stub}）reasoning 字符=${a.reasoningChars}`)
  console.log(`   text=${a.text} tool-call=${a.toolCall} tool-result=${a.toolResult}`)
  const sample = (Array.isArray(r.content) ? r.content : r.content.messages)
    .flatMap((m) => m?.content ?? [])
    .find((b) => b?.type === 'reasoning' && (b.text ?? '').startsWith('[reasoning'))
  if (sample) console.log(`   样例: ${sample.text.slice(0, 150).replace(/\s+/g, ' ')}`)
}
