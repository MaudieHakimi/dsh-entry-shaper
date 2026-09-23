// 自测：入口塑造的核心行为（不依赖 DSH 运行时，用假 ctx/session 驱动）。
//
// 运行：node test/run-all.mjs      （本机沙箱下 `node --test` 会挂，故用同进程聚合器）
//      CI 里：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, applyOps, createOpCache, extractReasoning } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, '.tmp')
mkdirSync(TMP, { recursive: true })

/** 每个用例独立的日志路径，避免互相干扰、也不写用户主目录。 */
let caseNo = 0
function setup(config = {}) {
  caseNo += 1
  const logPath = join(TMP, `case-${caseNo}.log`)
  const sentinel = join(TMP, `case-${caseNo}.OFF`)
  rmSync(logPath, { force: true })
  rmSync(sentinel, { force: true })

  const handlers = []
  const appends = []
  const ctx = {
    on(eventName, handler, opts) {
      handlers.push({ eventName, handler, opts })
      return () => {}
    },
  }
  const session = {
    append(...args) {
      appends.push(args)
    },
  }
  // 说明：assistant/message 的"表面替换"路径在真实 harness 上被证明**不可用**
  // （session 端与 token-meter 端的 provenance 要求互相矛盾），因此默认关闭。
  // 这里默认打开它，是为了继续覆盖那段代码；真实生效的路径是 llm/stream 中间件。
  apply(ctx, { logPath, offSentinel: sentinel, surfaceAssistant: true, ...config })
  return { handlers, appends, session, logPath, sentinel, ctx }
}

/** 只订阅 llm/stream 的装配（用于流过滤测试）。 */
function setupStream(config = {}) {
  caseNo += 1
  const logPath = join(TMP, `stream-${caseNo}.log`)
  const sentinel = join(TMP, `stream-${caseNo}.OFF`)
  rmSync(logPath, { force: true })
  rmSync(sentinel, { force: true })
  const listeners = []
  const ctx = { on: (name, handler) => { listeners.push({ name, handler }); return () => {} } }
  apply(ctx, { logPath, offSentinel: sentinel, ...config })
  return {
    streamListener: listeners.find((l) => l.name === 'llm/stream')?.handler,
    listeners,
    logPath,
  }
}

/** 用一组 chunk 驱动流中间件并收集输出。 */
async function runStream(streamListener, chunks, options = {}) {
  const source = (async function* () { for (const c of chunks) yield c })()
  const wrapped = streamListener(options, () => source)
  const out = []
  for await (const chunk of wrapped) out.push(chunk)
  return out
}

/** 等 microtask 落地（插件在 queueMicrotask 里追加）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeEvent(over = {}) {
  // 注意：reasoning 必须"够长且有可抽的决策句"，否则 extract 抽出来等于原文 ⇒
  // 插件按设计**不做任何替换**（避免无谓的事件）。所以这里用贴近真实的形态。
  const content = over.content ?? [
    { type: 'reasoning', text: `${'Exploring options and weighing tradeoffs. '.repeat(12)}I will patch a.txt now.` },
    { type: 'text', text: 'answer' },
    { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
  ]
  return {
    type: 'assistant/message',
    seq: 570,
    surfaceOp: 'append',
    sourceEventSeqs: [17, 18, 19, 20],
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 393, cacheReadTokens: 0, outputTokens: 580, reasoningTokens: 129 },
      message: { role: 'assistant', content },
    },
    ...over,
  }
}

const emit = (handlers, session, event) => {
  for (const { eventName, handler } of handlers) {
    if (eventName === 'session/event') handler(session, event)
  }
}

test('订阅：注册 session/event（global）与 llm/stream 两个入口', () => {
  const { handlers } = setup()
  const names = handlers.map((h) => h.eventName).sort()
  assert.deepEqual(names, ['llm/stream', 'session/event'], '两个入口：表面事件 + 流中间件')
  const sessionEvent = handlers.find((h) => h.eventName === 'session/event')
  assert.deepEqual(sessionEvent.opts, { global: true })
})

test('决策抽取（默认）：reasoning 换成"抽取 + 省略计数"，text/tool-call 原样', async () => {
  const { handlers, appends, session } = setup()
  emit(handlers, session, makeEvent())
  await settle()

  assert.equal(appends.length, 1, '应恰好追加一次')
  const [type, data, opts] = appends[0]
  assert.equal(type, 'assistant/message', '替换事件必须是同类表面事件')
  assert.equal(opts.surfaceOp.op, 'replace')
  assert.equal(opts.surfaceOp.start, 570)
  assert.equal(opts.surfaceOp.end, 570)
  assert.deepEqual(opts.sourceEventSeqs, [17, 18, 19, 20], 'provenance 必须原样沿用')
  assert.deepEqual(data.message.content.map((b) => b.type), ['reasoning', 'text', 'tool-call'])
  assert.ok(data.message.content[0].text.startsWith('[reasoning extract:'), '默认走决策抽取')
  assert.equal(data.message.content[2].arguments, '{"path":"a.txt"}', 'tool-call 原样保留')
})

test('多个 reasoning 块：逐块处理，不再折叠成一个', async () => {
  const { handlers, appends, session } = setup({ reasoningMode: 'stub' })
  emit(handlers, session, makeEvent({
    content: undefined,
    data: { message: { content: [
      { type: 'reasoning', text: 'A'.repeat(3000) },
      { type: 'reasoning', text: 'B'.repeat(500) },
      { type: 'text', text: 'answer' },
    ] } },
  }))
  await settle()
  const content = appends[0][1].message.content
  assert.deepEqual(content.map((b) => b.type), ['reasoning', 'reasoning', 'text'])
  assert.equal(content[0].text, '[reasoning omitted: 3000 chars]', '每块按自己的长度出桩')
  assert.equal(content[1].text, '[reasoning omitted: 500 chars]')
})

test('reasoning 永远不会被整块删除（缺字段会被 API 400）⇒ drop 退回桩', async () => {
  const { handlers, appends, session } = setup({ reasoningMode: 'drop' })
  emit(handlers, session, makeEvent())
  await settle()
  const content = appends[0][1].message.content
  assert.ok(content.some((b) => b.type === 'reasoning'), 'reasoning 字段必须还在')
  assert.ok(content.find((b) => b.type === 'reasoning').text.startsWith('[reasoning omitted:'))
  assert.deepEqual(content.map((b) => b.type), ['reasoning', 'text', 'tool-call'])
})

test('纯 reasoning 消息：同样保留桩块（不触发空内容兜底）', async () => {
  const { handlers, appends, session } = setup({ reasoningMode: 'stub' })
  emit(handlers, session, makeEvent({
    content: undefined,
    data: { message: { content: [{ type: 'reasoning', text: 'only thinking' }] } },
  }))
  await settle()
  assert.deepEqual(appends[0][1].message.content.map((b) => b.type), ['reasoning'])
  assert.equal(appends[0][1].message.content[0].text, '[reasoning omitted: 13 chars]')
})

test('可自定义桩模板（stub 模式）', async () => {
  const { handlers, appends, session } = setup({ reasoningMode: 'stub', stubTemplate: '<omitted {chars}>' })
  emit(handlers, session, makeEvent())
  await settle()
  assert.match(appends[0][1].message.content[0].text, /^<omitted \d+>$/)
})

// ── 决策抽取（extract 模式）──

test('抽取：只留决策句，按句式挑而不是按位置切', () => {
  const text = 'The build failed. I should look at the log first. Then I will patch transform.js. '
    + 'There are many other possibilities worth exploring in detail. Next I will rerun the tests.'
  const out = extractReasoning(text, 200)
  assert.ok(out.includes('I should look at the log first'), '应保留决策句')
  assert.ok(out.includes('Then I will patch transform.js'))
  assert.ok(!out.includes('many other possibilities'), '应丢掉非决策的探索句')
})

test('抽取：中文决策句', () => {
  const out = extractReasoning('嗯，这个文件有点怪。接下来我要改 parse.js，然后跑测试。', 200)
  assert.ok(out.includes('接下来我要改 parse.js'), '应认出中文决策句')
})

test('抽取：没有决策句时退回最后一句', () => {
  const out = extractReasoning('Exploring many hypotheses. Nothing conclusive yet but the last line matters.', 200)
  assert.equal(out, 'Nothing conclusive yet but the last line matters.')
})

test('抽取：遵守字符预算', () => {
  const text = 'I will do thing number one. I will do thing number two. I will do thing number three.'
  const out = extractReasoning(text, 40)
  assert.ok(out.length <= 40, `预算内，实得 ${out.length}`)
})

test('抽取：空输入返回空串', () => {
  assert.equal(extractReasoning('', 100), '')
  assert.equal(extractReasoning(undefined, 100), '')
})

test('extract 模式：reasoning 换成"抽取 + 省略计数"，字段仍在', async () => {
  const { handlers, appends, session } = setup({ reasoningMode: 'extract', extractMaxChars: 60 })
  emit(handlers, session, makeEvent({
    content: undefined,
    data: { message: { content: [
      { type: 'reasoning', text: `${'x'.repeat(500)} I will patch the parser now.` },
      { type: 'text', text: 'answer' },
      { type: 'tool-call', id: 'c1', name: 'run_shell', arguments: '{}' },
    ] } },
  }))
  await settle()
  const reasoning = appends[0][1].message.content.find((b) => b.type === 'reasoning')
  assert.ok(reasoning, '字段必须仍在（缺字段会被 API 400）')
  assert.ok(reasoning.text.startsWith('[reasoning extract:'), '带省略计数前缀')
  assert.ok(reasoning.text.includes('I will patch the parser now'), '含抽取到的决策句')
  assert.deepEqual(appends[0][1].message.content.map((b) => b.type), ['reasoning', 'text', 'tool-call'])
})

test('不复制 usage（否则 token-meter 会把同一步计两次）', async () => {
  const { handlers, appends, session } = setup()
  emit(handlers, session, makeEvent())
  await settle()
  assert.equal(appends[0][1].usage, undefined)
  assert.equal(appends[0][1].turn, 1, '其余 data 字段保留')
  assert.equal(appends[0][1].step, 1)
})

test('可配置：dropUsageOnReplace=false 时保留 usage', async () => {
  const { handlers, appends, session } = setup({ dropUsageOnReplace: false })
  emit(handlers, session, makeEvent())
  await settle()
  assert.equal(appends[0][1].usage.inputTokens, 393)
})

test('自激保护：带 replace 语义的事件被跳过', async () => {
  const { handlers, appends, session } = setup()
  emit(handlers, session, makeEvent({ surfaceOp: { op: 'replace', start: 570, end: 570 } }))
  await settle()
  assert.equal(appends.length, 0)
})

test('无 reasoning 的消息被跳过', async () => {
  const { handlers, appends, session } = setup()
  emit(handlers, session, makeEvent({ content: undefined, data: { message: { content: [{ type: 'text', text: 'hi' }] } } }))
  await settle()
  assert.equal(appends.length, 0)
})

// ── 处理层：op 组合 ──

test('链式 op：extract → truncate 依次生效', async () => {
  const text = `${'Exploring many options. '.repeat(20)}I will patch parse.js now.`
  const out = await applyOps(text, [{ op: 'extract', maxChars: 500 }, { op: 'truncate', maxChars: 60 }])
  assert.ok(out.length <= 90, `链后应被截断（实得 ${out.length}）`)
  assert.ok(out.includes('省略'), 'truncate 留下省略标记')
})

// ── 异步 op：LLM 调用 / Python 接口（都用注入的 mock，不真的出网或起进程）──

test('summarize op：OpenAI 兼容请求 + 显式提示词（mock fetch）', async () => {
  let seen = null
  const fetchMock = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '要点三行' } }] }) }
  }
  const out = await applyOps('很长很长的一段工具输出', [{ op: 'summarize', model: 'm', maxTokens: 64, prompt: '压成三点' }], {
    fetch: fetchMock, llm: { baseURL: 'https://api.example.com/', apiKey: 'sk-test' },
  })
  assert.equal(out, '要点三行')
  assert.equal(seen.url, 'https://api.example.com/chat/completions', '应走 OpenAI 兼容路径且去掉尾斜杠')
  assert.equal(seen.body.model, 'm')
  assert.equal(seen.body.temperature, 0)
  assert.equal(seen.body.messages[0].content, '压成三点', '显式提示词')
  assert.equal(seen.auth, 'Bearer sk-test')
})

test('summarize op：出网前过 redact（mock fetch）', async () => {
  let sent = null
  const fetchMock = async (_url, init) => {
    sent = JSON.parse(init.body).messages[1].content
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
  }
  await applyOps('token=sk-abcdefghijklmnop', [{ op: 'summarize' }], {
    fetch: fetchMock, llm: { apiKey: 'k' }, redact: (t) => t.replace(/sk-[a-z]+/u, '[REDACTED]'),
  })
  assert.ok(!sent.includes('sk-abcdefghijklmnop'), '出网文本应已脱敏')
})

test('summarize op：HTTP 失败 ⇒ 该 op 跳过（保留上一步结果，fail-open）', async () => {
  const fetchMock = async () => ({ ok: false, status: 500, json: async () => ({}) })
  const out = await applyOps('原文', [{ op: 'stub' }, { op: 'summarize' }], { fetch: fetchMock, llm: { apiKey: 'k' } })
  assert.equal(out, '[reasoning omitted: 2 chars]', 'LLM 失败后应保留 stub 的结果')
})

test('op 超时护栏：慢 op 被跳过', async () => {
  const slowOp = { op: 'summarize', timeoutMs: 30 }
  const fetchMock = () => new Promise(() => {}) // 永不返回
  const out = await applyOps('原文', [{ op: 'stub' }, slowOp], { fetch: fetchMock, llm: { apiKey: 'k' } })
  assert.equal(out, '[reasoning omitted: 2 chars]', '超时后应保留上一步结果')
})

test('python op：JSON 协议（mock spawn）', async () => {
  const makeChild = (stdout, code = 0) => ({
    stdout: { on: (e, f) => { if (e === 'data') setTimeout(() => f(stdout), 0) } },
    stderr: { on: () => {} },
    stdin: { end: () => {} },
    on: (event, fn) => { if (event === 'close') setTimeout(() => fn(code), 5) },
    kill: () => {},
  })
  const spawnMock = () => makeChild('{"text":"py 处理结果"}\n')
  const out = await applyOps('原始文本', [{ op: 'python', script: 'shaper.py' }], { spawn: spawnMock })
  assert.equal(out, 'py 处理结果')
})

test('python op：纯文本协议与退出码非 0', async () => {
  const makeChild = (stdout, code) => ({
    stdout: { on: (e, f) => { if (e === 'data') setTimeout(() => f(stdout), 0) } },
    stderr: { on: (e, f) => { if (e === 'data') setTimeout(() => f('boom'), 0) } },
    stdin: { end: () => {} },
    on: (event, fn) => { if (event === 'close') setTimeout(() => fn(code), 5) },
    kill: () => {},
  })
  const okText = await applyOps('x', [{ op: 'python', script: 's.py', protocol: 'text' }], { spawn: () => makeChild('纯文本结果', 0) })
  assert.equal(okText, '纯文本结果')
  const failed = await applyOps('x', [{ op: 'stub' }, { op: 'python', script: 's.py' }], { spawn: () => makeChild('', 2) })
  assert.equal(failed, '[reasoning omitted: 1 chars]', '子进程失败应跳过该 op')
})

test('未知 op 被跳过（fail-open）', async () => {
  assert.equal(await applyOps('hello', [{ op: 'no-such-op' }, { op: 'stub' }]), '[reasoning omitted: 5 chars]')
  assert.equal(await applyOps('hello', [{ op: 'drop' }]), null)
})

test('op 组合：policy.reasoning 用链式序列', async () => {
  const { handlers, appends, session } = setup({
    policy: { reasoning: { ops: [{ op: 'extract', maxChars: 900 }, { op: 'truncate', maxChars: 80 }] } },
  })
  // 决策句本身要够长，truncate 才会留下省略标记
  emit(handlers, session, makeEvent({
    content: undefined,
    data: { message: { content: [
      { type: 'reasoning', text: `${'I will patch parse.js carefully. '.repeat(10)}` },
      { type: 'text', text: 'answer' },
    ] } },
  }))
  await settle()
  const text = appends[0][1].message.content.find((b) => b.type === 'reasoning').text
  assert.ok(text.includes('省略'), `链式 op 应生效，实得 ${JSON.stringify(text.slice(0, 60))}`)
})

test('op 组合：tool 结果的 truncate（首尾桩）', async () => {
  const { handlers, appends, session } = setup({
    policy: { toolResult: { ops: [{ op: 'truncate', maxChars: 60 }] } },
  })
  emit(handlers, session, {
    type: 'tool/result',
    seq: 900,
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'X'.repeat(300) }] }] } },
  })
  await settle()
  assert.equal(appends.length, 1)
  const [type, , opts] = appends[0]
  assert.equal(type, 'tool/result', '替换事件必须同类')
  assert.equal(opts.surfaceOp.op, 'replace')
  assert.deepEqual(opts.sourceEventSeqs, [900], 'tool/result 的 provenance 沿用自身')
  assert.ok(appends[0][1].message.content[0].content[0].text.includes('省略'))
})

test('op 组合：全 keep 时不产生任何事件（不做无谓替换）', async () => {
  const { handlers, appends, session } = setup({
    policy: { reasoning: { ops: [{ op: 'keep' }] }, toolResult: { ops: [{ op: 'keep' }] } },
  })
  emit(handlers, session, makeEvent())
  emit(handlers, session, {
    type: 'tool/result', seq: 900, surfaceOp: 'append',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'X'.repeat(300) }] }] } },
  })
  await settle()
  assert.equal(appends.length, 0)
})

// ── 推理的真实通道：llm/stream 中间件（表面替换那条路已知不可用）──

test('流过滤：推理 chunk 被攒起、只吐出一个经 op 处理的 chunk', async () => {
  const { streamListener } = setupStream()
  const out = await runStream(streamListener, [
    { type: 'reasoning', text: 'Exploring ' },
    { type: 'reasoning', text: 'many options. ' },
    { type: 'reasoning', text: 'I will patch a.txt now.' },
    { type: 'text', text: 'answer' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(out.length, 3, '还原成 3 个 chunk：reasoning + text + finish')
  assert.equal(out[0].type, 'reasoning', '推理字段必须仍在（否则工具回路会 400）')
  assert.ok(out[0].text.startsWith('[reasoning extract:'), '默认走 extract')
  assert.equal(out[1].type, 'text')
  assert.equal(out[2].type, 'finish')
})

test('流过滤：stub 模式把推理换成短桩', async () => {
  const { streamListener } = setupStream({ policy: { reasoning: { ops: [{ op: 'stub' }] } } })
  const out = await runStream(streamListener, [
    { type: 'reasoning', text: 'x'.repeat(300) },
    { type: 'text', text: 'done' },
  ])
  assert.equal(out[0].text, '[reasoning omitted: 300 chars]')
  assert.equal(out[1].text, 'done')
})

test('流过滤：只在末尾有推理时也能吐出（流结束时 flush）', async () => {
  const { streamListener } = setupStream({ policy: { reasoning: { ops: [{ op: 'stub' }] } } })
  const out = await runStream(streamListener, [
    { type: 'text', text: 'hi' },
    { type: 'reasoning', text: 'y'.repeat(50) },
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].type, 'text')
  assert.equal(out[1].type, 'reasoning')
  assert.equal(out[1].text, '[reasoning omitted: 50 chars]')
})

test('流过滤：无推理时不改变任何 chunk', async () => {
  const { streamListener } = setupStream()
  const chunks = [{ type: 'text', text: 'a' }, { type: 'finish', reason: { kind: 'stop' } }]
  const out = await runStream(streamListener, chunks)
  assert.deepEqual(out, chunks)
})

test('流过滤：enabled=false 时原样透传', async () => {
  const { streamListener } = setupStream({ enabled: false })
  const chunks = [{ type: 'reasoning', text: 'zzz' }, { type: 'text', text: 'a' }]
  const out = await runStream(streamListener, chunks)
  assert.deepEqual(out, chunks)
})

test('默认不尝试 assistant/message 的表面替换（已知校验器冲突）', async () => {
  const { handlers, appends, session } = setup({ surfaceAssistant: false })
  emit(handlers, session, makeEvent())
  await settle()
  assert.equal(appends.length, 0, '表面替换默认关闭')
})

// ── 非纯 op 的结果缓存（保证多次出网结果逐字节一致 ⇒ 前缀稳定）──

test('缓存：LLM op 同一输入只算一次', async () => {
  caseNo += 1
  const cachePath = join(TMP, `cache-${caseNo}.jsonl`)
  rmSync(cachePath, { force: true })
  let calls = 0
  const fetchMock = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `摘要${calls}` } }] }) }
  }
  const cache = createOpCache({ cache: { path: cachePath, enabled: true } }, () => {})
  const ctx = { fetch: fetchMock, llm: { apiKey: 'k' }, cache }
  const ops = [{ op: 'summarize' }]

  const first = await applyOps('同一段工具输出', ops, ctx)
  const second = await applyOps('同一段工具输出', ops, ctx)
  assert.equal(first, second, '两次结果必须逐字节相同')
  assert.equal(calls, 1, 'LLM 只应被调用一次（第二次命中缓存）')
})

test('缓存：重启后仍命中（新实例读同一个文件）', async () => {
  caseNo += 1
  const cachePath = join(TMP, `cache-${caseNo}.jsonl`)
  rmSync(cachePath, { force: true })
  let calls = 0
  const fetchMock = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '重启前的摘要' } }] }) }
  }
  const ops = [{ op: 'summarize', prompt: '压成要点' }]

  const before = await applyOps('某段很长很长的内容', ops, {
    fetch: fetchMock, llm: { apiKey: 'k' }, cache: createOpCache({ cache: { path: cachePath, enabled: true } }, () => {}),
  })
  // 模拟重启：全新实例、同一个缓存文件
  const after = await applyOps('某段很长很长的内容', ops, {
    fetch: fetchMock, llm: { apiKey: 'k' }, cache: createOpCache({ cache: { path: cachePath, enabled: true } }, () => {}),
  })
  assert.equal(after, before, '重启后必须拿到同一份摘要（否则前缀会被打断）')
  assert.equal(calls, 1, '重启后不应再次调用 LLM')
})

test('缓存：配置变了（prompt/model）自动失效', async () => {
  caseNo += 1
  const cachePath = join(TMP, `cache-${caseNo}.jsonl`)
  rmSync(cachePath, { force: true })
  let calls = 0
  const fetchMock = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `v${calls}` } }] }) }
  }
  const cache = createOpCache({ cache: { path: cachePath, enabled: true } }, () => {})
  const ctx = { fetch: fetchMock, llm: { apiKey: 'k', model: 'm1' }, cache }
  await applyOps('同样的输入', [{ op: 'summarize', prompt: '提示词 A' }], ctx)
  await applyOps('同样的输入', [{ op: 'summarize', prompt: '提示词 B' }], ctx)
  await applyOps('同样的输入', [{ op: 'summarize', prompt: '提示词 A' }], { ...ctx, llm: { apiKey: 'k', model: 'm2' } })
  assert.equal(calls, 3, '提示词/模型不同 ⇒ 各算一次')
  const again = await applyOps('同样的输入', [{ op: 'summarize', prompt: '提示词 A' }], ctx)
  assert.equal(again, 'v1', '同配置再跑应命中最早的缓存')
  assert.equal(calls, 3)
})

test('缓存：纯 op 不进缓存（不产生缓存文件）', async () => {
  caseNo += 1
  const cachePath = join(TMP, `cache-${caseNo}.jsonl`)
  rmSync(cachePath, { force: true })
  const cache = createOpCache({ cache: { path: cachePath, enabled: true } }, () => {})
  await applyOps('hello world', [{ op: 'stub' }], { cache })
  assert.equal(existsSync(cachePath), false, '纯 op 不该产生缓存文件')
})

test('缓存：关闭后每次都调用', async () => {
  caseNo += 1
  let calls = 0
  const fetchMock = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }
  }
  const cache = createOpCache({ cache: { enabled: false, path: join(TMP, 'unused.jsonl') } }, () => {})
  const ctx = { fetch: fetchMock, llm: { apiKey: 'k' }, cache }
  await applyOps('同一段内容', [{ op: 'summarize' }], ctx)
  await applyOps('同一段内容', [{ op: 'summarize' }], ctx)
  assert.equal(calls, 2, '关闭缓存 ⇒ 每次都真调用')
})

test('缓存：坏行被忽略，不影响会话', async () => {
  caseNo += 1
  const cachePath = join(TMP, `cache-${caseNo}.jsonl`)
  rmSync(cachePath, { force: true })
  writeFileSync(cachePath, 'not json at all\n{"k":"abc"}\n', 'utf8')
  const cache = createOpCache({ cache: { path: cachePath, enabled: true } }, () => {})
  assert.equal(cache.get('abc'), undefined, '坏行/不完整记录直接忽略')
})

test('非 assistant/message 事件被跳过', async () => {
  const { handlers, appends, session } = setup()
  emit(handlers, session, makeEvent({ type: 'tool/result' }))
  await settle()
  assert.equal(appends.length, 0)
})

test('开关：enabled=false / dropReasoning=false 时不动作', async () => {
  for (const config of [{ enabled: false }, { dropReasoning: false }]) {
    const { handlers, appends, session } = setup(config)
    emit(handlers, session, makeEvent())
    await settle()
    assert.equal(appends.length, 0, JSON.stringify(config))
  }
})

test('免重启熔断：哨兵文件存在时不动作', async () => {
  const { handlers, appends, session, sentinel } = setup()
  writeFileSync(sentinel, '', 'utf8')
  emit(handlers, session, makeEvent())
  await settle()
  assert.equal(appends.length, 0)
})

test('fail-open：session.append 抛错时处理器不抛（表面保持原样）', async () => {
  const { handlers, session } = setup()
  session.append = () => {
    throw new Error('surface contract violated')
  }
  assert.doesNotThrow(() => emit(handlers, session, makeEvent()))
  await settle()
})

test('provenance 缺失时兜底为 [seq]，不抛错', async () => {
  const { handlers, appends, session } = setup()
  emit(handlers, session, makeEvent({ sourceEventSeqs: undefined }))
  await settle()
  assert.deepEqual(appends[0][2].sourceEventSeqs, [570])
})

test('无 seq 的事件被跳过（不是日志事件）', async () => {
  const { handlers, appends, session } = setup()
  emit(handlers, session, makeEvent({ seq: undefined }))
  await settle()
  assert.equal(appends.length, 0)
})
