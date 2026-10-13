// 自测：入口塑造的核心行为（不依赖 DSH 运行时，用假 ctx/session 驱动）。
//
// 运行：node test/run-all.mjs      （本机沙箱下 `node --test` 会挂，故用同进程聚合器）
//      CI 里：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, applyOps, createOpCache, createProxyAdapter, extractReasoning, mergeCfg, shapeMessages } from '../index.js'

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
  // configPath 必须隔离：apply() 默认会去读真实主目录的 ~/.dsh-entry-shaper.config.json，
  // 那会让本机实际配置污染整套测试（热挂载实验期间会整体变红）。指向一个不存在的文件
  // ⇒ refreshCfg 沿用 patch 传入的 config，测试才只测被显式传进来的东西。
  const configPath = join(TMP, `cfg-${caseNo}.json`)
  rmSync(configPath, { force: true })
  // cache.path 也要隔离：DEFAULTS 指向**真实主目录**的 ~/.dsh-entry-shaper.cache.jsonl，
  // 不隔离会让用例互相污染、并受本机真实缓存影响（实测踩到）。
  apply(ctx, {
    logPath, offSentinel: sentinel, configPath, surfaceAssistant: true,
    cache: { enabled: true, path: join(TMP, `cache-${caseNo}.jsonl`) },
    ...config,
  })
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
  // 同上：隔离 configPath，避免读到主目录里的真实热配置
  const configPath = join(TMP, `stream-cfg-${caseNo}.json`)
  rmSync(configPath, { force: true })
  apply(ctx, {
    logPath, offSentinel: sentinel, configPath,
    cache: { enabled: true, path: join(TMP, `stream-cache-${caseNo}.jsonl`) },
    ...config,
  })
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
  // 默认形态**不带**任何前缀（前缀会污染模型，见 docs/POLLUTION.md）：
  // 断言"被塑形"要认特征（抽到的决策句 + 变短），不能认前缀。
  assert.ok(data.message.content[0].text.includes('I will patch a.txt now'), '默认走决策抽取（留下决策句）')
  assert.ok(!data.message.content[0].text.includes('chars omitted'), '默认不带 omitted 前缀（避免污染模型）')
  assert.ok(data.message.content[0].text.length < 200, '塑形后确实变短')
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

// 回归：曾经的 extract 无条件加 `[reasoning extract: N chars omitted] ` 前缀（约 37~39 字符），
// 于是**任何短于约 279 字符的输入都被撑大**（实测 10/20/…/258 全部 +37）。
// 撑大是净亏：更多出网字符，还可能触发断点税。判据必须是"最终是否比原文短"。
//
// 现在默认已**完全不带**前缀（前缀会污染模型，见 docs/POLLUTION.md），
// 所以"撑大"从根本上消失；本用例改为守住"绝不比原文长"这个不变量。
test('抽取：绝不比原文长（短块原样返回）', async () => {
  const { OPS } = await import('../index.js')
  const short = 'I will patch a.txt now.'
  assert.equal(OPS.extract(short, { op: 'extract', maxChars: 240 }), short,
    '短块必须原样返回（不该被改写）')
  // 全长度区间都不该变长
  for (const n of [1, 5, 40, 120, 240, 258, 278, 279, 400, 2000]) {
    const text = 'x'.repeat(n)
    const out = OPS.extract(text, { op: 'extract', maxChars: 240 })
    assert.ok(out.length <= text.length, `${n} 字符的块不该变长（实际 ${out.length}）`)
  }
  // 反向：够长的块仍必须真的变短（否则是"修过头"，塑形等于没做）
  const long = `${'Exploring options. '.repeat(40)}I will patch a.txt now.`
  const shaped = OPS.extract(long, { op: 'extract', maxChars: 240 })
  assert.ok(shaped.length < long.length, '长块必须真的更短')
  assert.ok(shaped.includes('I will patch a.txt now'), '决策句必须留下')
  // 默认绝不引入任何"记账格式"字串 —— 它是污染源
  assert.ok(!shaped.includes('chars omitted'), '默认不得带省略计数（会污染模型）')
  assert.ok(!shaped.includes('reasoning extract'), '默认不得带 extract 标记（会污染模型）')
})

// 显式打开 marker 才带前缀（保留给"确实需要人类审计省略量"的场景，使用者自担污染风险）
test('抽取：marker:true 才带省略计数前缀（非默认）', async () => {
  const { OPS } = await import('../index.js')
  const long = `${'Exploring options. '.repeat(40)}I will patch a.txt now.`
  const marked = OPS.extract(long, { op: 'extract', maxChars: 240, marker: true })
  assert.ok(marked.startsWith('[reasoning extract:'), '显式要求时才带前缀')
  assert.ok(marked.length < long.length, '仍必须比原文短（短块护栏依旧生效）')
  // 短块即使显式要求也不该被撑大
  const short = 'I will patch a.txt now.'
  assert.equal(OPS.extract(short, { op: 'extract', maxChars: 240, marker: true }), short,
    '显式 marker 也不能让短块变长')
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
  assert.ok(reasoning.text.includes('I will patch the parser now'), '含抽取到的决策句')
  assert.ok(!reasoning.text.includes('chars omitted'), '默认不带省略计数（会污染模型）')
  assert.ok(reasoning.text.length < 500, '塑形后确实变短')
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
  // 注意：这两个 op 的"是否触发"由**长度**决定，所以必须让 extract 的产出**仍长于**
  // truncate 的阈值，否则 truncate 是空操作（链式语义上没错，但测不到它）。
  // 历史教训：本条曾用 maxChars=500 的 extract —— 那时 extract 会加 ~40 字符前缀撑到
  // 279+，恰好让 truncate 触发；前缀去掉后 extract 只留 26 字符 ⇒ truncate 不再触发。
  // 也就是说**这条用例过去是靠前缀才通过的**，测的并不是"链式组合"。
  const text = `${'Exploring many options. '.repeat(20)}I will patch parse.js now.`
  const mid = await applyOps(text, [{ op: 'extract', maxChars: 500 }])
  assert.ok(mid.length < text.length, '第一级：extract 让文本变短')
  const out = await applyOps(text, [{ op: 'extract', maxChars: 500 }, { op: 'truncate', maxChars: 20 }])
  assert.ok(out.length <= 90, `链后应被截断（实得 ${out.length}）`)
  assert.ok(out.includes('省略'), 'truncate 留下省略标记（它是首尾保留，不丢信息结构）')
})

// ── 异步 op：LLM 调用 / 外部进程（都用注入的 mock，不真的出网或起进程）──
//
// ⚠️ mock 的响应对象**必须同时实现 text() 与 json()**：统一协议下 http op 会先取
// 响应**原文**（`res.text()`）再解析（这样才能兼容非 OpenAI 形状的服务）。
// 只实现 json() 的旧 mock 会让 op 抛错并被 fail-open 跳过 ⇒ 表现为"返回原文"，
// 看起来像功能坏了，其实是 mock 形状过时（实测踩到，故在此标注）。

/** 造一个 OpenAI 兼容形状的 mock 响应（同时支持 text() 与 json()）。 */
function openAiResponse(content) {
  const payload = { choices: [{ message: { content } }] }
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
}

test('summarize op：OpenAI 兼容请求 + 显式提示词（mock fetch）', async () => {
  let seen = null
  const fetchMock = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization }
    return openAiResponse('要点三行')
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
    return openAiResponse('ok')
  }
  await applyOps('token=sk-abcdefghijklmnop', [{ op: 'summarize' }], {
    fetch: fetchMock, llm: { apiKey: 'k' }, redact: (t) => t.replace(/sk-[a-z]+/u, '[REDACTED]'),
  })
  assert.ok(!sent.includes('sk-abcdefghijklmnop'), '出网文本应已脱敏')
})

test('summarize op：HTTP 失败 ⇒ 该 op 跳过（保留上一步结果，fail-open）', async () => {
  const fetchMock = async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) })
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

// ── 统一协议：传输 × 数据格式（exec / http / inline）──────────────────────────

/** 造一个假的子进程：stdout/stderr 按序吐出，退出码可控。 */
function fakeChild({ stdout = '', stderr = '', code = 0 } = {}) {
  return {
    stdout: { on: (e, f) => { if (e === 'data') setTimeout(() => f(stdout), 0) } },
    stderr: { on: (e, f) => { if (e === 'data' && stderr !== '') setTimeout(() => f(stderr), 0) } },
    stdin: { end: () => {} },
    on: (event, fn) => { if (event === 'close') setTimeout(() => fn(code), 3) },
    kill: () => {},
  }
}

/** 记录 spawn 收到的 (command, args, opts)。 */
function spySpawn(child) {
  const seen = []
  return {
    seen,
    spawn: (command, args, opts) => { seen.push({ command, args, opts }); return child },
  }
}

test('统一协议 exec：env / cwd 能传下去（env 与 process.env 合并）', async () => {
  const calls = []
  const spawn = (command, args, opts) => { calls.push({ command, args, opts }); return fakeChild({ stdout: 'x' }) }
  await applyOps('t', [{ op: 'exec', command: 'c', cwd: 'D:/tmp', env: { MY: '1' } }], { spawn })
  assert.equal(calls[0].opts.cwd, 'D:/tmp')
  assert.equal(calls[0].opts.env.MY, '1')
  // ⚠️ Windows 上它叫 `Path` 而不是 `PATH` ⇒ 别按大写断言（踩过）
  assert.ok(calls[0].opts.env.Path !== undefined || calls[0].opts.env.PATH !== undefined,
    '原有环境变量必须保留（env 是"追加"而不是"替换"）')
})

test('统一协议 exec：任何命令都行（node 也是 exec，不再是 python 专用）', async () => {
  const spy = spySpawn(fakeChild({ stdout: '{"text":"处理结果"}\n' }))
  const out = await applyOps('原始', [{ op: 'exec', command: 'node', script: 'shaper.mjs' }], { spawn: spy.spawn })
  assert.equal(out, '处理结果')
  assert.equal(spy.seen[0].command, 'node', 'command 决定用哪个解释器')
  assert.deepEqual(spy.seen[0].args, ['shaper.mjs'], 'script 作为第一个参数')
})

test('统一协议 exec：json 信封含 text/kind/meta/op/protocol', async () => {
  let captured = ''
  const child = fakeChild({ stdout: '{"text":"ok"}' })
  child.stdin = { end: (s) => { captured = s } }
  await applyOps('待处理', [{ op: 'exec', command: 'x', script: 's' }], {
    spawn: () => child, kind: 'reasoning', meta: { a: 1 },
  })
  const env = JSON.parse(captured)
  assert.equal(env.text, '待处理')
  assert.equal(env.kind, 'reasoning')
  assert.deepEqual(env.meta, { a: 1 })
  assert.equal(env.op, 'exec')
  assert.equal(env.protocol, 1, '协议版本号 —— 统一协议的握手依据')
})

test('统一协议 exec：protocol=argv 把文本当命令行参数、不写 stdin', async () => {
  let stdinUsed = false
  const child = fakeChild({ stdout: 'out' })
  child.stdin = { end: () => { stdinUsed = true } }
  const spy = spySpawn(child)
  // 用 {text} 占位符自己决定文本在参数里的位置（argv 协议也会自动追加一次）
  const out = await applyOps('要传的文本', [{ op: 'exec', command: 'x', args: ['--upper', '{text}'], protocol: 'argv' }], { spawn: spy.spawn })
  assert.equal(out, 'out')
  assert.deepEqual(spy.seen[0].args, ['--upper', '要传的文本', '要传的文本'],
    '{text} 占位符 + argv 自动追加各一次（想只出现一次就别用占位符）')
  assert.equal(stdinUsed, false, 'argv 协议不应写 stdin')
})

test('统一协议 exec：protocol=argv 且不用占位符 ⇒ 文本只在末尾出现一次', async () => {
  const spy = spySpawn(fakeChild({ stdout: 'out' }))
  await applyOps('T', [{ op: 'exec', command: 'x', args: ['--upper'], protocol: 'argv' }], { spawn: spy.spawn })
  assert.deepEqual(spy.seen[0].args, ['--upper', 'T'])
})

test('统一协议 exec：protocol=lines 先送 kind 再送文本', async () => {
  let captured = ''
  const child = fakeChild({ stdout: 'r' })
  child.stdin = { end: (s) => { captured = s } }
  await applyOps('正文', [{ op: 'exec', command: 'x', protocol: 'lines' }], { spawn: () => child, kind: 'toolResult' })
  assert.equal(captured, 'toolResult\n正文')
})

test('统一协议 exec：stdout 为 {text:null} ⇒ 整块删除；退出码非 0 ⇒ 只跳过该 op', async () => {
  const del = await applyOps('x', [{ op: 'exec', command: 'c' }], { spawn: spySpawn(fakeChild({ stdout: '{"text":null}' })).spawn })
  assert.equal(del, null, 'text:null 表示删除')
  const kept = await applyOps('x', [{ op: 'stub' }, { op: 'exec', command: 'c' }], {
    spawn: spySpawn(fakeChild({ stdout: '', code: 3 })).spawn,
  })
  assert.equal(kept, '[reasoning omitted: 1 chars]', '失败只跳过该 op')
})

test('统一协议 http：自定义 body 整包覆盖（接非 OpenAI 形状的服务）', async () => {
  let seen = null
  const fetchMock = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) }
    return { ok: true, status: 200, text: async () => JSON.stringify({ output: '压缩完' }) }
  }
  const out = await applyOps('大段文本', [{
    op: 'http', url: 'https://my.example/shaper', body: { input: '{{text}}', mode: 'fast' },
  }], { fetch: fetchMock })
  assert.equal(out, '压缩完', '响应里 output 字段也能取到')
  assert.equal(seen.body.input, '大段文本', '{{text}} 被替换')
  assert.equal(seen.body.mode, 'fast')
})

test('统一协议 http：instruction 作为第二条 system 消息追加', async () => {
  let body = null
  const fetchMock = async (_u, init) => {
    body = JSON.parse(init.body)
    return { ok: true, status: 200, text: async () => 'x' }
  }
  await applyOps('t', [{ op: 'http', url: 'https://e/x', system: '系统词', instruction: '再简短些' }], { fetch: fetchMock })
  assert.equal(body.messages[0].content, '系统词')
  assert.equal(body.messages[1].content, '再简短些')
  assert.equal(body.messages[2].role, 'user')
})

test('统一协议 inline：firstLine / jsonField / regex（纯字符串 ⇒ 可热改）', async () => {
  assert.equal(await applyOps('a\nb\nc', [{ op: 'inline', use: 'firstLine', maxLines: 2 }]), 'a\nb')
  assert.equal(await applyOps('{"a":{"b":"深层"}}', [{ op: 'inline', use: 'jsonField', field: 'a.b' }]), '深层')
  assert.equal(await applyOps('id=42', [{ op: 'inline', use: 'regex', pattern: 'id=(\\d+)', template: '#$1' }]), '#42')
})

test('统一协议 inline.code：源码字符串（可热改），且总是走缓存', async () => {
  // ⚠️ 缓存文件必须**每次运行都清掉**：`caseNo` 是模块级计数器、每次运行都从同一个数开始
  // ⇒ 同名文件里会留着**上一次运行**的条目 ⇒ 第二次运行起就命中旧缓存
  //（实测踩到：本机缓存里已有一条 key 相同的条目，导致"编译次数"断言失败）。
  const compiled = []
  const inlineCachePath = join(TMP, `inline-${caseNo += 1}.jsonl`)
  rmSync(inlineCachePath, { force: true })
  const cache = createOpCache({ cache: { enabled: true, path: inlineCachePath } }, () => {})
  const ctx = { compileInline: (body) => { compiled.push(body); return (text) => String(text).slice(0, 2) }, cache }
  assert.equal(await applyOps('abcdef', [{ op: 'inline', use: 'code', code: 'return text.slice(0,2)' }], ctx), 'ab')
  assert.equal(compiled.length, 1, '首次执行应编译一次')
  assert.equal(await applyOps('abcdef', [{ op: 'inline', use: 'code', code: 'return text.slice(0,2)' }], ctx), 'ab',
    '第二次应命中缓存')
  assert.equal(compiled.length, 1, '缓存命中时不再编译')
})

test('代理：llm 服务未就绪时留痕（否则提供方在选择器里消失且看不出原因）', () => {
  // 实测现场：重启后 apply 时拿不到 llm 服务 ⇒ 不注册 ⇒ **模型选择器里看不到本插件的
  // 提供方**，而日志里一片安静 ⇒ 用户以为"插件没生效"。现在必须有一条留痕日志。
  caseNo += 1
  const logPath = join(TMP, `wait-proxy-${caseNo}.log`)
  const listeners = []
  const ctx = { on: (n, h) => { listeners.push({ n, h }); return () => {} }, get: () => undefined }
  apply(ctx, {
    logPath, offSentinel: join(TMP, 'no.OFF'), configPath: join(TMP, `none-${caseNo}.json`),
    cache: { enabled: false }, proxy: { enabled: true },
  })
  const text = readFileSync(logPath, 'utf8')
  assert.ok(text.includes('proxy 等待 llm 服务就绪'), `应留下"等待服务"的日志。实得：\n${text}`)
})

test('旧名兼容：python / summarize 与统一协议实现等价', async () => {
  const spy = spySpawn(fakeChild({ stdout: '{"text":"ok"}' }))
  const viaAlias = await applyOps('t', [{ op: 'python', script: 's.py' }], { spawn: spy.spawn })
  const viaExec = await applyOps('t', [{ op: 'exec', command: 'python', script: 's.py' }], { spawn: spy.spawn })
  assert.equal(viaAlias, 'ok')
  assert.equal(viaExec, 'ok')
  assert.equal(spy.seen[0].command, 'python', 'python 别名默认用 python 解释器')
  assert.deepEqual(spy.seen[0].args, spy.seen[1].args, '两条路径参数一致')
})

test('统一协议 exec：python 自动带上 PYTHONIOENCODING=utf-8（Windows 中文会乱码）', async () => {
  // 实测：Windows 上 Python 往管道写非 ASCII 默认用 cp936，而插件按 utf8 解码 ⇒ 中文变 ????
  // （`python -X utf8` 无效，那条只管源码/文件）。所以插件替 python 默认设好，且用户可覆盖。
  const calls = []
  const spawn = (command, args, opts) => { calls.push({ command, opts }); return fakeChild({ stdout: 'x' }) }
  await applyOps('t', [{ op: 'exec', command: 'python', script: 's.py' }], { spawn })
  assert.equal(calls[0].opts.env.PYTHONIOENCODING, 'utf-8', 'python 应自动带上 UTF-8 输出设置')

  await applyOps('t', [{ op: 'exec', command: 'D:/tools/python3.exe', script: 's.py' }], { spawn })
  assert.equal(calls[1].opts.env.PYTHONIOENCODING, 'utf-8', '绝对路径的 python.exe 也要认')

  await applyOps('t', [{ op: 'exec', command: 'python', script: 's.py', env: { PYTHONIOENCODING: 'gbk' } }], { spawn })
  assert.equal(calls[2].opts.env.PYTHONIOENCODING, 'gbk', '用户显式设置优先')

  await applyOps('t', [{ op: 'exec', command: 'node', args: ['-e', '0'] }], { spawn })
  assert.equal(calls[3].opts.env, undefined, '非 python 命令不加这个变量')
})

/**
 * 在一个**干净的 node 子进程**里跑一段 ESM 源码，返回 { code, stdout, stderr }。
 * 用途：有些缺陷只在"没有其它 handle 让事件循环活着"的进程里才暴露
 *（例：超时定时器被 `unref()` ⇒ 进程提前退出），测试运行器里测不出来。
 * 沙箱不允许 spawn 时返回 null（调用方自行降级）。
 * @param source - 要执行的 ESM 源码（可用顶层 await）
 * @returns {Promise<{code:number, stdout:string, stderr:string}|null>}
 */
async function runInChildProcess(source) {
  try {
    const { spawnSync } = await import('node:child_process')
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'shaper-child-'))
    const file = join(dir, 'probe.mjs')
    writeFileSync(file, source, 'utf8')
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 15000 })
    rmSync(dir, { recursive: true, force: true })
    if (r.error !== undefined && r.error !== null) return null
    return { code: r.status ?? -1, stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '' }
  } catch {
    return null
  }
}

test('超时护栏：定时器不得 unref（否则"该超时时不超时"）', async () => {
  // 回归用例。曾经对超时定时器调用 `unref()`：本意是"别阻止进程退出"，代价却是
  // 若进程没有别的 handle 让事件循环活着，进程会直接退出、promise 永不 settle
  //（实测：退出码 13 + `Warning: Detected unsettled top-level await`）。
  //
  // ⚠️ **这个 bug 在进程内测不出来** —— 测试运行器本身让事件循环活着，unref 的定时器
  // 照样会触发（我第一版就是这么写错的：撤掉修复后它仍然通过 ⇒ 一条假测试）。
  // 所以真正有用的判据是"**在没有其它 handle 的干净子进程里**能不能拿到超时结果"。
  const child = await runInChildProcess(`
    import { applyOps } from ${JSON.stringify(new URL('../index.js', import.meta.url).href)}
    const out = await applyOps('原始', [
      { op: 'http', baseURL: 'http://x/v1', timeoutMs: 40 },
      { op: 'inline', use: 'regex', pattern: '原始', template: '继续' },
    ], { fetch: () => new Promise(() => {}), kind: 'r', log: () => {} })
    process.stdout.write(String(out))
  `)
  if (child === null) {
    // 沙箱不允许 spawn：退化为行为断言（弱），并明确标注
    const out = await applyOps('原始', [
      { op: 'http', baseURL: 'http://x/v1', timeoutMs: 40 },
      { op: 'inline', use: 'regex', pattern: '原始', template: '继续' },
    ], { fetch: () => new Promise(() => {}), kind: 'r', log: () => {} })
    assert.equal(out, '继续', '（沙箱降级模式）超时后应继续执行后续 op')
    return
  }
  assert.equal(child.code, 0, `子进程应正常退出（unref 会让它在超时前就退出）。stderr=${child.stderr.slice(0, 200)}`)
  assert.equal(child.stdout, '继续', `子进程应拿到超时后的结果。stdout=${JSON.stringify(child.stdout)}`)

  // 反向判据：op 正常完成时定时器要被清掉，否则进程会被它多留整个超时时长。
  const quick = Date.now()
  const ok = await applyOps('x', [{ op: 'http', baseURL: 'http://x/v1', timeoutMs: 60000 }],
    { fetch: async () => ({ ok: true, status: 200, text: async () => 'done' }), kind: 'r', log: () => {} })
  assert.equal(ok, 'done')
  assert.ok(Date.now() - quick < 1000, 'op 完成时应清掉定时器（否则会挂住整个超时时长）')
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
  // 推理块必须**够长**（塑形后确实比原文短）才会加省略计数前缀 —— 见
  // 「extract：短块不撑大」那条用例。这里攒出的是一段长推理，走的是正常路径。
  const out = await runStream(streamListener, [
    { type: 'reasoning', text: `${'Exploring many options and weighing tradeoffs. '.repeat(8)}` },
    { type: 'reasoning', text: 'I will patch a.txt now.' },
    { type: 'text', text: 'answer' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(out.length, 3, '还原成 3 个 chunk：reasoning + text + finish')
  assert.equal(out[0].type, 'reasoning', '推理字段必须仍在（否则工具回路会 400）')
  assert.ok(!out[0].text.includes('chars omitted'), '默认不带省略计数（会污染模型）')
  assert.ok(out[0].text.length < 400, '塑形后必须真的更短')
  assert.equal(out[1].type, 'text')
  assert.equal(out[2].type, 'finish')
})

test('流过滤：短推理块不撑大（不加会变长的省略计数前缀）', async () => {
  const { streamListener } = setupStream()
  const out = await runStream(streamListener, [
    { type: 'reasoning', text: 'I will patch a.txt now.' },
    { type: 'text', text: 'answer' },
  ])
  assert.equal(out[0].type, 'reasoning', '字段仍在')
  assert.equal(out[0].text, 'I will patch a.txt now.', '短块原样透传：加前缀会净增字节')
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

test('自定义 op：config.ops 注入的函数被 policy 引用后真的生效', async () => {
  const { handlers, appends, session } = setup({
    policy: { reasoning: { ops: [{ op: 'shout' }] } },
    ops: { shout: (text) => `!!!${String(text).slice(0, 4)}!!!` },
  })
  emit(handlers, session, makeEvent())
  await settle()
  assert.equal(appends.length, 1, '自定义 op 应触发替换')
  assert.equal(appends[0][1].message.content[0].text, '!!!Expl!!!')
})

test('自定义 op：可用字符串把名字映射到内置 op（无需注入函数 ⇒ 可热改）', async () => {
  const { handlers, appends, session } = setup({
    policy: { reasoning: { ops: [{ op: 'myalias' }] } },
    ops: { myalias: 'stub' },
  })
  emit(handlers, session, makeEvent())
  await settle()
  assert.equal(appends.length, 1)
  assert.ok(appends[0][1].message.content[0].text.startsWith('[reasoning omitted:'),
    'myalias 应解析到内置 stub')
})

test('自定义 op：未知名字（既非函数也非内置）⇒ 跳过该 op，不抛错', async () => {
  const { handlers, appends, session } = setup({
    policy: { reasoning: { ops: [{ op: 'nope' }, { op: 'stub' }] } },
  })
  emit(handlers, session, makeEvent())
  await settle()
  // 第一个 op 被跳过 ⇒ 第二个 stub 仍然生效（链式 fail-open）
  assert.equal(appends.length, 1)
  assert.ok(appends[0][1].message.content[0].text.startsWith('[reasoning omitted:'))
})

test('自定义 op：不进缓存键的那个函数字段（同名不同实现必须能区分）', () => {
  // 反例是"直接把 { ...op } 序列化"：JSON.stringify 会丢掉函数 ⇒
  // 两个同名不同实现的自定义 op 撞到同一个键 ⇒ 拿旧结果冒充新实现。
  // 这里用 keyOf 直接验证：同名 + 参数不同 ⇒ 键必须不同。
  const cache = createOpCache({ enabled: false }, () => {})
  const a = cache.keyOf({ op: 'mine', p: 1, __fn: () => 'x' }, 'input', {})
  const b = cache.keyOf({ op: 'mine', p: 2, __fn: () => 'x' }, 'input', {})
  const c = cache.keyOf({ op: 'mine', p: 1, __fn: () => 'y' }, 'input', {})
  assert.notEqual(a, b, '参数不同 ⇒ 键必须不同')
  assert.equal(a, c, '函数体本来就不会进键（JSON 丢函数）⇒ 同名同参数即同键；'
    + '所以自定义 op 请用不同的名字区分实现')
  assert.equal(cache.keyOf({ op: 's', apiKey: 'k1' }, 'in', {}), cache.keyOf({ op: 's', apiKey: 'k2' }, 'in', {}),
    'apiKey 不得进键（换了密钥不该整体失效）')
})

test('默认不尝试 assistant/message 的表面替换（已知校验器冲突）', async () => {
  const { handlers, appends, session } = setup({ surfaceAssistant: false })
  emit(handlers, session, makeEvent())
  await settle()
  assert.equal(appends.length, 0, '表面替换默认关闭')
})

test('表面替换路径：成功日志与护栏 4 延迟告警真的执行（曾有 ReferenceError 把整段静默废掉）', async () => {
  // 回归用例。曾经 `stats.blocks += reasoning.length` 引用了**未声明**的标识符，
  // 而 `reasoning` 只是别处的局部变量 ⇒ 抛 ReferenceError。它抛在 try 内、且位置在
  // `session.append` **之后**，所以表面替换照常成功、只有后面的语句全部不执行：
  // 统计不记账、护栏 4 的 lagWarnMs 告警永不触发、`strip #1` 成功日志永不输出
  //（而 docs/PIPELINE.md 正把 `strip #1` 列为验收观测点）。
  // 61 个用例里没有一个读过日志文件 —— 这就是它当初溜过去的原因。
  const { handlers, appends, session, logPath } = setup()
  emit(handlers, session, makeEvent())
  await settle()
  assert.equal(appends.length, 1, '替换事件应当已产生')
  const text = readFileSync(logPath, 'utf8')
  assert.ok(text.includes('strip #1'), `成功日志缺失 ⇒ 该段又被静默跳过。实得日志：\n${text}`)
  assert.ok(text.includes('blocks='), '成功日志应含 blocks= 计数')
  assert.ok(!text.includes('FAILED append'), `不应出现失败行。实得日志：\n${text}`)
})

test('表面替换路径：lagWarnMs 设为 0 时护栏 4 的告警真的写出来', async () => {
  // 护栏 4 的价值全在这行告警上：它是"定型早于首次发送"的可观测证据。
  // 把阈值设成 0 ⇒ 任何非零延迟都触发（lag 为 null 时不触发，所以用带 time 的事件）。
  const { handlers, session, logPath } = setup({ lagWarnMs: 0 })
  emit(handlers, session, { ...makeEvent(), time: Date.now() - 50 })
  await settle()
  const text = readFileSync(logPath, 'utf8')
  assert.ok(text.includes('WARN 定型延迟过大'), `护栏 4 告警未写出。实得日志：\n${text}`)
})

// ── 非纯 op 的结果缓存（保证多次出网结果逐字节一致 ⇒ 前缀稳定）──

test('缓存：LLM op 同一输入只算一次', async () => {
  caseNo += 1
  const cachePath = join(TMP, `cache-${caseNo}.jsonl`)
  rmSync(cachePath, { force: true })
  let calls = 0
  const fetchMock = async () => {
    calls += 1
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: `摘要${calls}` } }] }) }
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
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '重启前的摘要' } }] }) }
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
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: `v${calls}` } }] }) }
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
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'x' } }] }) }
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

// ── wire 级：逐消息塑形 + 代理 provider ──

const assistantMsg = () => ({
  role: 'assistant',
  content: [
    { type: 'reasoning', text: `${'Exploring options. '.repeat(20)}I will patch a.txt now.` },
    { type: 'text', text: 'answer' },
    { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' },
  ],
})
const toolMsg = () => ({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'X'.repeat(300) }] }] })
const userMsg = () => ({ role: 'user', content: [{ type: 'text', text: '原始提问，不能改' }] })

test('shapeMessages：默认只塑形 reasoning，text/tool-call/tool-result/user 原样', async () => {
  const policy = { reasoning: { ops: [{ op: 'extract', maxChars: 60 }] }, toolResult: { ops: [{ op: 'keep' }] }, toolArgs: { ops: [{ op: 'keep' }] }, assistantText: { ops: [{ op: 'keep' }] } }
  const out = await shapeMessages([assistantMsg(), toolMsg(), userMsg()], policy, {})
  const assistant = out[0].content
  assert.ok(assistant[0].text.length < assistantMsg().content[0].text.length, 'reasoning 被塑形（变短）')
  assert.ok(!assistant[0].text.includes('chars omitted'), '默认不带省略计数（会污染模型）')
  assert.equal(assistant[1].text, 'answer', 'text 原样')
  assert.equal(assistant[2].arguments, '{"path":"a.txt"}', 'tool-call 参数原样')
  assert.equal(out[1].content[0].content[0].text.length, 300, 'tool-result 原样')
  assert.equal(out[2].content[0].text, '原始提问，不能改', 'user 消息绝不触碰')
  assert.notEqual(out[0], assistantMsg(), '被改动的消息是新对象')
  assert.equal(out[2], out[2], '未改动的消息可复用')
})

test('shapeMessages：配置了 toolResult 时才对工具结果动手', async () => {
  const policy = { reasoning: { ops: [{ op: 'keep' }] }, toolResult: { ops: [{ op: 'truncate', maxChars: 60 }] }, toolArgs: { ops: [{ op: 'keep' }] }, assistantText: { ops: [{ op: 'keep' }] } }
  const out = await shapeMessages([assistantMsg(), toolMsg()], policy, {})
  assert.equal(out[0].content[0].text.includes('省略'), false, 'reasoning 不该被改')
  assert.ok(out[1].content[0].content[0].text.includes('省略'), 'tool-result 被截断')
})

test('shapeMessages：非纯 op 走缓存（两次塑形只调用一次 LLM）', async () => {
  caseNo += 1
  const cachePath = join(TMP, `cache-${caseNo}.jsonl`)
  rmSync(cachePath, { force: true })
  let calls = 0
  const fetchMock = async () => {
    calls += 1
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '要点' } }] }) }
  }
  const ctx = { fetch: fetchMock, llm: { apiKey: 'k' }, cache: createOpCache({ cache: { path: cachePath, enabled: true } }, () => {}) }
  const policy = { reasoning: { ops: [{ op: 'summarize' }] }, toolResult: { ops: [{ op: 'keep' }] }, toolArgs: { ops: [{ op: 'keep' }] }, assistantText: { ops: [{ op: 'keep' }] } }
  const a = await shapeMessages([assistantMsg()], policy, ctx)
  const b = await shapeMessages([assistantMsg()], policy, ctx)
  assert.equal(a[0].content[0].text, '要点')
  assert.deepEqual(a, b, '两次塑形结果必须一致（前缀稳定）')
  assert.equal(calls, 1, '第二次命中缓存')
})

function fakeLlm() {
  const captured = []
  return {
    captured,
    stream(options) {
      captured.push(options)
      return (async function* chunks() {
        yield { type: 'text', text: `via:${options.provider}` }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: 'Upstream Name', contextWindow: 1000000 }
    },
    async listModels() {
      // 真实上游返回的每条都带自己的 provider —— 这正是"原样转手"会踩雷的原因，
      // 所以假上游必须也带上，否则测不出改盖行为。
      return [{ provider: 'deepseek-official', id: 'deepseek-flash', name: 'v4.1-flash' }]
    },
    providerRetryPolicy(provider) {
      return { provider, maxAttempts: 3 }
    },
    registerAdapter(providers, adapter) {
      this.registered = { providers, adapter }
    },
  }
}

test('代理适配器：prepareCall 带上游真实模型元数据（含 contextWindow）', async () => {
  const llm = fakeLlm()
  const adapter = createProxyAdapter({ llm, upstream: 'deepseek-official', policy: {}, ctx: {} })
  const prepared = await adapter.prepareCall('deepseek-shaped', 'deepseek-flash')
  assert.equal(prepared.model.contextWindow, 1000000, '必须借用上游元数据，否则丢掉窗口信息')
  assert.equal(prepared.model.provider, 'deepseek-shaped', 'provider 必须改盖成别名路由 id')
  assert.equal(typeof prepared.stream, 'function')
})

test('代理适配器：满足运行时对适配器的**全部**成员要求（缺一个就注册失败，实测踩过）', async () => {
  const llm = fakeLlm()
  const adapter = createProxyAdapter({ llm, upstream: 'deepseek-official', policy: {}, ctx: {} })
  // 运行时调用点（llm/src/index.ts）：409 providerInfo、414 providerRetryPolicy、
  // 610 listModels、659 resolveModel、826/910 prepareCall、stream。
  for (const member of ['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof adapter[member], 'function', `适配器必须实现 ${member}()`)
  }
  // 基类 LlmAdapter 本有默认实现，但本适配器是普通对象 ⇒ 必须自己给（否则注册期就抛
  // "adapter.providerRetryPolicy is not a function"）
  assert.deepEqual(adapter.providerRetryPolicy('deepseek-shaped'), { provider: 'deepseek-official', maxAttempts: 3 },
    '重试策略应借用上游')
  assert.deepEqual(adapter.providerInfo('deepseek-shaped'), { id: 'deepseek-shaped', name: 'deepseek-shaped (entry-shaper 代理)' })

  // resolveModel 的关键约束：normalizeModelInfo()（llm/src/index.ts:663-683）要求
  // resolved.provider === 本路由 id、resolved.id === model、name 非空
  const resolved = await adapter.resolveModel('deepseek-shaped', 'deepseek-flash')
  assert.equal(resolved.provider, 'deepseek-shaped', 'provider 必须是本路由 id，否则抛 INVALID_MODEL_INFO')
  assert.equal(resolved.id, 'deepseek-flash')
  assert.equal(resolved.contextWindow, 1000000, '容量字段照搬上游')
  assert.ok(typeof resolved.name === 'string' && resolved.name.length > 0, 'name 不能为空')

  // 上游什么都拿不到时也必须给出合法最小信息（不能抛）
  const bare = createProxyAdapter({ llm: { stream: () => (async function* () {})() }, upstream: 'up', policy: {}, ctx: {} })
  const fallback = await bare.resolveModel('alias', 'm1')
  assert.deepEqual(fallback, { provider: 'alias', id: 'm1', name: 'm1' })
  assert.equal(bare.providerRetryPolicy('alias'), undefined, '拿不到上游策略 ⇒ undefined（等价基类默认）')
})

test('代理适配器：listModels 满足宿主目录校验（provider 必须改盖，否则整组消失）', async () => {
  const llm = fakeLlm()
  const adapter = createProxyAdapter({ llm, upstream: 'deepseek-official', policy: {}, ctx: {} })
  const listed = await adapter.listModels('deepseek-shaped')

  // 复刻 LlmRuntime.listModels()（llm/src/index.ts:608-624）的逐条校验。
  // 旧实现原样转手上游列表 ⇒ 每条 provider 是 'deepseek-official' ≠ 本路由 id
  // ⇒ 抛 INVALID_CATALOG ⇒ 模型选择器里整组消失（实测现场就是这么发现的）。
  assert.ok(listed.length > 0, '必须能枚举出模型')
  const seen = new Set()
  for (const model of listed) {
    assert.equal(model.provider, 'deepseek-shaped', 'model.provider 必须是本路由 id')
    assert.ok(typeof model.id === 'string' && model.id.length > 0, 'id 非空')
    assert.ok(typeof model.name === 'string' && model.name.length > 0, 'name 非空')
    assert.ok(!seen.has(model.id), 'id 不得重复')
    seen.add(model.id)
  }
  assert.equal(listed[0].name, 'v4.1-flash', '其余字段照搬上游')

  // 上游枚举失败时返回空列表（而不是抛）
  const broken = createProxyAdapter({
    llm: { stream: () => (async function* () {})() },
    upstream: 'up', policy: {}, ctx: {},
  })
  assert.deepEqual(await broken.listModels('alias'), [])
})

test('代理适配器：onShaped 上报省了多少字符（不依赖外部抓包的自证手段）', async () => {
  const llm = fakeLlm()
  const policy = { reasoning: { ops: [{ op: 'stub' }] }, toolResult: { ops: [{ op: 'keep' }] }, toolArgs: { ops: [{ op: 'keep' }] }, assistantText: { ops: [{ op: 'keep' }] } }
  const seen = []
  const adapter = createProxyAdapter({
    llm, upstream: 'deepseek-official', policy, ctx: { stubTemplate: '[omitted {chars}]' },
    onShaped: (info) => seen.push(info),
  })
  for await (const _chunk of adapter.stream({ provider: 'deepseek-shaped', messages: [assistantMsg()] })) { /* drain */ }

  assert.equal(seen.length, 1, '塑形发生时应上报一次')
  assert.ok(seen[0].before > seen[0].after, `应显示缩减：${seen[0].before} → ${seen[0].after}`)
  // 口径：整条 messages 的字符总量（推理 + 文本 + 工具参数），不是只算被改的那个块。
  // 期望值直接由 shapeMessages 现算 —— 不手抄数字（我第一版手抄错了 8 个字符）。
  const measured = (msgs) => msgs.reduce(
    (n, m) => n + (m.content ?? []).reduce(
      (k, b) => k + (typeof b.text === 'string' ? b.text.length : typeof b.arguments === 'string' ? b.arguments.length : 0), 0), 0)
  const stubCtx = { stubTemplate: '[omitted {chars}]' }
  const shaped = await shapeMessages([assistantMsg()], policy, stubCtx)
  assert.equal(seen[0].before, measured([assistantMsg()]), 'before 应是整条 messages 的字符量')
  assert.equal(seen[0].after, measured(shaped), 'after 应与实际塑形结果一致')
  assert.equal(shaped[0].content[0].text, '[omitted 403]', '前提：推理原文 403 字符 ⇒ 短桩 13 字符')

  // 不塑形（shouldShape=false）时不上报 —— 避免把"原样转发"记成"省了 0%"
  const off = createProxyAdapter({
    llm, upstream: 'deepseek-official', policy, ctx: {}, shouldShape: () => false,
    onShaped: (info) => seen.push(info),
  })
  for await (const _chunk of off.stream({ provider: 'deepseek-shaped', messages: [assistantMsg()] })) { /* drain */ }
  assert.equal(seen.length, 1, '未塑形不应上报')
})

test('代理适配器：转发时换成上游 provider，并把 messages 塑形', async () => {
  const llm = fakeLlm()
  const policy = { reasoning: { ops: [{ op: 'stub' }] }, toolResult: { ops: [{ op: 'keep' }] }, toolArgs: { ops: [{ op: 'keep' }] }, assistantText: { ops: [{ op: 'keep' }] } }
  const adapter = createProxyAdapter({ llm, upstream: 'deepseek-official', policy, ctx: { stubTemplate: '[omitted {chars}]' } })
  const chunks = []
  for await (const c of adapter.stream({ provider: 'deepseek-shaped', model: 'deepseek-flash', messages: [assistantMsg()] })) chunks.push(c)

  assert.equal(llm.captured.length, 1, '只应转发一次（不递归）')
  const forwarded = llm.captured[0]
  assert.equal(forwarded.provider, 'deepseek-official', '内层必须是上游 provider')
  assert.ok(forwarded.messages[0].content[0].text.startsWith('[omitted '), '内层 messages 已塑形')
  assert.equal(chunks[0].text, 'via:deepseek-official', '上游 chunk 原样透传')
})

test('代理适配器：shouldShape=false（哨兵/总闸关闭）时原样转发，不塑形', async () => {
  const llm = fakeLlm()
  const policy = { reasoning: { ops: [{ op: 'stub' }] }, toolResult: { ops: [{ op: 'keep' }] }, toolArgs: { ops: [{ op: 'keep' }] }, assistantText: { ops: [{ op: 'keep' }] } }
  const adapter = createProxyAdapter({ llm, upstream: 'deepseek-official', policy, ctx: {}, shouldShape: () => false })
  for await (const _ of adapter.stream({ provider: 'deepseek-shaped', messages: [assistantMsg()] })) { /* drain */ }
  const forwarded = llm.captured[0]
  assert.ok(forwarded.messages[0].content[0].text.startsWith('Exploring'), '急刹时应转发原文（完整推理）')
  assert.equal(forwarded.provider, 'deepseek-official', '仍然要正常转发（不拒绝请求）')
})

test('代理适配器：模型列表来自上游，但 provider 改盖成本路由 id', async () => {
  const llm = fakeLlm()
  const adapter = createProxyAdapter({ llm, upstream: 'deepseek-official', policy: {}, ctx: {} })
  assert.deepEqual(await adapter.listModels('deepseek-shaped'),
    [{ provider: 'deepseek-shaped', id: 'deepseek-flash', name: 'v4.1-flash' }])
})

test('插件启动：proxy.enabled 时注册代理 provider；拿不到 llm 服务则 fail-open', () => {
  const registered = []
  const ctx = {
    on: () => () => {},
    get: (name) => (name === 'llm' ? { registerAdapter: (p, a) => registered.push({ p, a }) } : undefined),
  }
  apply(ctx, { logPath: join(TMP, `proxy-${caseNo += 1}.log`), offSentinel: join(TMP, 'no.OFF'), configPath: join(TMP, 'proxy-cfg-none.json'), proxy: { enabled: true, provider: 'shaped-x', upstream: 'deepseek-official' } })
  assert.equal(registered.length, 1, '应注册一个代理 provider')
  assert.deepEqual(registered[0].p, ['shaped-x'])
  assert.equal(typeof registered[0].a.stream, 'function')

  const noLlmCtx = { on: () => () => {}, get: () => undefined }
  assert.doesNotThrow(() => apply(noLlmCtx, { logPath: join(TMP, 'proxy-nollm.log'), offSentinel: join(TMP, 'no.OFF'), configPath: join(TMP, 'proxy-nollm-cfg-none.json'), proxy: { enabled: true } }))
})

test('代理：惰性注册 —— 用热配置打开 proxy 后，下一次 LLM 调用即完成注册（无需重挂载）', async () => {
  caseNo += 1
  const cfgPath = join(TMP, `lazy-proxy-${caseNo}.json`)
  const logPath = join(TMP, `lazy-proxy-${caseNo}.log`)
  writeFileSync(cfgPath, JSON.stringify({ enabled: true, proxy: { enabled: false } }), 'utf8')

  const registered = []
  const listeners = []
  const llm = fakeLlm()
  llm.registerAdapter = (providers, adapter) => { registered.push({ providers, adapter }) }
  const ctx = {
    on: (name, handler) => { listeners.push({ name, handler }); return () => {} },
    get: (name) => (name === 'llm' ? llm : undefined),
  }
  apply(ctx, { logPath, offSentinel: join(TMP, 'no.OFF'), configPath: cfgPath })
  assert.equal(registered.length, 0, '配置里 proxy 未开 ⇒ 启动时不注册')

  // 热改配置打开 proxy，然后只跑一次 LLM 中间件（模拟真实调用的第一跳）
  await new Promise((r) => setTimeout(r, 20))
  writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    proxy: { enabled: true, provider: 'shaped-lazy', upstream: 'deepseek-official' },
  }), 'utf8')
  const middleware = listeners.find((l) => l.name === 'llm/stream').handler
  const source = (async function* () { yield { type: 'text', text: 'x' } })()
  for await (const _chunk of middleware({ provider: 'deepseek-official', messages: [] }, () => source)) { /* drain */ }

  assert.equal(registered.length, 1, '热开 proxy 后应在下一次调用时完成注册 —— 这就是"免重挂载"')
  assert.deepEqual(registered[0].providers, ['shaped-lazy'])
})

test('热配置：改配置文件无需重启即生效（按 mtime 热读）', async () => {
  caseNo += 1
  const cfgPath = join(TMP, `hot-${caseNo}.json`)
  const logPath = join(TMP, `hot-${caseNo}.log`)
  rmSync(cfgPath, { force: true })
  writeFileSync(cfgPath, JSON.stringify({ enabled: false }), 'utf8')

  const listeners = []
  const ctx = { on: (n, h) => { listeners.push({ n, h }); return () => {} } }
  apply(ctx, { logPath, offSentinel: join(TMP, 'no.OFF'), configPath: cfgPath })
  const mw = listeners.find((l) => l.n === 'llm/stream').h
  const chunks = [{ type: 'reasoning', text: 'FULL' }, { type: 'text', text: 'x' }]
  const run = async () => {
    const out = []
    const src = (async function* () { for (const c of chunks) yield c })()
    for await (const c of mw({}, () => src)) out.push(c)
    return out
  }

  // enabled:false ⇒ 原样透传
  assert.equal((await run())[0].text, 'FULL', '配置里 enabled:false ⇒ 不塑形')

  // 改配置文件（模拟用户编辑；mtime 变化即可，不要重启）
  await new Promise((r) => setTimeout(r, 20))
  writeFileSync(cfgPath, JSON.stringify({ enabled: true, policy: { reasoning: { ops: [{ op: 'stub' }] } } }), 'utf8')
  const after = await run()
  assert.equal(after[0].text, '[reasoning omitted: 4 chars]', '热改配置后立即按新策略执行 ✓')
})

test('非 assistant/message 事件被跳过', async () => {
  const { handlers, appends, session } = setup()
  emit(handlers, session, makeEvent({ type: 'tool/result' }))
  await settle()
  assert.equal(appends.length, 0)
})

/** 一个"必然会被塑形"的 tool/result 事件（300 字符 + truncate:60 一定改变文本）。 */
const TOOL_RESULT = {
  type: 'tool/result',
  seq: 900,
  surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'X'.repeat(300) }] }] } },
}
const TRUNCATE = { policy: { toolResult: { ops: [{ op: 'truncate', maxChars: 60 }] } } }

test('开关 enabled=false：两条通道都不动作（事件 + 流过滤）', async () => {
  const { handlers, appends, session } = setup({ enabled: false, ...TRUNCATE })
  emit(handlers, session, TOOL_RESULT)
  await settle()
  assert.equal(appends.length, 0, 'enabled=false ⇒ tool/result 不塑形')

  const { streamListener } = setupStream({ enabled: false })
  const out = await runStream(streamListener, [{ type: 'reasoning', text: 'FULL' }])
  assert.equal(out[0].text, 'FULL', 'enabled=false ⇒ 流原样透传')
})

test('开关 shapeReasoning=false：只关推理，不牵连 toolResult（旧版把两者压在同一开关上 ⇒ 静默失效）', async () => {
  const { handlers, appends, session } = setup({ shapeReasoning: false, ...TRUNCATE })
  emit(handlers, session, TOOL_RESULT)
  await settle()
  assert.equal(appends.length, 1, 'toolResult 塑形必须仍然生效')
  assert.ok(appends[0][1].message.content[0].content[0].text.includes('省略'), 'tool 结果确实被截了')

  const { streamListener } = setupStream({ shapeReasoning: false })
  const out = await runStream(streamListener, [{ type: 'reasoning', text: 'FULL' }])
  assert.equal(out[0].text, 'FULL', '推理确实没被动')
})

test('旧名 dropReasoning=false 等价于 shapeReasoning=false（且同样只关推理）', async () => {
  const { handlers, appends, session } = setup({ dropReasoning: false, ...TRUNCATE })
  emit(handlers, session, TOOL_RESULT)
  await settle()
  assert.equal(appends.length, 1, '旧名不该把 toolResult 一起关掉')

  const { streamListener } = setupStream({ dropReasoning: false })
  const out = await runStream(streamListener, [{ type: 'reasoning', text: 'FULL' }])
  assert.equal(out[0].text, 'FULL', '旧名仍能关掉推理塑形')
})

test('mergeCfg：旧名归一、新名优先、空值安全', () => {
  assert.deepEqual(mergeCfg({ dropReasoning: false, a: 1 }), { shapeReasoning: false, a: 1 })
  assert.deepEqual(mergeCfg({ dropReasoning: true, shapeReasoning: false }), { shapeReasoning: false },
    '两个名字都给时以新名为准')
  assert.deepEqual(mergeCfg({}), {})
  assert.deepEqual(mergeCfg(undefined), {})
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

// ── 污染防护 + 原文寄存（见 docs/POLLUTION.md）──

test('污染防护：默认塑形结果里不含任何"记账格式"字串', async () => {
  // 这是本轮最重要的不变量：模型会把塑形器的记账标记当成自己的思维内容继续写
  // （wire 级取证：输出分片为 "[" "reason" "ing" " extract" ":" …，是模型逐字生成的）。
  const policy = { reasoning: { ops: [{ op: 'extract', maxChars: 240 }] }, toolResult: { ops: [{ op: 'keep' }] }, toolArgs: { ops: [{ op: 'keep' }] }, assistantText: { ops: [{ op: 'keep' }] } }
  const long = `${'Exploring options and weighing tradeoffs. '.repeat(20)}I will patch a.txt now.`
  const out = await shapeMessages([{ role: 'assistant', content: [{ type: 'reasoning', text: long }] }], policy, {})
  const text = out[0].content[0].text
  assert.ok(!/chars omitted|reasoning extract|reasoning omitted/i.test(text),
    `默认输出不得含记账格式，实得：${JSON.stringify(text.slice(0, 80))}`)
  assert.ok(text.includes('I will patch a.txt now'), '决策句仍在')
})

test('原文寄存：侧路记下 shaped→original，且只写不读（不可能回灌）', async () => {
  caseNo += 1
  const origPath = join(TMP, `orig-${caseNo}.jsonl`)
  rmSync(origPath, { force: true })
  const { createOriginalsStore, OPS: OpsTable } = await import('../index.js')
  const store = createOriginalsStore({ originals: { path: origPath, enabled: true } }, () => {})
  const long = `${'Exploring options. '.repeat(40)}I will patch a.txt now.`
  const shaped = OpsTable.extract(long, { op: 'extract', maxChars: 240 })
  store.put(shaped, long)
  assert.ok(existsSync(origPath), '寄存表必须落盘')
  assert.equal(store.get(shaped), long, '能按 shaped 文本取回原文（单射）')
  assert.equal(store.get('不存在的文本'), undefined, '查不到就返回 undefined')
})

test('原文寄存：换轮即清空（防硬盘随会话线性增长）', async () => {
  caseNo += 1
  const origPath = join(TMP, `orig-turn-${caseNo}.jsonl`)
  rmSync(origPath, { force: true })
  const { createOriginalsStore } = await import('../index.js')
  const store = createOriginalsStore({ originals: { path: origPath, enabled: true } }, () => {})
  // 注意：构造时**就会清空一次**（防"进程重启后旧内容永久残留"，实测踩到）。
  // 所以这里用相对基线断言，而不是写死绝对次数。
  const purgedAtStart = store.stats.purged
  assert.equal(purgedAtStart, 1, '构造时必须先清空一次（否则重启后上轮内容会残留）')
  store.beginTurn(1)
  store.put('shaped-A', 'original-A')
  assert.equal(readFileSync(origPath, 'utf8').trim().split('\n').length, 1)
  store.beginTurn(2)   // 换轮 ⇒ 清空
  assert.equal(readFileSync(origPath, 'utf8'), '', '换轮后必须清空')
  assert.equal(store.stats.purged, purgedAtStart + 1, '换轮应恰好再清空一次')
  // 同一轮内不清空
  store.put('shaped-B', 'original-B')
  store.beginTurn(2)
  assert.equal(readFileSync(origPath, 'utf8').trim().split('\n').length, 1, '同一轮不清空')
})

// 回归：wire 级塑形对**同一条旧消息每次请求都会重算** ⇒ 同一 (shaped, original) 会反复到达。
// 不去重就会反复写盘：实测 1039 条里 823 条重复（79%），14 分钟写到 1.1 MB 且持续增长。
test('原文寄存：同一对 (shaped, original) 只写一次（去重，防反复写盘）', async () => {
  caseNo += 1
  const origPath = join(TMP, `orig-dedup-${caseNo}.jsonl`)
  rmSync(origPath, { force: true })
  const { createOriginalsStore } = await import('../index.js')
  const store = createOriginalsStore({ originals: { path: origPath, enabled: true } }, () => {})
  store.beginTurn(1)
  for (let i = 0; i < 50; i++) store.put('same-shaped', 'same-original')
  assert.equal(readFileSync(origPath, 'utf8').trim().split('\n').length, 1, '重复不得重复写盘')
  assert.equal(store.stats.stored, 1)
  assert.equal(store.stats.deduped, 49, '其余 49 次应记为去重')
  // 不同的 shaped 仍要写
  store.put('other-shaped', 'other-original')
  assert.equal(readFileSync(origPath, 'utf8').trim().split('\n').length, 2)
})

// 回归：即使去重失效（极端情况），也不能无限增长 —— 必须有大小兜底。
test('原文寄存：超过 maxBytes 自动清空（最后一道防线）', async () => {
  caseNo += 1
  const origPath = join(TMP, `orig-cap-${caseNo}.jsonl`)
  rmSync(origPath, { force: true })
  const { createOriginalsStore } = await import('../index.js')
  const store = createOriginalsStore({ originals: { path: origPath, enabled: true, maxBytes: 4096 } }, () => {})
  store.beginTurn(1)
  for (let i = 0; i < 60; i++) store.put(`shaped-${i}`, 'x'.repeat(400))
  const size = readFileSync(origPath, 'utf8').length
  assert.ok(store.stats.capped > 0, '应触发过兜底清空')
  assert.ok(size < 4096 * 3, `文件应被兜底压住（实得 ${size}）`)
})

test('原文寄存：默认关闭时完全不写盘', async () => {
  caseNo += 1
  const origPath = join(TMP, `orig-off-${caseNo}.jsonl`)
  rmSync(origPath, { force: true })
  const { createOriginalsStore } = await import('../index.js')
  const store = createOriginalsStore({ originals: { path: origPath, enabled: false } }, () => {})
  store.beginTurn(1)
  store.put('a', 'b')
  assert.equal(existsSync(origPath), false, '关掉就不该产生文件')
})

test('原文寄存：运行时接上（走**真实的 llm/stream** 路径也要记）', async () => {
  // ⚠️ 必须走 llm/stream。`setup()` 为了覆盖那段代码默认打开了 `surfaceAssistant: true`，
  // 但那条路对 assistant/message 是**已知不可用**的（校验器冲突，默认关闭）；
  // 用它测"运行时是否记寄存表"会得到"事件被拒 ⇒ 什么都没记"的假阴性。
  // 推理的真实路径是 llm/stream 中间件。
  caseNo += 1
  const origPath = join(TMP, `orig-rt-${caseNo}.jsonl`)
  rmSync(origPath, { force: true })
  const logPath = join(TMP, `orig-rt-${caseNo}.log`)
  rmSync(logPath, { force: true })
  const listeners = []
  const ctx = { on: (n, h) => { listeners.push({ n, h }); return () => {} } }
  apply(ctx, {
    logPath,
    offSentinel: join(TMP, `orig-rt-${caseNo}.OFF`),
    configPath: join(TMP, `orig-rt-${caseNo}.cfg.json`),
    cache: { enabled: false },
    originals: { enabled: true, path: origPath },
    policy: { reasoning: { ops: [{ op: 'extract', maxChars: 240 }] } },
  })
  const h = listeners.find((l) => l.n === 'llm/stream').h
  assert.ok(h, 'llm/stream 中间件必须已注册')
  const long = `${'Exploring options and weighing tradeoffs. '.repeat(20)}I will patch a.txt now.`
  const src = (async function* () { yield { type: 'reasoning', text: long }; yield { type: 'text', text: 'done' } })()
  const out = []
  for await (const c of h({ provider: 'x' }, () => src)) out.push(c)
  assert.ok(String(out[0].text).length < long.length, '流里的推理应已被塑形')
  assert.ok(existsSync(origPath), '运行时路径也要记寄存表')
  const rec = JSON.parse(readFileSync(origPath, 'utf8').trim().split('\n')[0])
  assert.equal(rec.v, long, '存的必须是**原文**（不是塑形结果）')
  assert.equal(rec.k.length, 64, 'k 是 sha256 十六进制')
})

// ── 运行时路径的缓存判据（公开 API 测不到的那段）──
//
// 回归：`resolveOps` 会把策略里的**内置** op 也解析成 `{...op, __fn: fn}`
// （为了让公开 API `applyOps` 只认内置表）。而 provablyPure 原来写成
// `op.__fn === undefined && PURE_OPS.has(op.op)` ⇒ 运行时路径下 __fn 永远存在
// ⇒ **纯 op 全部被当成非纯 op 缓存**。实测代价：日志被 `op extract 缓存命中` 刷屏
// （当日 34,596 行里 34,583 行是它），缓存文件里堆满可复现的 extract 结果。
//
// 关键：上面「缓存：纯 op 不进缓存」那条用 **applyOps** 直呼（没有 __fn）⇒ 一直是绿的，
// 所以这个 bug 能活下来。判据必须认**实现身份**，用真实运行时的装配来测。
test('缓存：运行时路径下，内置纯 op 也不进缓存（__fn 是"已解析"不是"自定义"）', async () => {
  caseNo += 1
  const cachePath = join(TMP, `rt-cache-${caseNo}.jsonl`)
  rmSync(cachePath, { force: true })
  const { handlers, session } = setup({
    cache: { enabled: true, path: cachePath },
    policy: {
      reasoning: { ops: [{ op: 'extract', maxChars: 240 }] },
      toolResult: { ops: [{ op: 'keep' }] },
      toolArgs: { ops: [{ op: 'keep' }] },
      assistantText: { ops: [{ op: 'keep' }] },
    },
  })
  // 走真实事件入口（插件运行时自己装配 op 上下文与缓存）
  emit(handlers, session, makeEvent())
  await settle()
  emit(handlers, session, makeEvent())
  await settle()
  assert.equal(existsSync(cachePath), false,
    '内置 extract 是可复现纯函数 ⇒ 不该写缓存文件（写了就是 __fn 判据把内置当成了自定义）')
})

test('缓存：运行时路径下，自定义注入的 op 仍然进缓存（不能修过头）', async () => {
  caseNo += 1
  const cachePath = join(TMP, `rt-custom-${caseNo}.jsonl`)
  rmSync(cachePath, { force: true })
  const { handlers, session } = setup({
    cache: { enabled: true, path: cachePath },
    ops: { myOp: (text) => `custom:${text}` },
    policy: {
      reasoning: { ops: [{ op: 'myOp' }] },
      toolResult: { ops: [{ op: 'keep' }] },
      toolArgs: { ops: [{ op: 'keep' }] },
      assistantText: { ops: [{ op: 'keep' }] },
    },
  })
  emit(handlers, session, makeEvent())
  await settle()
  assert.equal(existsSync(cachePath), true,
    '自定义 op 无法证明是纯函数 ⇒ 必须进缓存（否则结果漂移会打断前缀）')
})
