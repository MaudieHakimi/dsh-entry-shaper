// 自测：入口塑造的核心行为（不依赖 DSH 运行时，用假 ctx/session 驱动）。
//
// 运行：node test/run-all.mjs      （本机沙箱下 `node --test` 会挂，故用同进程聚合器）
//      CI 里：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, applyOps, extractReasoning } from '../index.js'

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
  apply(ctx, { logPath, offSentinel: sentinel, ...config })
  return { handlers, appends, session, logPath, sentinel, ctx }
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

test('订阅：注册 session/event 且带 global 标记', () => {
  const { handlers } = setup()
  assert.equal(handlers.length, 1)
  assert.equal(handlers[0].eventName, 'session/event')
  assert.deepEqual(handlers[0].opts, { global: true })
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

test('链式 op：extract → truncate 依次生效', () => {
  const text = `${'Exploring many options. '.repeat(20)}I will patch parse.js now.`
  const out = applyOps(text, [{ op: 'extract', maxChars: 500 }, { op: 'truncate', maxChars: 60 }])
  assert.ok(out.length <= 90, `链后应被截断（实得 ${out.length}）`)
  assert.ok(out.includes('省略'), 'truncate 留下省略标记')
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

test('未知 op 被跳过（fail-open）', () => {
  assert.equal(applyOps('hello', [{ op: 'no-such-op' }, { op: 'stub' }]), '[reasoning omitted: 5 chars]')
  assert.equal(applyOps('hello', [{ op: 'drop' }]), null)
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
