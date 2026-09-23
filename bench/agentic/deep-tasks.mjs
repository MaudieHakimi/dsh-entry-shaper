// 长轨迹任务：故意设计成需要大量读/改/跑（15~30 轮），并让工具输出体量大，
// 这样"推理在 payload 里的占比"才够高，插件省不省钱才看得出来。
//
// 与 tasks.mjs 同一契约：{ id, title, prompt, setup(dir), check(dir) }。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const SHELL_CANDIDATES = [
  process.env.DSH_BENCH_SHELL, 'pwsh', 'powershell',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'cmd',
].filter(Boolean)
let resolvedShell = null
function shellBinary() {
  if (resolvedShell) return resolvedShell
  for (const c of SHELL_CANDIDATES) {
    try {
      execFileSync(c, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 15000 })
      resolvedShell = c
      return c
    } catch { /* 下一个 */ }
  }
  throw new Error('找不到可用 shell（可设 DSH_BENCH_SHELL）')
}
const sh = (dir, command, timeoutMs = 30000) => {
  try {
    const bin = shellBinary()
    const args = /cmd(\.exe)?$/.test(bin) ? ['/d', '/s', '/c', command] : ['-NoProfile', '-NonInteractive', '-Command', command]
    return { ok: true, out: String(execFileSync(bin, args, { cwd: dir, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })) }
  } catch (e) {
    return { ok: false, out: String(e?.stdout ?? '') + String(e?.stderr ?? e?.message ?? '') }
  }
}
const write = (dir, rel, content) => {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

/** 生成一份 ~150KB 的假服务日志，中间埋一处真正的失败原因。 */
function bigLog() {
  const lines = []
  const levels = ['INFO', 'INFO', 'INFO', 'DEBUG', 'WARN']
  for (let i = 0; i < 1400; i++) {
    const lvl = levels[i % levels.length]
    lines.push(`2026-09-23T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z ${lvl} [worker-${i % 4}] request=${100000 + i} stage=ingest rows=${(i * 37) % 900 + 10} ms=${(i * 13) % 400 + 5}`)
  }
  lines.push('2026-09-23T10:23:41Z ERROR [worker-2] request=100777 stage=transform TypeError: Cannot read properties of undefined (reading \'toFixed\')')
  lines.push('    at transformRow (pipeline/transform.js:14:31)')
  lines.push('    at Object.process (pipeline/transform.js:28:18)')
  lines.push('2026-09-23T10:23:41Z ERROR [worker-2] request=100777 stage=transform batch aborted after 1 failure')
  for (let i = 1400; i < 2600; i++) {
    lines.push(`2026-09-23T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z INFO [worker-${i % 4}] request=${100000 + i} stage=ingest rows=${(i * 29) % 700 + 10} ms=${(i * 7) % 300 + 4} retry=0`)
  }
  return `${lines.join('\n')}\n`
}

export const DEEP_TASKS = [
  {
    id: 'deep-log-hunt',
    title: '从 150KB 日志里定位失败原因并修好',
    prompt: '`logs/service.log` 有约 150KB 的服务日志，其中**只有一处**真正的失败原因。'
      + '请用 grep/Select-String 之类的方式在日志里定位它（注意最后一条 ERROR 的位置和它后面的堆栈），'
      + '然后读 `pipeline/` 下的源码、修改 `pipeline/transform.js` 修好它，'
      + '最后运行 `node --test` 直到全部通过。不要修改测试与日志。',
    setup: (dir) => {
      write(dir, 'logs/service.log', bigLog())
      write(dir, 'pipeline/transform.js', [
        '// 把一行原始数据转成 { id, amountText }',
        'function transformRow(row) {',
        '  const parts = row.split(",")',
        '  const id = Number(parts[0])',
        '  const amount = Number(parts[1])',
        '  // BUG: 当 amount 缺失（parts[1] 为空）时，amount 为 NaN，但下游按数字用',
        '  return { id, amountText: amount.toFixed(2) }',
        '}',
        '',
        'function process(rows) {',
        '  return rows.map((r) => transformRow(r))',
        '}',
        '',
        'module.exports = { transformRow, process }',
        '',
      ].join('\n'))
      write(dir, 'pipeline/index.js', "module.exports = require('./transform.js')\n")
      write(dir, 'pipeline/README.md', '# pipeline\n\n`transform.js` 负责把 CSV 行转成结构化数据。字段缺失时需要给可读的占位值。\n')
      write(dir, 'transform.test.js', [
        "const test = require('node:test')",
        "const assert = require('node:assert')",
        "const { transformRow, process } = require('./pipeline/transform.js')",
        '',
        "test('正常行', () => {",
        "  assert.deepEqual(transformRow('1,12.5'), { id: 1, amountText: '12.50' })",
        '})',
        '',
        "test('金额缺失时不应崩溃，给占位', () => {",
        "  assert.deepEqual(transformRow('2,'), { id: 2, amountText: 'n/a' })",
        '})',
        '',
        "test('整批处理不中断', () => {",
        "  const out = process(['1,1.0', '2,', '3,4.25'])",
        "  assert.equal(out.length, 3)",
        "  assert.equal(out[2].amountText, '4.25')",
        '})',
        '',
      ].join('\n'))
    },
    check: (dir) => {
      const r = sh(dir, 'node --test')
      return { ok: r.ok, detail: r.out.split('\n').filter((l) => l.trim().startsWith('#')).join(' | ').slice(0, 160) }
    },
  },
  {
    id: 'deep-refactor-shared',
    title: '六个模块的去重工具抽成公共模块',
    prompt: '`services/` 下有 6 个模块，各自复制了一份相似的 `normalizeName` 实现（细节略有差异，'
      + '行为以测试为准）。请新建 `services/shared.js` 导出统一实现，并让 6 个模块都改用它，'
      + '`node --test` 必须全绿。注意：不要改动测试文件，也不要改变任何模块的对外行为。',
    setup: (dir) => {
      const variants = [
        "const normalizeName = (s) => s.trim().toLowerCase().replace(/\\s+/g, '-')",
        "function normalizeName(s) { return s.trim().toLowerCase().replace(/\\s+/g, '-') }",
        "const normalizeName = (s) => { return s.trim().toLowerCase().replace(/\\s+/g, '-') }",
        "function normalizeName(s) {\n  return s.trim().toLowerCase().replace(/\\s+/g, '-')\n}",
        "const normalizeName = (s) => s.trim().toLowerCase().replace(/\\s+/g, '-') // dup",
        "const normalizeName = function (s) { return s.trim().toLowerCase().replace(/\\s+/g, '-') }",
      ]
      variants.forEach((impl, i) => {
        write(dir, `services/svc${i + 1}.js`, [
          impl,
          '',
          `function handle(input) {`,
          `  return normalizeName(input) + '-v${i + 1}'`,
          '}',
          '',
          'module.exports = { normalizeName, handle }',
          '',
        ].join('\n'))
      })
      write(dir, 'services.test.js', [
        "const test = require('node:test')",
        "const assert = require('node:assert')",
        ...variants.map((_, i) => `const svc${i + 1} = require('./services/svc${i + 1}.js')`),
        '',
        "test('每个模块的 normalizeName 行为一致', () => {",
        ...variants.map((_, i) => `  assert.equal(svc${i + 1}.normalizeName('  Foo  Bar '), 'foo-bar')`),
        '})',
        '',
        "test('handle 保留各自的版本后缀', () => {",
        ...variants.map((_, i) => `  assert.equal(svc${i + 1}.handle(' A '), 'a-v${i + 1}')`),
        '})',
        '',
        "test('shared 模块存在并被使用', () => {",
        "  const { readFileSync, existsSync } = require('node:fs')",
        "  assert.ok(existsSync('services/shared.js'), 'services/shared.js 应当存在')",
        ...variants.map((_, i) => `  assert.ok(readFileSync('services/svc${i + 1}.js', 'utf8').includes("require('./shared.js')"), 'svc${i + 1} 应改用 shared')`),
        '})',
        '',
      ].join('\n'))
    },
    check: (dir) => {
      const r = sh(dir, 'node --test')
      return { ok: r.ok, detail: r.out.split('\n').filter((l) => l.trim().startsWith('#')).join(' | ').slice(0, 160) }
    },
  },
  {
    id: 'deep-cli-feature',
    title: '给 CLI 补一个子命令并修一个既有 bug',
    prompt: '`cli.js` 支持 `list` 与 `add` 两个子命令，但：① `add` 在金额为 0 时会写坏数据；'
      + '② 缺少 `total` 子命令（应当输出所有条目金额之和，保留两位小数）。'
      + '请修好 ① 并实现 ②，然后运行 `node --test` 直到全绿（测试文件不要改）。',
    setup: (dir) => {
      write(dir, 'store.js', [
        "const items = []",
        'function add(name, amount) {',
        '  // BUG: 用 || 兜底，amount=0 时会被替换成 NaN 处理路径',
        '  const value = amount || undefined',
        '  items.push({ name, amount: Number(value) })',
        '}',
        'function list() { return items.map((i) => `${i.name}=${i.amount}`) }',
        'module.exports = { add, list, items }',
        '',
      ].join('\n'))
      write(dir, 'cli.js', [
        "const { add, list } = require('./store.js')",
        '',
        'const [cmd, ...rest] = process.argv.slice(2)',
        'if (cmd === "list") {',
        '  console.log(list().join("\\n"))',
        '} else if (cmd === "add") {',
        '  add(rest[0], Number(rest[1]))',
        '  console.log("added")',
        '} else {',
        '  console.log("unknown command")',
        '}',
        '',
      ].join('\n'))
      write(dir, 'cli.test.js', [
        "const test = require('node:test')",
        "const assert = require('node:assert')",
        "const { execFileSync } = require('node:child_process')",
        '',
        "const run = (...args) => execFileSync('node', ['cli.js', ...args], { encoding: 'utf8' }).trim()",
        '',
        "test('add 之后 list 能看到', () => {",
        "  run('add', 'coffee', '3')",
        "  assert.ok(run('list').includes('coffee=3'))",
        '})',
        '',
        "test('金额 0 不会被写坏', () => {",
        "  run('add', 'freebie', '0')",
        "  assert.ok(run('list').includes('freebie=0'))",
        '})',
        '',
        "test('total 输出两位小数合计', () => {",
        "  const out = run('total')",
        "  assert.match(out, /^\\d+\\.\\d{2}$/)",
        '})',
        '',
      ].join('\n'))
    },
    check: (dir) => {
      const r = sh(dir, 'node --test')
      return { ok: r.ok, detail: r.out.split('\n').filter((l) => l.trim().startsWith('#')).join(' | ').slice(0, 160) }
    },
  },
]

export function setupDeepTask(task, dir) {
  mkdirSync(dir, { recursive: true })
  write(dir, 'package.json', '{\n  "type": "commonjs",\n  "private": true\n}\n')
  task.setup(dir)
}

export const readDeep = (dir, rel) => readFileSync(join(dir, rel), 'utf8')
