# 贡献指南

## 来源声明

**本仓库的全部源码（`index.js`、测试、基准、文档与工具脚本）完全由 DeepSeek-V4.1-Flash 生成**，
人类负责提需求、做取舍与验收。因此接受贡献时有两条特殊要求：

1. **事实性错误按 bug 处理** —— 文档/注释与代码不符、引用的源码行号过期、实测数字不可复现，
   都请直接开 issue 或提 PR，不要当作"文档小问题"放过（这个项目里最贵的几次坑都是这类）；
2. **改动仍要遵守本文件的规则** —— 尤其是「修复要证伪」与「凡有统计/告警的路径都要有
   读日志文件的用例」两条，它们正是为了防"AI 写出了看起来对、实际没生效的代码"。

## 开发环境

- Node.js ≥ 20（用到 `structuredClone`、`Array.prototype.at`；`tools/` 里读会话日志用到 `node:zlib` 的 zstd）
- 无需构建：插件是纯 ESM，`index.js` 直接可加载
- 无需依赖：`dependencies` 为空，`peerDependencies` 仅声明 `@deepseek-ai/cordis`

## 本地测试

```powershell
node test/run-all.mjs      # 本机（受限沙箱下 `node --test` 会因 spawn 挂住，故用同进程聚合器）
node --test test/          # CI，跑同一批用例
```

## 改动前必读

1. **两条硬约束**（违反会抛错或统计翻倍）：替换事件的 `sourceEventSeqs` 必须原样沿用原事件；
   替换事件不得复制 `usage`。出处见 `README.md`。
2. **时机**：定型只允许发生在"元素首次被回传之前"。任何对**已发送**内容的改写都属于"出口压缩"，
   会付断点税 —— 那是另一个插件的领域（`dsh-context-slimmer`）。
3. **新增 op** 请先读 `docs/PROCESSING.md`：op 目录、协议、里程碑与风险序。
4. **确定性是硬要求**：op 必须是纯函数，或走 `cache`（内容哈希 + 配置指纹）。
   **禁止引入有状态策略**（如"只留最近 k 条"）—— 同一条旧消息在不同出网批次形态不同
   ⇒ 前缀改变 ⇒ 付断点税。这条已经否掉过两个方案（见 `docs/PROCESSING.md` §6）。
5. **转手上游元数据时，`provider` 一律改盖成本路由 id**。`LlmRuntime` 会校验
   `resolved.provider === 本路由 id`（`resolveModel`）与 `model.provider === provider`
   （`listModels`），违反分别抛 `INVALID_MODEL_INFO` 与 `INVALID_CATALOG`；
   后者会让代理**整组从模型选择器消失**（踩过两次，0.9.2 / 0.9.3）。
6. **代理适配器必须是"全成员"的**：运行时调用 `providerInfo` / `providerRetryPolicy` /
   `listModels` / `resolveModel` / `prepareCall` / `stream` **全部**
   （`packages/llm/llm/src/index.ts` 的调用点见注释）。本适配器是普通对象、不继承
   `LlmAdapter` ⇒ 基类的默认实现全都没有（踩过：`providerRetryPolicy is not a function`）。
7. **不要把 `config:` 写进 `cordis.patch.yml`**：那会让市场**无法热挂载**
   （`dshmarket/lib/hot.js:295`）。所有可调项放 `~/.dsh-entry-shaper.config.json`，运行时热读。
8. **新增 op 必须走统一协议**（v1.0.0 起）：op 名只表示**传输方式**（`exec` / `http` / `inline`），
   数据格式由 `protocol` / `use` 决定，**不要**按"这是 .py / 这是 LLM"新增 op 名。
   输入信封 `{ text, kind, meta, op, protocol: 1 }`、返回 `{text}`/`{text:null}`/原文，
   失败只跳过该 op。详见 `docs/PROCESSING.md` §2 与 `examples/custom-op.md`。
9. **纯度的判据是"能否证明"**，不是 op 名：能证明是纯函数的（`keep`/`extract`/…）才免缓存；
   其余（`exec` / `http` / `inline.code` / 注入函数）**一律进缓存**。
   改 `PURE_OPS` 前请先想清楚"结果漂移 ⇒ 前缀改变 ⇒ 付断点税"的代价。
10. **测试必须隔离 `cache.path`**：`DEFAULTS` 指向真实主目录的
    `~/.dsh-entry-shaper.cache.jsonl` ⇒ 不隔离会让用例互相污染、并读到本机真实缓存。
    且 `caseNo` 是模块级计数、每次运行从同一数开始 ⇒ **同名文件要每次强制清除**。
11. **凡是有统计/告警的路径，都要有一条"读日志文件"的用例**。踩过：
    `stats.blocks += reasoning.length` 引用未声明标识符，抛错点在 `session.append` **之后**
    ⇒ 表面行为完全正常，只有统计与护栏告警被静默废掉（61 个用例全都没抓住）。
12. **修复要证伪**：新写的回归用例必须先在"故意修坏的代码"上失败过一次
    （`git stash push -- index.js` 只撤实现、保留测试），否则它可能是一条假测试。

## 本地验证清单（发版前）

```powershell
node --check index.js
node test/run-all.mjs
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"   # 元文件可解析
node -e "import('./index.js').then(m=>console.log(Object.keys(m).sort().join(', ')))"  # 导出面
# patch 仍是纯 insert（可热挂载）。用 dshmarket 自己的解析器判定 ——
# 路径换成你 profile 里的 dshmarket；DSH_HOME 默认是 ~/.dsh
node -e "const p=process.env.DSH_HOME||require('node:os').homedir()+'/.dsh';import('file:///'+p.replace(/\\\\/g,'/')+'/profiles/web/node_modules/dshmarket/lib/hot.js').then(async m=>{const fs=await import('node:fs');console.log(m.parseSimplePatch(fs.readFileSync('./cordis.patch.yml','utf8'))===null?'❌ 不可热挂载':'✅ 纯 insert')})"
```

> 顺带确认：`package.json` 的 `dsh.bundle.patch` 仍指向 `./cordis.patch.yml`
> （否则整棵插件树挂载失败），且**文档里的测试数与版本号已同步**。

## 提交规范

- 提交信息用中文或英文均可，但需说明**动机 + 依据**（引用源码位置或实测数据）；
- 涉及行为变更的提交请同时更新 `CHANGELOG.md`；
- 新增/修改行为必须带测试：`test/` 下的用例不依赖 DSH 运行时（用假 `ctx`/`session` 驱动）。

## 许可

贡献即表示同意以 [MIT](LICENSE) 授权。
