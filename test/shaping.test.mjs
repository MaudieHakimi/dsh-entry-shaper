// 自测：入口塑造的核心行为（不依赖 DSH 运行时，用假 ctx/session 驱动）。
//
// 运行：node test/run-all.mjs      （本机沙箱下 `node --test` 会挂，故用同进程聚合器）
//      CI 里：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

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
  const content = over.content ?? [
    { type: 'reasoning', text: 'think think think' },
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

test('定型：摘掉 reasoning，保留 text/tool-call，provenance 原样沿用', async () => {
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
  assert.deepEqual(data.message.content.map((b) => b.type), ['text', 'tool-call'])
  assert.equal(data.message.content[1].arguments, '{"path":"a.txt"}', 'tool-call 原样保留')
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

test('纯 reasoning 消息：补空 text 块（官方要求 content 或 tool_calls 至少一个）', async () => {
  const { handlers, appends, session } = setup()
  emit(handlers, session, makeEvent({ content: undefined, data: { message: { content: [{ type: 'reasoning', text: 'only thinking' }] } } }))
  await settle()
  assert.deepEqual(appends[0][1].message.content, [{ type: 'text', text: '' }])
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
