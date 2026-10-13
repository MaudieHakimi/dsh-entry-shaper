# 示例：确定性"多样填充词"替换

> 这是 README [§ 最有价值的方向](../README.md#-最有价值的方向把你的算法接进来) 里提到的
> **研究方向原型**。它演示"怎么把自定义算法接进来"，**不是一个已验证有效的默认策略** ——
> 有效性取决于下面 §3 那个尚未做的三臂对照实验。

## 1. 要解决什么

内置 `extract` 保留的句子高度单调（实测 8801 句）：

| 开头 | 占比 |
|---|---|
| `let me` | **64.0%** |
| `(中文/其它)` | 9.2% |
| `i need` | 3.5% |
| `now i` | 2.4% |

Top3 合计 **76.7%**，归一化熵仅 **0.324**（1 = 均匀）。

有一条研究线索认为**重复**本身会形成注意力汇聚（attention sink），
见 [*Interpreting the Repeated Token Phenomenon in Large Language Models*](http://export.arxiv.org/pdf/2503.08908)。
若该机制在这里成立，那么**把这些单调开头替换成语义等效的多样变体**就能缓解。

## 2. 硬约束：必须确定性

这是**唯一不能违反**的一条：

```
wire 级塑形对同一条旧消息**每次请求都会重算**
  ⇒ 若变体选择是随机的（或用了计数器）
  ⇒ 同一条消息两次出网形态不同
  ⇒ 前缀改变 ⇒ 缓存全灭 ⇒ 付断点税（一次几毛）
```

⇒ **变体只能由内容哈希选**。这样"同一输入 → 同一变体"恒定成立，前缀保持单调。

### ⚠️ 先说一个实测坑：`inline.code` 里**没有 `require`**

`inline.code` 的实现是 `new Function('text', 'op', 'ctx', 你的函数体)`（`index.js:82`）
⇒ **没有模块作用域**。实测：

| 在函数体里 | 结果 |
|---|---|
| `typeof require` | `undefined` ✗ |
| `require('node:crypto')` | `Error: require is not defined` ✗ |
| `typeof globalThis.crypto` | `object`（但 `subtle` 是**异步**的 ⇒ 同步函数体里用不了）✗ |
| `typeof Buffer` | `function` ✓ |
| `text` / `op` / `ctx` | 正常可见 ✓ |

⇒ **要在 `inline.code` 里做哈希，只能用纯字符串算法**（不依赖任何模块）。
下面是**实测可用**的 FNV-1a 版本：

### 实现（`inline.code`，可直接热改）

```jsonc
{
  "policy": {
    "reasoning": {
      "ops": [
        { "op": "extract", "maxChars": 240 },
        { "op": "inline", "use": "code",
          "code": "let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)>>>0}const V=['Let me','I will','Next,','Now I','I should','Going to','Time to','Then I'];return text.replace(/^Let me\\b/,V[h%V.length])" }
      ]
    }
  }
}
```

实测：确定性 ✓（同输入恒同输出）；1000 条不同输入 → 8 个变体各约 125 次（均匀）✓

### 需要真哈希时：`exec` 子进程

若你想要 `sha256` 而不是 FNV-1a（分布质量更好，且与插件自身的哈希口径一致），
用 `exec` 起一个 node 脚本：

```js
// diversifier.mjs —— 用法：{ "op":"exec", "command":"node", "script":"D:/tools/diversifier.mjs" }
import { createHash } from 'node:crypto'

const VARIANTS = ['Let me', 'I will', 'Next,', 'Now I', 'I should', 'Going to', 'Time to', 'Then I']

// 统一协议 v1：stdin 一行信封 JSON；stdout 返回 { text } 或裸文本
let raw = ''
for await (const c of process.stdin) raw += c
const env = JSON.parse(raw)
const text = String(env.text ?? '')

const h = createHash('sha256').update(text).digest()
const pick = VARIANTS[h.readUInt32BE(0) % VARIANTS.length]
process.stdout.write(JSON.stringify({ text: text.replace(/^Let me\b/, pick) }))
```

## 3. 实测（原型层面）

```
确定性：同一输入 4/4 次得到同一变体 ✓
分布：1000 条不同输入 → 8 个变体占 10.6% ~ 14.3%（均匀）
熵：0.00 bits（全部 Let me） → 2.99 bits（最大 3.00）
```

## 4. ⚠️ 它**没有**解决什么（必须知道）

替换只改变了**表述**，没有改变**信息量**：

```
"Let me check the config file."     ← 原文（意图句，信息量≈0）
"Next, check the config file."      ← 替换后（信息量**同样**≈0）
```

所以它**只在"重复是病因"这个假设下才有意义**。若是"空转是病因"，那这只是
**把噪音换了件衣服** ✗

### 区分两种病因的实验（三臂对照）

同一任务各跑 N 次，只改上下文里推理的形态：

| 臂 | 上下文里的推理 |
|---|---|
| **A** | 原样（`Let me` 单调，即当前行为） |
| **B** | 多样填充（本原型） |
| **C** | 剥离填充（`check the config file.`，无主语框架） |

观测：① 任务成功率 / 步数 ② 上下文里意图句占比 ③ 是否出现重复退化

```
B ≈ A 且 C 更好  ⇒ 乙成立（空转致病）⇒ 该删，不该换衣服
B > A 且 C ≈ A  ⇒ 甲成立（重复致病）⇒ 多样性确实有用
```

**本仓库尚未做这个实验**，所以本示例只是"能接进来"的演示，
**不构成"该这么做"的建议**。

## 5. 与其它 op 链式组合

```jsonc
"ops": [
  { "op": "extract", "maxChars": 240 },     // 先抽决策句
  { "op": "exec", "command": "node", "script": "D:/tools/diversifier.mjs" }  // 再多样化
]
```

链式组合的通用性质（确定性、逐 op 超时、fail-open、逐 op 覆盖）都照旧生效，
见 [README § 链式组合](../README.md#链式组合七条性质全部实测)。

## 6. 复现

```powershell
cd 'D:\DSH Desktop\.research'
node check-monotony.mjs    # 量"单调"（64% / 熵 0.324）
node check-variants.mjs    # 原型：确定性 + 分布 + 熵
```
