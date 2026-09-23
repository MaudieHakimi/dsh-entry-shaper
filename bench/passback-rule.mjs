// 查清 reasoning_content 回传的**确切规则**：到底哪些 assistant 消息必须带它？
//
// 背景：单轮探针（probe-reasoning-passback.mjs）显示"缺 reasoning_content 的工具轮"返回 200，
// 但用**真实多轮历史**跑分歧基准时被拒：
//   "The `reasoning_content` in the thinking mode must be passed back to the API."
// 本探针用可控的多轮历史逐一变体，定位规则边界。
//
// 用法：node bench/passback-rule.mjs [--model=deepseek-flash] [--rounds=3]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const str = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.split('=')[1] : d
}
const MODEL = str('model', 'deepseek-flash')
const ROUNDS = Number(str('rounds', 3))

const cred = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const KEY = cred.match(/DEEPSEEK_API_KEY:\s*(\S+)/)?.[1]
if (!KEY) throw new Error('凭据文件里没有 DEEPSEEK_API_KEY')
const BASE = process.env.DSH_DEEPSEEK_BASE ?? 'https://api.deepseek.com'

const TOOLS = [{
  type: 'function',
  function: {
    name: 'run_shell',
    description: 'Run a shell command.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
}]

/** 造 N 轮"工具往返"，withReasoning 是长度等于 N 的布尔数组。 */
function history(withReasoning) {
  const messages = [
    { role: 'system', content: 'You are a coding agent in a repository. Decide the next action.' },
    { role: 'user', content: 'Find why the tests are failing and fix it.' },
  ]
  withReasoning.forEach((withR, i) => {
    const assistant = {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `call_${i + 1}`,
        type: 'function',
        function: { name: 'run_shell', arguments: JSON.stringify({ command: `step ${i + 1}: pytest -q tests/test_${i + 1}.py` }) },
      }],
    }
    if (withR) assistant.reasoning_content = `Round ${i + 1}: I need to check test file ${i + 1} first, then decide.`
    messages.push(assistant)
    messages.push({ role: 'tool', tool_call_id: `call_${i + 1}`, content: `2 passed, 1 failed: test_${i + 1}.py::test_edge_case` })
  })
  messages.push({ role: 'user', content: 'Continue: what is the next action?' })
  return messages
}

async function call(withReasoning) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, stream: false, messages: history(withReasoning), tools: TOOLS, temperature: 0, max_tokens: 64 }),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
  return {
    status: res.status,
    ok: res.ok,
    error: res.ok ? null : (parsed?.error?.message ?? text).slice(0, 160),
    action: res.ok
      ? (parsed?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name ?? `text:${(parsed?.choices?.[0]?.message?.content ?? '').slice(0, 40)}`)
      : null,
  }
}

const N = ROUNDS
const cases = [
  ['① 全部轮都带 reasoning（对照）', Array(N).fill(true)],
  ['② 全部轮都不带', Array(N).fill(false)],
  ['③ 只有最后一轮带', Array.from({ length: N }, (_, i) => i === N - 1)],
  ['④ 只有第一轮带', Array.from({ length: N }, (_, i) => i === 0)],
  ['⑤ 除最后一轮外都带', Array.from({ length: N }, (_, i) => i !== N - 1)],
  ['⑥ 中间轮不带（首尾带）', Array.from({ length: N }, (_, i) => i === 0 || i === N - 1)],
]

console.log(`模型 ${MODEL} · 轮数 ${N} · 端点 ${BASE}/chat/completions\n`)
const rows = []
for (const [label, flags] of cases) {
  const r = await call(flags)
  rows.push({ label, flags, ...r })
  const state = r.ok ? `200 OK · 下一步=${r.action}` : `${r.status} ✗ ${r.error}`
  console.log(`${label}\n  带 reasoning 的轮: [${flags.map((f) => (f ? '有' : '无')).join(', ')}]\n  → ${state}\n`)
}

const okAll = rows[0]?.ok
console.log('=== 判定 ===')
console.log(`对照（全带）${okAll ? '通过 ✓' : '竟然失败 ✗'}；全不带 ${rows[1]?.ok ? '通过' : '被拒'}。`)
const partial = rows.slice(2).filter((r) => r.ok)
if (partial.length > 0) {
  console.log(`可接受的"部分带"变体：${partial.map((r) => r.label).join('、')}`)
  console.log('⇒ 结论：并非"必须每轮都带"；上面的变体给出了可以省掉推理的范围。')
} else {
  console.log('⇒ 结论：在 thinking 模式下，只要有工具往返，每个带 tool_calls 的 assistant 消息都必须回传 reasoning_content。')
  console.log('   ⇒ 只摘"当前轮最近一条之外"的推理也可能不被接受；可省空间需要另找（见报告）。')
}
