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
   会付断点税——那是另一个插件的领域（`dsh-context-slimmer`）。
3. **新增 op** 请先读 `docs/PROCESSING.md`：op 目录、`shaper` 槽位协议、里程碑与风险序。

## 提交规范

- 提交信息用中文或英文均可，但需说明**动机 + 依据**（引用源码位置或实测数据）；
- 涉及行为变更的提交请同时更新 `CHANGELOG.md`；
- 新增/修改行为必须带测试：`test/` 下的用例不依赖 DSH 运行时（用假 `ctx`/`session` 驱动）。

## 许可

贡献即表示同意以 [MIT](LICENSE) 授权。
