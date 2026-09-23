# 贡献指南

## 开发环境

- Node.js ≥ 20（用到 `structuredClone`、`Array.prototype.at`、`node:zlib` zstd 无关）
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

## 本地验证清单（发版前）

```powershell
node --check index.js
node test/run-all.mjs
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"   # 元文件可解析
node -e "console.log(require('./index.js') ? 'exports ok' : '')"          # 可 import
```

另外确认：`cordis.patch.yml` 仍是**纯 insert**（无 `config:`/表达式）；
`package.json` 的 `dsh.bundle.patch` 仍指向它（否则整棵插件树挂载失败）。

## 提交规范

- 提交信息用中文或英文均可，但需说明**动机 + 依据**（引用源码位置或实测数据）；
- 涉及行为变更的提交请同时更新 `CHANGELOG.md`；
- 新增/修改行为必须带测试：`test/` 下的用例不依赖 DSH 运行时（用假 `ctx`/`session` 驱动）。

## 许可

贡献即表示同意以 [MIT](LICENSE) 授权。
