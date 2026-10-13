// 原文回溯：把会话里的塑形文本换回原文。
//
// 用法：
//   node tools/original.mjs <shaped 文本>          # 查一条
//   node tools/original.mjs --session <会话文件>    # 把整个会话里的塑形块列出来并尝试还原
//   node tools/original.mjs --list                  # 列出寄存表里所有条目
//
// 背景（为什么不把原文塞回 payload）：塑形文本会作为上下文回灌模型，模型会把它当成
// 自己思维链的一部分继续生成（wire 级取证见 docs/POLLUTION.md）⇒ 只能在**侧路**留档。
//
// 寄存表：~/.dsh-entry-shaper.originals.jsonl（每轮清空，只覆盖当前轮）
import { readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ORIGINALS = process.env.DSH_ENTRY_SHAPER_ORIGINALS ?? join(homedir(), '.dsh-entry-shaper.originals.jsonl')

function loadIndex() {
  const map = new Map()
  if (!existsSync(ORIGINALS)) return map
  for (const line of readFileSync(ORIGINALS, 'utf8').split('\n')) {
    if (line === '') continue
    try {
      const r = JSON.parse(line)
      if (typeof r?.k === 'string' && typeof r?.v === 'string') map.set(r.k, r.v)
    } catch { /* 坏行忽略 */ }
  }
  return map
}

const args = process.argv.slice(2)
const idx = loadIndex()

if (args.length === 0 || args[0] === '--help') {
  console.log(`原文回溯工具

寄存表 ${ORIGINALS}
${existsSync(ORIGINALS) ? `当前 ${idx.size} 条（${(statSync(ORIGINALS).size / 1024).toFixed(1)} KB）` : '（不存在 —— 还没跑过带塑形的会话，或已换轮清空）'}

用法:
  node tools/original.mjs --list                    列出所有条目
  node tools/original.mjs "<shaped 文本>"            查一条
  node tools/original.mjs --file <文本文件>          从文件读（适合长文本）
  node tools/original.mjs --stats                    统计

注意：寄存表**每轮清空**，只覆盖当前这一轮（防硬盘无限增长）。
更早的原文请从会话日志的 assistant/chunk 里找（同样是塑形形态 ⇒ 不可还原）。
`)
  process.exit(0)
}

if (args[0] === '--list') {
  if (idx.size === 0) { console.log('（空）'); process.exit(0) }
  console.log(`共 ${idx.size} 条：\n`)
  for (const [k, v] of idx) {
    console.log(`  ${k.slice(0, 12)}…  原文 ${String(v.length).padStart(7)} 字符  ${JSON.stringify(v.slice(0, 70))}`)
  }
  process.exit(0)
}

if (args[0] === '--stats') {
  const sizes = [...idx.values()].map((v) => v.length)
  if (sizes.length === 0) { console.log('（空）'); process.exit(0) }
  const sorted = [...sizes].sort((a, b) => a - b)
  console.log(`条目 ${sizes.length}`)
  console.log(`原文字符：中位 ${sorted[Math.floor(sorted.length / 2)]}  均值 ${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)}  最大 ${sorted[sorted.length - 1]}`)
  console.log(`总字符 ${sizes.reduce((a, b) => a + b, 0).toLocaleString()}（文件 ${(statSync(ORIGINALS).size / 1024).toFixed(1)} KB）`)
  process.exit(0)
}

let target = args[0]
if (target === '--file') target = readFileSync(args[1], 'utf8')
const k = createHash('sha256').update(target).digest('hex')
const hit = idx.get(k)
if (hit === undefined) {
  console.log('未找到对应原文。可能原因：')
  console.log('  ① 该块未经塑形（原文====塑形结果，不记录）')
  console.log('  ② 已换轮清空（寄存表只覆盖当前轮）')
  console.log('  ③ 塑形发生在另一次运行里')
  process.exit(1)
}
console.log(`找到原文（${hit.length} 字符，塑形后 ${target.length} 字符，压缩 ${(100 * (1 - target.length / hit.length)).toFixed(1)}%）：\n`)
console.log(hit)
