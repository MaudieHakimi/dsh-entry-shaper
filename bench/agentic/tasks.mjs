// 带判分的 agentic 任务集：每个任务 = 初始文件 + 提示 + **确定性检查器**。
//
// 形态借鉴（不直接引用的原因：那些框架都自带 agent，而我们要测的是 DSH 插件对
// payload 的改造效果，必须让"我们自己这套工具回路"当 agent）：
//   * Terminal-Bench —— CLI/文件任务 + 确定性验收（对上 DSH 的 pwsh/文件工具）
//   * tau-bench      —— 多轮工具回路
//   * SWE-bench      —— "跑测试算通过"的判分方式
//
// 每个任务都设计成**需要多轮工具调用**（读文件 → 改 → 跑 → 看错 → 再改），
// 这样"省 token"和"模型性能"两个效果都能被观察到。
//
// 检查器一律是确定性的：跑脚本比输出、跑测试、断言文件内容。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** 探测可用 shell：优先 pwsh（PS7），退回 Windows PowerShell 5.1 / cmd。 */
const SHELL_CANDIDATES = [
  process.env.DSH_BENCH_SHELL,
  'pwsh',
  'powershell',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'cmd',
].filter(Boolean)
let resolvedShell = null
function shellBinary() {
  if (resolvedShell) return resolvedShell
  for (const candidate of SHELL_CANDIDATES) {
    try {
      execFileSync(candidate, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 15000 })
      resolvedShell = candidate
      return candidate
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到可用 shell（可设 DSH_BENCH_SHELL 指定）')
}

const sh = (dir, command, timeoutMs = 20000) => {
  try {
    const bin = shellBinary()
    const args = bin.endsWith('cmd') || bin.endsWith('cmd.exe')
      ? ['/d', '/s', '/c', command]
      : ['-NoProfile', '-NonInteractive', '-Command', command]
    const out = execFileSync(bin, args, {
      cwd: dir, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, out: String(out) }
  } catch (error) {
    return { ok: false, out: String(error?.stdout ?? '') + String(error?.stderr ?? error?.message ?? '') }
  }
}

const write = (dir, rel, content) => {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

/** 每个任务：id / 提示 / setup(dir) / check(dir) -> {ok, detail} */
export const TASKS = [
  {
    id: 'fix-off-by-one',
    title: '修掉循环的 off-by-one',
    prompt: '仓库里 `sum.js` 的 `sumTo(n)` 应当把 1..n 求和，但它的结果总是少加最后一项。'
      + '请读代码、修好它，然后运行 `node -e "const {sumTo}=require(\'./sum.js\'); console.log(sumTo(5))"` 自证输出是 15。',
    setup: (dir) => {
      write(dir, 'sum.js', 'function sumTo(n) {\n  let total = 0\n  for (let i = 1; i < n; i += 1) total += i\n  return total\n}\nmodule.exports = { sumTo }\n')
    },
    check: (dir) => {
      // 用"写校验脚本再跑 + 退出码判分"避免 node -e 的嵌套引号（PS 5.1 下会被打崩）
      write(dir, '_verify.mjs', [
        "import { createRequire } from 'node:module'",
        "const require = createRequire(import.meta.url)",
        "const { sumTo } = require('./sum.js')",
        'const got = [sumTo(5), sumTo(1), sumTo(10)].join(",")',
        'if (got !== "15,1,55") { console.log("期望 15,1,55，得到 " + got); process.exit(1) }',
        'console.log("ok")',
        '',
      ].join('\n'))
      const r = sh(dir, 'node _verify.mjs')
      return { ok: r.ok && r.out.includes('ok'), detail: r.out.trim().slice(0, 160) }
    },
  },
  {
    id: 'fix-parser-test',
    title: '让失败的测试通过',
    prompt: '`parse.js` 解析形如 `key=value;key2=value2` 的配置串，但 `parse.test.js` 里有失败用例。'
      + '请定位并修复解析实现（不要改测试），直到 `node --test` 全部通过。',
    setup: (dir) => {
      write(dir, 'parse.js', 'function parse(input) {\n  const out = {}\n  for (const pair of input.split(";")) {\n    const [k, v] = pair.split("=")\n    out[k] = v\n  }\n  return out\n}\nmodule.exports = { parse }\n')
      write(dir, 'parse.test.js', [
        "const test = require('node:test')",
        "const assert = require('node:assert')",
        "const { parse } = require('./parse.js')",
        '',
        "test('基本解析', () => {",
        "  assert.deepEqual(parse('a=1;b=2'), { a: '1', b: '2' })",
        '})',
        '',
        "test('忽略空段与多余空格', () => {",
        "  assert.deepEqual(parse('a=1;; b = 2 '), { a: '1', b: '2' })",
        '})',
        '',
        "test('只有键没值时给空串', () => {",
        "  assert.deepEqual(parse('a'), { a: '' })",
        '})',
        '',
      ].join('\n'))
    },
    check: (dir) => {
      const r = sh(dir, 'node --test')
      // 退出码即判分（execFileSync 非 0 会抛 ⇒ r.ok=false），输出仅作说明
      const tail = r.out.split('\n').filter((l) => l.trim().startsWith('#')).join(' | ').slice(0, 160)
      return { ok: r.ok, detail: tail || r.out.trim().slice(0, 160) }
    },
  },
  {
    id: 'rename-symbol',
    title: '跨文件重命名符号',
    prompt: '把 `calc.js` 里导出的函数 `calcTotal` 重命名为 `computeTotal`，并更新所有引用它的文件'
      + '（包括 `main.js` 和测试）。改完运行 `node --test` 确认通过，并确认仓库里不再出现旧名字。',
    setup: (dir) => {
      write(dir, 'calc.js', 'function calcTotal(items) {\n  return items.reduce((a, b) => a + b.price * b.qty, 0)\n}\nmodule.exports = { calcTotal }\n')
      write(dir, 'main.js', "const { calcTotal } = require('./calc.js')\nconsole.log(calcTotal([{ price: 3, qty: 2 }]))\n")
      write(dir, 'calc.test.js', [
        "const test = require('node:test')",
        "const assert = require('node:assert')",
        "const { computeTotal } = require('./calc.js')",
        '',
        "test('合计', () => {",
        "  assert.equal(computeTotal([{ price: 3, qty: 2 }, { price: 1, qty: 1 }]), 7)",
        '})',
        '',
      ].join('\n'))
    },
    check: (dir) => {
      const tests = sh(dir, 'node --test')
      // 用 Node 扫残留旧名字，避开 PowerShell 的引号与管道
      write(dir, '_scan.mjs', [
        "import { readdirSync, readFileSync } from 'node:fs'",
        "let hits = 0",
        "for (const f of readdirSync('.')) {",
        "  if (!f.endsWith('.js') || f.startsWith('_')) continue",
        "  if (readFileSync(f, 'utf8').includes('calcTotal')) hits += 1",
        '}',
        'console.log("leftover=" + hits)',
        '',
      ].join('\n'))
      const scan = sh(dir, 'node _scan.mjs')
      const leftovers = Number((scan.out.match(/leftover=(\d+)/) ?? [])[1] ?? '999')
      return { ok: tests.ok && leftovers === 0, detail: `测试:${tests.ok ? '通过' : '失败'} 残留旧名:${leftovers}` }
    },
  },
  {
    id: 'csv-report',
    title: '写脚本产出报告文件',
    prompt: '仓库里有 `sales.csv`（表头 `region,amount`）。请写一个 `report.js`，读它并输出 `report.txt`，'
      + '内容为每个 region 的合计金额、按金额从大到小排序，每行格式 `region=合计`（金额取整数，不要千分位）。'
      + '完成后运行 `node report.js` 生成文件。',
    setup: (dir) => {
      write(dir, 'sales.csv', 'region,amount\nnorth,120\nsouth,80\nnorth,30\neast,50\nsouth,20\n')
    },
    check: (dir) => {
      const r = sh(dir, 'node report.js')
      if (!r.ok && !r.out.includes('')) {
        // 允许脚本已存在但运行失败
      }
      let text = ''
      try { text = readFileSync(join(dir, 'report.txt'), 'utf8') } catch { return { ok: false, detail: 'report.txt 不存在' } }
      const norm = text.replace(/\r/g, '').trim()
      const want = 'north=150\nsouth=100\neast=50'
      return { ok: norm === want, detail: `期望:\n${want}\n得到:\n${norm.slice(0, 200)}` }
    },
  },
  {
    id: 'extract-module',
    title: '抽出一个模块并保持测试通过',
    prompt: '`app.js` 里混着字符串工具函数。请把 `slugify` 抽到新文件 `slug.js` 并导出，'
      + '`app.js` 改为 `require` 它，其他行为不变。改完 `node --test` 必须通过，且 `slug.js` 必须存在。',
    setup: (dir) => {
      write(dir, 'app.js', [
        'function slugify(s) {',
        "  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')",
        '}',
        '',
        'function title(s) {',
        '  return s.trim().split(/\\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")',
        '}',
        '',
        'module.exports = { slugify, title }',
        '',
      ].join('\n'))
      write(dir, 'app.test.js', [
        "const test = require('node:test')",
        "const assert = require('node:assert')",
        "const { slugify, title } = require('./app.js')",
        '',
        "test('slugify', () => { assert.equal(slugify('  Hello World!  '), 'hello-world') })",
        "test('title', () => { assert.equal(title('hello  world'), 'Hello World') })",
        '',
      ].join('\n'))
    },
    check: (dir) => {
      const tests = sh(dir, 'node --test')
      let slug = false
      try { slug = readFileSync(join(dir, 'slug.js'), 'utf8').includes('slugify') } catch { /* 不存在 */ }
      const appUses = (() => { try { return readFileSync(join(dir, 'app.js'), 'utf8').includes("require('./slug.js')") } catch { return false } })()
      return { ok: tests.ok && slug && appUses, detail: `测试:${tests.ok} slug.js:${slug} app.js引用:${appUses}` }
    },
  },
  {
    id: 'cli-flag',
    title: '给脚本加一个命令行开关',
    prompt: '`greet.js` 现在只支持 `node greet.js <名字>`。请加一个 `--shout` 开关：'
      + '带该开关时名字转为大写、并在末尾追加 `!`（例如 `node greet.js ana --shout` 输出 `Hello ANA!`）；'
      + '不带开关时行为不变。改完两种调用都要能跑通。',
    setup: (dir) => {
      write(dir, 'greet.js', "const name = process.argv[2] ?? 'world'\nconsole.log(`Hello ${name}`)\n")
    },
    check: (dir) => {
      const plain = sh(dir, 'node greet.js ana')
      const shout = sh(dir, 'node greet.js ana --shout')
      const okPlain = plain.out.trim() === 'Hello ana'
      const okShout = shout.out.trim() === 'Hello ANA!'
      return { ok: okPlain && okShout, detail: `普通:${JSON.stringify(plain.out.trim())} 开关:${JSON.stringify(shout.out.trim())}` }
    },
  },
  {
    id: 'dedupe-stable',
    title: '修去重逻辑（保持首次出现顺序）',
    prompt: '`dedupe.js` 输出去重后的行，但顺序被打乱了。请改成"保留第一次出现的顺序"，'
      + '并保证相邻重复也被去掉。改完运行 `node dedupe.js` 自证输出与 `expected.txt` 一致。',
    setup: (dir) => {
      write(dir, 'input.txt', 'b\na\nb\nc\na\nd\n')
      write(dir, 'expected.txt', 'b\na\nc\nd\n')
      write(dir, 'dedupe.js', [
        "const fs = require('node:fs')",
        "const lines = fs.readFileSync('input.txt', 'utf8').split(/\\r?\\n/).filter(Boolean)",
        'console.log([...new Set(lines)].sort().join("\\n"))',
        '',
      ].join('\n'))
    },
    check: (dir) => {
      const r = sh(dir, 'node dedupe.js')
      const got = r.out.replace(/\r/g, '').trim()
      const want = readFileSync(join(dir, 'expected.txt'), 'utf8').replace(/\r/g, '').trim()
      return { ok: got === want, detail: `期望:\n${want}\n得到:\n${got}` }
    },
  },
  {
    id: 'fix-async-count',
    title: '修异步计数（等待所有任务）',
    prompt: '`count.js` 并发发起三个延时任务并把结果求和，但现在总是打印 0（没等 Promise）。'
      + '请修好它，运行 `node count.js` 应输出 `6`。',
    setup: (dir) => {
      write(dir, 'count.js', [
        'const delay = (ms, v) => new Promise((resolve) => setTimeout(resolve, ms, v))',
        '',
        'async function main() {',
        '  let total = 0',
        '  for (const v of [1, 2, 3]) {',
        '    delay(5, v).then((x) => { total += x })',
        '  }',
        '  console.log(total)',
        '}',
        '',
        'main()',
        '',
      ].join('\n'))
    },
    check: (dir) => {
      const r = sh(dir, 'node count.js')
      return { ok: r.out.trim() === '6', detail: `得到 ${JSON.stringify(r.out.trim())}` }
    },
  },
]

/** 在工作目录里铺开任务初始文件。 */
export function setupTask(task, dir) {
  mkdirSync(dir, { recursive: true })
  // 关键：任务目录在插件包内，而包是 "type": "module" ⇒ 必须显式声明 commonjs，
  // 否则任务里的 require/module.exports 会被当 ESM 解析并抛 ReferenceError。
  write(dir, 'package.json', '{\n  "type": "commonjs",\n  "private": true\n}\n')
  task.setup(dir)
}

/** 供 runner 复用的 shell 执行器（限定在任务目录、带超时与输出截断）。 */
export function runShell(dir, command, timeoutMs = 30000) {
  const r = sh(dir, command, timeoutMs)
  const text = r.out.length > 8000 ? `${r.out.slice(0, 8000)}\n…（输出被截断）` : r.out
  return { ok: r.ok, text: text.trim() || '(无输出)' }
}

export const readFileIn = (dir, rel) => readFileSync(join(dir, rel), 'utf8')
export const writeFileIn = (dir, rel, content) => write(dir, rel, content)
