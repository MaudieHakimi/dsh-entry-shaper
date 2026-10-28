# 发布到 npm

> 面向维护者。读者只需要 `npm i dsh-entry-shaper` 或 `dsh plugin add dsh-entry-shaper`。

## 0. 当前状态

| 项 | 状态 |
|---|---|
| 包名 `dsh-entry-shaper` | **可用**（registry 查询 404）✓ |
| `package.json` 可发布 | ✓（`private` 已移除、`publishConfig.access = public`） |
| `@deepseek-ai/cordis` peer | ✓ 存在于 npm（latest 4.0.5，`^4.0.0` 可匹配） |
| 打包内容 | ✓ 31 文件 / 307.7 KB，无测试与临时文件 |
| tarball 安装验证 | ✓ 已实测：`npm i <tgz>` 后 export 齐全、`extract` 工作正常 |
| npm 登录 | ✗ **未登录**（`npm whoami` → `ENEEDAUTH`） |

⇒ 除**账号登录**外，其余均已就绪。

## 1. 首次发布

```powershell
cd 'D:\DSH Desktop\dsh-entry-shaper'

# ① 登录（浏览器或 token；需要能在 npmjs.com 加 2FA 的话会提示）
npm login

# ② 确认身份与包名
npm whoami
npm view dsh-entry-shaper version      # 应为 404（未占用）

# ③ 预检（prepublishOnly 会自动跑，这里可先手动来一遍）
npm run check
npm test

# ④ 看会打进去什么（务必确认没有多余文件）
npm pack --dry-run

# ⑤ 发布
npm publish
```

发布后核对：

```powershell
npm view dsh-entry-shaper version dist.tarball
```

## 2. 后续版本

```powershell
npm version patch     # 或 minor / major —— 会自动改 package.json 并打 git tag
# 记得同步更新 CHANGELOG.md
git push --follow-tags
npm publish
```

> 版本号纪律：本项目的 `CHANGELOG.md` 已按 Keep a Changelog 维护，
> **`npm version` 的 bump 必须与 CHANGELOG 的新条目一致**。

## 3. 消费者怎么装

```powershell
# 方式一：DSH 插件命令（推荐，会写进 profile 依赖）
dsh plugin --profile web add dsh-entry-shaper

# 方式二：直接 npm
npm i dsh-entry-shaper
```

安装后它就是一个普通 DSH bundle 插件：
`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，该 patch 是**纯 insert**
（顶层只有 `- insert:`，无 `config:` 行）⇒ 市场可以**热挂载**，不需要重启。

## 4. 沙箱/CI 下要注意的两点（实测踩过）

- **npm 缓存目录必须在可写位置**。DSH 的文件沙箱默认只允许写工作区，
  而 npm 默认用 `%LOCALAPPDATA%\npm-cache` ⇒ 会报
  `EPERM ... npm-cache\_cacache\tmp`。解决：`npm <cmd> --cache "<工作区内路径>"`。
- `npm pack` 的产物 `*.tgz` 已加入 `.gitignore`，不要提交。

## 5. 与市场（awesome-dsh-plugin）的关系

两者**互相独立**：

| 渠道 | 作用 | 现状 |
|---|---|---|
| **GitHub 仓库** | 源码、issue、README 的权威位置 | 已有 |
| **市场列表**（curated registry） | 在 DSH 插件市场里被搜到/一键装 | **已收录**（PR #6558 merged 2026-10-17） |
| **npm** | 标准 npm 生态安装渠道 | 包已就绪，待首次 `npm publish` |

市场的 `description` 与 npm 的 `description` 是**两处独立文本**，
市场那条受"逐句对代码核"约束（见 `.research/awesome-submission.md`），
npm 这条可以更技术化 —— 当前两者措辞**有意不同**，改动任一处时不要强行统一。
