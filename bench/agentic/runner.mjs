// 带判分的 agentic 基准：多轮工具调用 + 确定性验收 + 两臂对照（full / stub）。
//
// 为什么自己做而不是直接用现成平台：SWE-bench / Terminal-Bench / tau-bench / BFCL 都**自带 agent**，
// 它们测模型；我们要测的是"DSH 插件对 payload 的改造会不会影响任务结果"，必须让**我们自己这套
// 工具回路**当 agent。于是借它们的**任务形态与判分方式**，自建最小运行器：
//   * 工具：read_file / write_file / run_shell（对上 DSH 的 shell+文件工具）
//   * 回路：模型 → 工具调用 → 执行 → 结果回灌 → 直到模型不再调用工具或达到轮数上限
//   * 两臂：full（reasoning_content 原样回传）vs stub（本插件的改造：字段保留、内容换桩）
//   * 判分：每个任务自带确定性检查器（跑测试 / 比对输出 / 断言文件）
//   * 观测：任务成功率（质量）+ 轮数 + token 与估算成本（省钱）
//
// 用法：
//   node bench/agentic/runner.mjs [--tasks=all|id,id] [--arms=full,stub] [--max-rounds=30] [--json]
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TASKS, setupTask, runShell, readFileIn } from './tasks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '.work')
const PRICE_HIT = 0.02 / 1e6
const PRICE_MISS = 1 / 1e6

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.split('=')[1] : d
}
const MODEL = arg('model', 'deepseek-flash')
const MAX_ROUNDS = Number(arg('max-rounds', 30))
const ONLY = arg('tasks', 'all')
const ARMS = arg('arms', 'full,stub').split(',')
const JSON_OUT = argv.includes('--json')

const KEYS = (() => {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const m = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
  if (!m) throw new Error('凭据文件里没有 DEEPSEEK_API_KEY')
  return m[1]
})()
const BASE = process.env.DSH_DEEPSEEK_BASE ?? 'https://api.deepseek.com'

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作目录里的文件（相对路径）。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入/覆盖工作目录里的文件（相对路径）。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: '在工作目录里执行一条 pwsh 命令并返回输出。',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
]

const SYSTEM = '你是一个在仓库里干活的编码 agent。用给定工具读文件、改文件、跑命令，'
  + '直到任务完成；完成后**不要**再调用工具，直接用一句话说明你做了什么。'

async function callApi(messages, { stubReasoning }) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS}` },
    body: JSON.stringify({ model: MODEL, stream: false, messages, tools: TOOLS, temperature: 0, max_tokens: 1024 }),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(`API ${res.status}: ${(parsed?.error?.message ?? text).slice(0, 200)}`)
  const msg = parsed.choices?.[0]?.message ?? { content: '' }
  // 臂差异就在这里：桩化 = 字段保留、内容换成短桩（缺字段会被 API 400）
  if (stubReasoning && typeof msg.reasoning_content === 'string') {
    msg.reasoning_content = `[reasoning omitted: ${msg.reasoning_content.length} chars]`
  }
  return { message: msg, usage: parsed.usage }
}

/** 跑一个任务的一条臂。 */
async function runOne(task, arm) {
  const dir = join(WORK, `${task.id}-${arm}`)
  rmSync(dir, { recursive: true, force: true })
  setupTask(task, dir)

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${task.prompt}\n\n工作目录已就绪，用相对路径操作。` },
  ]
  const stats = { rounds: 0, toolCalls: 0, hit: 0, miss: 0, cacheHitSteps: 0 }
  const stubReasoning = arm === 'stub'
  let finished = false

  for (let round = 0; round < MAX_ROUNDS; round++) {
    stats.rounds += 1
    let r
    try {
      r = await callApi(messages, { stubReasoning })
    } catch (error) {
      return { arm, ok: false, error: String(error.message), stats }
    }
    stats.hit += r.usage?.prompt_cache_hit_tokens ?? 0
    stats.miss += r.usage?.prompt_cache_miss_tokens ?? 0
    if ((r.usage?.prompt_cache_hit_tokens ?? 0) > 0) stats.cacheHitSteps += 1

    const assistant = { role: 'assistant', content: r.message.content ?? '' }
    if (typeof r.message.reasoning_content === 'string') assistant.reasoning_content = r.message.reasoning_content
    if (Array.isArray(r.message.tool_calls) && r.message.tool_calls.length > 0) assistant.tool_calls = r.message.tool_calls
    messages.push(assistant)

    const calls = r.message.tool_calls ?? []
    if (calls.length === 0) { finished = true; break }

    for (const c of calls) {
      stats.toolCalls += 1
      let out = ''
      let args = {}
      try { args = JSON.parse(c.function?.arguments ?? '{}') } catch { args = {} }
      if (c.function?.name === 'read_file') {
        try { out = readFileIn(dir, String(args.path ?? '')) } catch (e) { out = `读取失败: ${e.message}` }
      } else if (c.function?.name === 'write_file') {
        try {
          const { writeFileSync, mkdirSync } = await import('node:fs')
          const full = join(dir, String(args.path ?? ''))
          mkdirSync(dirname(full), { recursive: true })
          writeFileSync(full, String(args.content ?? ''), 'utf8')
          out = `已写入 ${args.path}（${String(args.content ?? '').length} 字符）`
        } catch (e) { out = `写入失败: ${e.message}` }
      } else if (c.function?.name === 'run_shell') {
        const r2 = runShell(dir, String(args.command ?? ''))
        out = r2.text
      } else {
        out = `未知工具: ${c.function?.name}`
      }
      if (out.length > 8000) out = `${out.slice(0, 8000)}\n…（输出被截断）`
      messages.push({ role: 'tool', tool_call_id: c.id, content: out })
    }
  }

  const checked = task.check(dir)
  const cost = stats.hit * PRICE_HIT + stats.miss * PRICE_MISS
  return { arm, ok: checked.ok, detail: checked.detail, finished, stats, cost }
}

const wanted = ONLY === 'all' ? TASKS : TASKS.filter((t) => ONLY.split(',').includes(t.id))
mkdirSync(WORK, { recursive: true })

const results = []
for (const task of wanted) {
  for (const arm of ARMS) {
    process.stdout.write(`跑 ${task.id} / ${arm} …\r`)
    const r = await runOne(task, arm)
    results.push({ task: task.id, title: task.title, ...r })
    process.stdout.write(`完成 ${task.id} / ${arm}    \n`)
  }
}

const summary = {}
for (const arm of ARMS) {
  const rows = results.filter((r) => r.arm === arm)
  const okCount = rows.filter((r) => r.ok).length
  summary[arm] = {
    success: `${okCount}/${rows.length}`,
    rounds: rows.reduce((a, r) => a + (r.stats?.rounds ?? 0), 0),
    toolCalls: rows.reduce((a, r) => a + (r.stats?.toolCalls ?? 0), 0),
    tokens: rows.reduce((a, r) => a + (r.stats?.hit ?? 0) + (r.stats?.miss ?? 0), 0),
    miss: rows.reduce((a, r) => a + (r.stats?.miss ?? 0), 0),
    cost: rows.reduce((a, r) => a + (r.cost ?? 0), 0),
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ model: MODEL, maxRounds: MAX_ROUNDS, summary, results }, null, 2))
  process.exit(0)
}

console.log('\n=== agentic 基准（多轮工具调用 + 确定性判分）===')
console.log(`模型 ${MODEL} · 任务 ${wanted.length} · 两臂 ${ARMS.join(' / ')} · 轮数上限 ${MAX_ROUNDS}`)
console.log('\n任务明细：')
for (const t of wanted) {
  const a = results.find((r) => r.task === t.id && r.arm === ARMS[0])
  const b = results.find((r) => r.task === t.id && r.arm === ARMS[1])
  const cell = (r) => (r === undefined ? '—' : `${r.ok ? '✅' : '❌'} ${r.stats?.rounds ?? 0}轮/${r.stats?.toolCalls ?? 0}call`)
  console.log(`  ${t.id.padEnd(18)} ${cell(a).padEnd(20)} ${cell(b)}`)
  if (a && !a.ok) console.log(`      ${ARMS[0]} 失败原因: ${String(a.detail).replace(/\n/g, ' ').slice(0, 140)}`)
  if (b && !b.ok) console.log(`      ${ARMS[1]} 失败原因: ${String(b.detail).replace(/\n/g, ' ').slice(0, 140)}`)
}
console.log('\n汇总：')
for (const arm of ARMS) {
  const s = summary[arm]
  console.log(`  ${arm.padEnd(6)} 成功率 ${s.success} · 轮数 ${s.rounds} · 工具调用 ${s.toolCalls}`
    + ` · 输入 ${s.tokens.toLocaleString()}（未命中 ${s.miss.toLocaleString()}）· 成本 $${s.cost.toFixed(4)}`)
}
const a0 = summary[ARMS[0]]
const b0 = summary[ARMS[1]]
if (a0 && b0) {
  console.log(`\n对照：${ARMS[0]} 成本 $${a0.cost.toFixed(4)} → ${ARMS[1]} $${b0.cost.toFixed(4)}`
    + `（${((1 - b0.cost / (a0.cost || 1)) * 100).toFixed(0)}% 变化）`
    + ` · 成功率 ${a0.success} → ${b0.success}`)
}
console.log('\n读法：成功率看质量，成本看省钱。两者一起看才说明问题。')
