# 发布到 npm

> 面向维护者。读者只需要 `npm i dsh-entry-shaper` 或 `dsh plugin add dsh-entry-shaper`。

## 0. 当前状态

| 项 | 状态 |
|---|---|
| 包名 `dsh-entry-shaper` | **已发布**（`latest` = 1.1.0，2026-11-08） |
| 维护者 | `maudiehakimi` |
| npm 页面 | https://www.npmjs.com/package/dsh-entry-shaper |
| tarball | https://registry.npmjs.org/dsh-entry-shaper/-/dsh-entry-shaper-1.1.0.tgz |
| 发布校验 | shasum `12e98dd3bf926b272467e9d990cfd5d3b4e01a57`，与本地构建一致 |
| 装机实测 | `npm i dsh-entry-shaper@1.1.0` 后导出齐全，`extract` / `skim` 均正常 |

> 仓库里还挂着一个 `0.0.0-stage` 版本，那是启用「暂存发布」时 npm 自动创建的
> **占位符**（描述为 "Temporary package placeholder for staged publishing"），
> 不是真实代码。它不影响 `latest`，无需处理。

## 1. 发布流程（2FA 环境实测版）

> ⚠️ **必须在真实终端里跑**。npm 的 `lib/utils/auth.js` 开头有：
> ```js
> if (!process.stdin.isTTY || !process.stdout.isTTY) { throw err }
> ```
> 所以在非 TTY（CI、管道、Agent 执行通道）下，npm **直接拒绝任何 OTP 交互** ——
> 既不打浏览器授权，也不读验证码输入，只会一路 `EOTP`。

### 1.1 若账号用 Security Key / Passkey（本仓库的实际情形）

这类账号**没有 6 位数字验证码**，`--otp` 永远不可能成功。正确做法就是让 npm 自己开浏览器：

```powershell
cd 'D:\DSH Desktop\dsh-entry-shaper'
npm publish --cache "D:\DSH Desktop\.npm-cache"
```

1. npm 报 `EOTP` 并**自动打开浏览器**到 `npmjs.com/auth/cli/...`
2. 你在浏览器里做 Security Key 验证
3. npm 从 `doneUrl` 拿到临时 token 后**自动重试发布**，无需手动复制任何东西

发布成功会看到 `npm notice Your package is being processed and may take a few minutes to become available.`
（这是正常的 -- registry 分发有延迟）。

### 1.2 若账号用 TOTP（验证器 App 的 6 位码）

```powershell
npm publish --cache "D:\DSH Desktop\.npm-cache"
# 提示 Enter OTP: 时输入 App 里的 6 位码（30 秒一换，当秒输入即可）
```

### 1.3 想彻底免去 2FA（CI / 频繁发版）

建 **Classic Automation token**（天然绕过 2FA，但不能用于网页登录）：

https://www.npmjs.com/settings/maudiehakimi/tokens → Generate New Token → **Classic** → **Automation**

```powershell
npm config set //registry.npmjs.org/:_authToken <token> --cache "D:\DSH Desktop\.npm-cache"
```

之后再 `npm publish` 就不需要 Security Key 了。

## 2. 发布后校验

```powershell
# ① registry 侧（用 node 直接打，避免 npm 的本地缓存干扰）
node -e "fetch('https://registry.npmjs.org/dsh-entry-shaper').then(r=>r.json()).then(j=>console.log(j['dist-tags'], Object.keys(j.versions)))"

# ② 干净装机（--prefer-online 绕过缓存）
mkdir <临时目录>; cd <临时目录>; npm init -y
npm i dsh-entry-shaper@1.1.0 --cache "D:\DSH Desktop\.npm-cache" --prefer-online
```

> **坑（实测踩到）**：刚发布后立刻 `npm install` 会报 `ETARGET: No matching version found`。
> 这不是发布失败 —— 此时用 `fetch` 直接查 registry 能看到版本已存在、tarball 也能下载。
> 原因是**本地 npm 元数据缓存**仍是发布前的旧包。解法：`npm cache clean --force` 或加 `--prefer-online`。

## 3. 后续版本

```powershell
npm version patch     # 或 minor / major —— 会改 package.json 并打 git tag
# 同步更新 CHANGELOG.md
git push --follow-tags
npm publish --cache "D:\DSH Desktop\.npm-cache"
```

> 版本号纪律：`CHANGELOG.md` 已按 Keep a Changelog 维护，
> **`npm version` 的 bump 必须与 CHANGELOG 的新条目一致**。

## 4. 消费者怎么装

```powershell
# 方式一：DSH 插件命令（推荐，会写进 profile 依赖）
dsh plugin --profile web add dsh-entry-shaper

# 方式二：直接 npm
npm i dsh-entry-shaper
```

安装后它就是一个普通 DSH bundle 插件：
`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，该 patch 是**纯 insert**
（无 `config:` 行）⇒ 市场可以**热挂载**，不需要重启。

## 5. 沙箱/CI 下要注意的两点（实测踩过）

- **npm 缓存目录必须在可写位置**。DSH 的文件沙箱默认只允许写工作区，
  而 npm 默认用 `%LOCALAPPDATA%\npm-cache` ⇒ 会报
  `EPERM ... npm-cache\_cacache\tmp`。解决：`npm <cmd> --cache "<工作区内路径>"`。
- **非 TTY 环境无法完成 2FA**（见 §1 开头）：发布这一步必须在真实终端执行。

## 6. 与市场（awesome-dsh-plugin）的关系

两者**互相独立**：

| 渠道 | 作用 | 现状 |
|---|---|---|
| **GitHub 仓库** | 源码、issue、README 的权威位置 | 已有 |
| **市场列表**（curated registry） | 在 DSH 插件市场里被搜到/一键装 | **已收录**（PR #6558 merged 2026-10-17） |
| **npm** | 标准 npm 生态安装渠道 | **已发布**（1.1.0） |

市场的 `description` 与 npm 的 `description` 是**两处独立文本**，
市场那条受"逐句对代码核"约束（见 `.research/awesome-submission.md`），
npm 这条可以更技术化 —— 当前两者措辞**有意不同**，改动任一处时不要强行统一。
