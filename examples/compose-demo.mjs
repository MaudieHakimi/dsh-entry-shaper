// 演示「线性可组合性」的七个性质，全部真跑（含真实子进程）。
// 用法: node examples/compose-demo.mjs   （需要本机能跑 python；失败会 fail-open 跳过该 op）
import { applyOps, createOpCache } from '../index.js'
import { writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// `inline.code` 需要编译入口 —— 插件运行时由 apply() 提供；直接调 applyOps 时要自己给。
// （这就是为什么插件里它是 ctx.compileInline：函数从配置的**源码字符串**编译而来。）
const compileInline = (body) => new Function('text', 'op', 'ctx', body)

// ⚠️ 用 fileURLToPath 而不是 `new URL(...).pathname`：后者在带空格的路径上会留下 %20
// 转义（`D:\DSH%20Desktop\…`）⇒ 写文件时 ENOENT。实测踩到。
const TMP = fileURLToPath(new URL('./.compose-demo', import.meta.url))
rmSync(TMP + '.jsonl', { force: true })
writeFileSync(TMP + '.py', `import json, sys
sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")
req = json.loads(sys.stdin.readline())
t = req["text"]
print(json.dumps({"text": t.replace("(py)", "[py]")}, ensure_ascii=False))
`, 'utf8')

const log = (l) => console.log('     [op-log] ' + l)
let httpCalls = 0
const fakeFetch = async (url, init) => {
  httpCalls += 1
  const body = JSON.parse(init.body)
  const input = body.messages.at(-1).content
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: input.replace('(llm)', '[llm]') } }] }) }
}
const cache = createOpCache({ cache: { enabled: true, path: TMP + '.jsonl' } }, log)
const ctx = { kind: 'reasoning', cache, log, fetch: fakeFetch, stubTemplate: '<stub {chars}>', compileInline }

const line = (s) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 60 - s.length)))

line('① 线性：前一个 op 的输出即后一个的输入')
{
  const out = await applyOps('a-b-c', [
    { op: 'inline', use: 'code', code: 'return text.replace(/-/g,"+")' },   // a+b+c
    { op: 'inline', use: 'code', code: 'return text.toUpperCase()' },        // A+B+C
    { op: 'inline', use: 'regex', pattern: '\\+', template: '|' },           // A|B|C
  ], ctx)
  console.log('     a-b-c  ⇒  ' + JSON.stringify(out))
}

line('② 异构：纯函数 + 本地进程 + HTTP + 进程内，任意混排')
{
  const out = await applyOps('原始(py)文本(llm)尾巴', [
    { op: 'head', chars: 100 },                                              // 纯
    { op: 'exec', command: 'python', script: TMP + '.py' },                  // 真子进程
    { op: 'http', baseURL: 'http://x/v1', system: 's' },                     // HTTP（mock fetch）
    { op: 'inline', use: 'regex', pattern: '\\[[a-z]+\\]', template: '' },   // 纯
    { op: 'truncate', maxChars: 20 },                                        // 纯
  ], ctx)
  console.log('     ⇒  ' + JSON.stringify(out))
}

line('③ 逐个 op 的 fail-open：第 2 个失败，其余照常执行')
{
  const out = await applyOps('起点', [
    { op: 'inline', use: 'regex', pattern: '起点', template: 'A' },
    { op: 'exec', command: 'definitely-not-a-command-xyz' },                  // 必失败
    { op: 'inline', use: 'regex', pattern: 'A', template: 'AB' },
    { op: 'inline', use: 'regex', pattern: 'AB', template: 'ABC' },
  ], ctx)
  console.log('     ⇒  ' + JSON.stringify(out) + '   （A→[失败]→AB→ABC，链没断）')
}

line('④ 逐个 op 的超时：慢 op 被跳过，其余照常')
{
  const out = await applyOps('T', [
    { op: 'http', baseURL: 'http://x/v1', timeoutMs: 50 },
    { op: 'inline', use: 'regex', pattern: 'T', template: 'T-ok' },
  ], { ...ctx, fetch: () => new Promise(() => {}) })   // 永不返回
  console.log('     ⇒  ' + JSON.stringify(out))
}

line('⑤ 提前终止：某个 op 返回 null ⇒ 整条链立即结束')
{
  const out = await applyOps('内容', [
    { op: 'stub' },
    { op: 'drop' },                                        // null ⇒ 立即返回
    { op: 'inline', use: 'regex', pattern: '.', template: '不应出现' },
  ], ctx)
  console.log('     ⇒  ' + JSON.stringify(out))
}

line('⑥ 逐个 op 的缓存：纯 op 不缓存，exec/http 缓存')
{
  httpCalls = 0
  const ops = [{ op: 'extract', maxChars: 50 }, { op: 'http', baseURL: 'http://x/v1', system: 's2' }]
  const a = await applyOps('探索一下(py)。我要做甲。', ops, ctx)
  const b = await applyOps('探索一下(py)。我要做甲。', ops, ctx)
  console.log('     第一次 ⇒ ' + JSON.stringify(a))
  console.log('     第二次 ⇒ ' + JSON.stringify(b) + '（逐字节相同）')
  console.log('     HTTP 真实调用次数 = ' + httpCalls + '（第一次 1 次，第二次命中缓存 ⇒ 仍为 1）')
  console.log('     ⇒ 这就是"前缀稳定"的根据：多次出网形态恒定')
}

line('⑦ 逐 op 覆写：同一 op 在不同位置用不同参数')
{
  const out = await applyOps('一二三四五六七八九十', [
    { op: 'head', chars: 6 },            // 一二三四五六
    { op: 'tail', chars: 3 },            // 四五六
    { op: 'truncate', maxChars: 30 },
  ], ctx)
  console.log('     ⇒  ' + JSON.stringify(out))
}

rmSync(TMP + '.jsonl', { force: true })
rmSync(TMP + '.py', { force: true })
