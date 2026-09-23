// 定位真正的触发条件，并验证"桩化推理"能否救回方案。
//
// 已知：
//   * 空正文 + tool_calls + 无 reasoning ⇒ 200（单轮探针、合成多轮都通过）
//   * 真实多轮历史（带正文）⇒ 400 "The `reasoning_content` in the thinking mode must be passed back to the API."
// 假设：触发条件是"assistant 消息带**可见正文**（has spoken）"。
// 救命的替代：API 大概只要求字段**存在**，不要求内容完整 ⇒ 把 reasoning 换成短桩即可。
//
// 用法：node bench/passback-stub.mjs [--model=deepseek-flash]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const str = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.split('=')[1] : d
}
const MODEL = str('model', 'deepseek-flash')
const cred = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const KEY = cred.match(/DEEPSEEK_API_KEY:\s*(\S+)/)?.[1]
if (!KEY) throw new Error('凭据缺失')
const BASE = process.env.DSH_DEEPSEEK_BASE ?? 'https://api.deepseek.com'

const TOOLS = [{
  type: 'function',
  function: {
    name: 'run_shell',
    description: 'Run a shell command.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
}]

const REASONING = 'I should inspect the failing test first, then look at the implementation of the parser to see why the edge case fails.'

/**
 * @param opts.text 是否给 assistant 消息加可见正文
 * @param opts.reasoning 'full' | 'stub' | 'none'
 * @param opts.calls 是否带 tool_calls
 */
function history({ text, reasoning, calls, trailingUser = true }) {
  const assistant = { role: 'assistant', content: text ? 'Let me inspect the failing test first.' : '' }
  if (calls) {
    assistant.tool_calls = [{
      id: 'call_1',
      type: 'function',
      function: { name: 'run_shell', arguments: '{"command":"pytest -q tests/test_parser.py"}' },
    }]
  }
  if (reasoning === 'full') assistant.reasoning_content = REASONING
  if (reasoning === 'stub') assistant.reasoning_content = '[reasoning omitted: 118 chars]'

  const messages = [
    { role: 'system', content: 'You are a coding agent in a repository. Decide the next action.' },
    { role: 'user', content: 'Fix the failing parser test.' },
    assistant,
  ]
  if (calls) messages.push({ role: 'tool', tool_call_id: 'call_1', content: '1 failed: test_parser.py::test_edge_case' })
  // 关键开关：是否在末尾追加用户消息。不追加 = 报文以 tool 结果结尾 = 正在延续工具回路。
  if (trailingUser) messages.push({ role: 'user', content: 'Continue: what is the next action?' })
  return messages
}

async function call(opts) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, stream: false, messages: history(opts), tools: TOOLS, temperature: 0, max_tokens: 64 }),
  })
  const body = await res.text()
  let parsed = null
  try { parsed = JSON.parse(body) } catch { /* 非 JSON */ }
  return {
    status: res.status,
    ok: res.ok,
    error: res.ok ? null : (parsed?.error?.message ?? body).slice(0, 150),
    action: res.ok
      ? (parsed?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name ?? 'text')
      : null,
  }
}

const cases = [
  ['A 空正文 + 工具调用 + 无 reasoning（末尾有用户消息）', { text: false, reasoning: 'none', calls: true }],
  ['B 有正文 + 工具调用 + 无 reasoning（末尾有用户消息）', { text: true, reasoning: 'none', calls: true }],
  ['C 有正文 + 工具调用 + 桩化 reasoning', { text: true, reasoning: 'stub', calls: true }],
  ['D 有正文 + 工具调用 + 完整 reasoning（对照）', { text: true, reasoning: 'full', calls: true }],
  ['H 工具调用 + 无 reasoning + **无末尾用户消息**（延续工具回路）', { text: false, reasoning: 'none', calls: true, trailingUser: false }],
  ['I 工具调用 + **桩化** reasoning + 无末尾用户消息 ← 真正要证的', { text: false, reasoning: 'stub', calls: true, trailingUser: false }],
  ['J 工具调用 + 完整 reasoning + 无末尾用户消息（对照）', { text: false, reasoning: 'full', calls: true, trailingUser: false }],
  ['K 有正文 + 工具调用 + 无 reasoning + 无末尾用户消息', { text: true, reasoning: 'none', calls: true, trailingUser: false }],
]

console.log(`模型 ${MODEL} · 端点 ${BASE}/chat/completions\n`)
const rows = []
for (const [label, opts] of cases) {
  const r = await call(opts)
  rows.push({ label, opts, ...r })
  console.log(`${label}\n  → ${r.ok ? `200 OK · 动作=${r.action}` : `${r.status} ✗ ${r.error}`}\n`)
}

const h = rows.find((r) => r.label.startsWith('H'))
const i = rows.find((r) => r.label.startsWith('I'))
const j = rows.find((r) => r.label.startsWith('J'))
const a = rows.find((r) => r.label.startsWith('A'))
console.log('=== 判定 ===')
console.log(`A（末尾有用户消息、无 reasoning）: ${a.ok ? '200 ✓' : `${a.status} ✗`}`)
console.log(`H（以 tool 结果结尾 = 延续工具回路、无 reasoning）: ${h.ok ? '200（规则不在这儿）' : `${h.status} ✗ ${h.error}`}`)
console.log(`J（同样结尾、完整 reasoning，对照）: ${j.ok ? '200 ✓' : `${j.status} ✗`}`)
console.log(`I（同样结尾、**桩化** reasoning）: ${i.ok ? '✅ 200 —— 字段在即可，内容可桩化 ⇒ 方案可救' : `❌ ${i.status} ${i.error}`}`)
