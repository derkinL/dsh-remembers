# dsh-remembers

> **她记得。想不起的时候，她会说想不起。**

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 做的**人格 + 记忆二合一**插件，为情感陪伴场景设计——不是给代码助手用的。

```
用户：哎
她：[想起 3 个月前那通凌晨两点的电话] ……还在想那天的事。
```

不是"检索到相关文档"，是"她记得你说过什么"。
人格和记忆共用同一个服务：**人格每轮必带，记忆检索着加**。

---

## 功能

| 类别 | 能力 |
|---|---|
| **分层记忆** | L0 原话 → L1 事实 → L2 画像 → L3 事件 → L4 里程碑，自动抽取 + 定时巩固 |
| **人格注入** | 人格卡 + 用户画像 + 当前状态（心情/亲密度/阶段/在干嘛/天气/游戏分）每轮注入 |
| **情绪双轴** | valence/arousal + 情绪日志，记录每次对话的情绪变化 |
| **亲密度** | 真实对话才涨（0.2/轮），阶段 陌生(0-199)→熟悉(200-499)→亲密(500-799)→依赖(800-1000) |
| **真实活动** | 今天干了什么（聊天/游戏/B站/主动找你），带想法（thought）字段 |
| **自我认知** | 每天 22:00 注入提醒，她自己反思（"我发现自己开始用本澜自称了"） |
| **日记** | 每天 23:00 注入提醒，她自己写（有她的口气） |
| **B 站** | 刷视频、看懂视频、发评论、发说说（可选，需要 bili-cli） |
| **表情包** | 按情绪/关键词找图，自动收集用户常发的图 |
| **便签/任务** | 她自己记便签、给你派活、标记完成 |
| **睡眠巩固** | 每晚 LLM 整理当天记忆，生成叙述 |
| **学说话 / 语料库** | 内置 1020 条默认语料（分类/意思/用法/场景/能否收尾，可增删改查）+ 她自己从聊天和评论区学来的说法 |
| **口音档案** | 三天一次，用学到且反复出现（≥3 次）的说法归纳成一段口音，常驻人格；不每轮变，缓存友好 |
| **贴吧** | 逛吧、读帖、回帖（回帖时给几句真实说法当参考） |
| **人味后处理** | `tone_fix` 工具：压重复标点、破折号换逗号、可选句尾尾巴；纯规则、不调模型 |

## 学说话怎么工作

```
B 站热评 / 贴吧 / 私聊群聊
   ↓ 抽取（子 AI，只摘原句，不做抽象）
候选池（status=candidate，hits=1）
   ↓ 每三天，子 AI 过一遍所有候选
   · 判「不是说话方式」→ rejected（永久丢弃）
   · 判「是」→ 给 canon（归一说法）+ tag（分类）+ scene（场景词）+ 意思 + 怎么用 + 能否收尾
   ↓ canon 出现 ≥3 次（相似说法会被归到同一个 canon）
转正（status=active）
   ↓ 每三天（或手动「立即重写」）
子 AI 归纳成 200 字「口音档案」→ 写进人格【我的口音】，三天内不变
```

**为什么不是每轮注入例子**：系统提示词是 prompt cache 的最顶层前缀，每轮变会把整段历史缓存打废。
所以口音走「低频重建 + 常驻」，具体例子走工具查：

```
find_phrases({ tag: "破防" })          → 这个分类下已转正的说法
find_phrases({ q: "抢沙发" })          → 按场景查（场景词精确匹配优先）
find_phrases({ tag: "接梗", q: "拉人入坑" })
```

**默认语料**来自 [dsh-fish-tone-flavor](https://github.com/MX3a48c5/dsh-fish-tone)（MIT）：
1000 个梗 + 24 个句式，带意思 / 用法 / 能否收尾 / 语料频次 / 分类；场景词由子 AI 批量补全。
它是**静态数据**，不参与学习打分，也不会被 40 条上限裁掉（`source='seed'`）。

## 人味后处理（`tone_fix`）

纯规则函数，不调模型，同输入同输出：

| 做什么 | 例子 |
|---|---|
| 压重复标点 | `这段有点拖。。` → `这段有点拖。` |
| 压感叹/问号 | `好！！！！` → `好！`；`为什么？？？？？` → `为什么？？？` |
| 破折号换逗号 | `配乐不错——就是后面有点拖` → `配乐不错，就是后面有点拖` |
| 句尾尾巴（可选） | `cute`：呀/嘛/啦/哟/哦/呢；`abstract`：典/绝了/离谱/这很难评/就这 |

只挑**判断句**下手（含"有点/挺/太/真的/感觉/觉得/拖/尬"），整段最多一处；
代码块、表格、引用、列表、行内代码、URL、数字结尾一律不动。

## 架构

```
DSH（插件 index.mjs）
  ├─ 人格注入（每轮必带）
  ├─ 记忆检索（相关性触发）
  ├─ 侧栏入口「她的记忆」（9 张卡片：记忆/人格/表情包/主动消息/B站/贴吧/QQ/学说话/服务）
  └─ 工具（20+ 个：记便签/派任务/找表情/刷B站/逛贴吧/查语料/顺一遍话...）

记忆服务（Python，server.py，独立进程）
  ├─ SQLite（memories.db）
  ├─ LLM 抽取（记忆/情绪/活动）
  ├─ 向量检索（可选，BM25 兜底）
  └─ HTTP API（8080 默认）
```

**两个独立进程**：DSH 插件只管注入和工具，记忆全在服务端。

## 调度器（内置，跨平台）

服务端自带调度线程，**不依赖 cron**（Windows/Linux 通用）。

| 时间 | 任务 | 方式 |
|---|---|---|
| 8-23 点 | **主动唤醒**（间隔 30-180 分钟随机） | 注入提示，让模型自己醒 |
| 8-23 点 | **B 站浏览**（每天 ≤3 次） | 注入提示 |
| 22:00 | **自我认知演化** | 注入「回头想想这段时间的自己」 |
| 23:00 | **日记** | 注入「该写日记了，记两句今天的事吧」 |

**状态**：`data/scheduler-state.json`（跨平台 JSON，重启不丢）

**为什么是注入而不是直接调**：唤醒/日记/演化都让**模型自己在对话里完成**，才有她的口气和思考链。

**关闭**：`CMEM_SCHEDULER=0`

**QQ 注入**：`CMEM_INJECT_PATH=/path/to/qq-inject.jsonl`（没有 QQ 通道时只记日志不注入）

### Linux 上保留的 cron（可选）

内置调度只管「唤醒/B站/演化/日记」。这几个还在 cron：

| 脚本 | 作用 |
|---|---|
| `write-diary.sh`（23:30） | 睡眠巩固 |
| `habits.sh`（每分钟） | 习惯（等饭/午饭等状态） |
| `sync-bili.sh`（每分钟） | B 站日志同步进记忆 |

**Windows 上这三个没有**——不影响核心记忆功能。

## 兼容性

| 项 | 要求 |
|---|---|
| **Windows** | ✅ **支持**（install.ps1） |
| **Linux** | ✅ 支持（install.sh + systemd） |
| **Node.js** | >= 22.19 或 >= 24 |
| **Python** | >= 3.10（服务端） |
| **DSH** | 0.2.x（rc.2+） |
| **内存** | >= 512 MB |
| **依赖** | 只有 numpy（服务端） |
| **LLM** | **必须有**（DeepSeek 或其他 OpenAI 兼容） |

## 安装（Windows）

**前置**：Node.js >= 22.19、Python >= 3.10、DSH 已装

```powershell
# 1. 克隆
git clone https://github.com/derkinL/dsh-remembers
cd dsh-remembers

# 2. 一键安装（PowerShell）
.\install.ps1

# 或者指定 profile
.\install.ps1 -Profile desktop
```

脚本会：
1. 检查 Node/Python 版本
2. 把插件复制到 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-remembers`
3. 写 `cordis.patch.yml` 注册插件
4. 建 venv + 装 numpy
5. 启动记忆服务（后台）
6. 创建开机自启任务计划

**装完要做**：
1. 填 LLM key（`service\.env.win` 里的 `CMEM_LLM_KEY`）
2. 重启 DSH
3. 设置 → 记忆服务 → 填 API Key 和模型

## 安装（Linux）

```bash
git clone https://github.com/derkinL/dsh-remembers
cd dsh-remembers
bash install.sh                    # 装到 web profile
DSH_PROFILE=desktop bash install.sh
bash install.sh --no-service       # 只装插件
```

Linux 版用 **systemd** 守护服务端（install.sh 会自动配）。

## 两套实例（双人格）

想跑两个 AI 人格，需要**两个服务端 + 两个数据目录**：

```bash
# 主套
CMEM_DATA_DIR=/path/data CMEM_PORT=8081 python server.py

# 第二套
CMEM_DATA_DIR=/path/data2 CMEM_PORT=8082 python server.py
```

插件侧用 `config.endpoint` 指向对应端口。

## 配置

### LLM Key（必须）

```bash
# Linux: service/.env
# Windows: service/.env.win
CMEM_LLM_KEY=sk-xxxxxxxx
CMEM_LLM_BASE=https://api.deepseek.com
CMEM_LLM_MODEL=deepseek-chat
```

### 数据目录

```
CMEM_DATA_DIR=/path/to/data     # 默认 service/data
```

里面存：`memories.db`（记忆）、`config.json`（配置）、`proactive.json`（主动消息）、`bili_tools.json`（B站白名单）。

### 其他环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CMEM_PORT` | 8080 | 服务端口 |
| `CMEM_HOST` | 0.0.0.0 | 监听地址（建议 127.0.0.1） |
| `CMEM_EXTRACT` | 1 | 自动抽取开关 |
| `CMEM_MEME_DIR` | - | 表情包目录 |
| `CMEM_EMBED_*` | - | 向量检索（可选） |

## 设置页

装好后左边栏「插件」下面多一条 **「她的记忆」** 入口（心形图标，排在插件和自动化任务之间）：点开是 7 张卡片，点哪张进哪块面板，左上角「← 她的记忆」退回。

| 卡片 | 内容 |
|---|---|
| **记忆** | L0-L4 + 情感 + 活动 + 见闻 + 便签 + 她状态 |
| **人格设定** | 角色卡、用户画像、自我认知 |
| **表情包** | 图库 + 编辑 |
| **主动消息** | 唤醒动作编辑器 |
| **B 站** | 登录、启用、工具白名单、浏览节奏 |
| **QQ 通道** | 桥、会话、权限 |
| **记忆服务** | LLM key、模型、抽取开关 |

## 常见问题

**Q: 记忆不生成？**
A: 检查 LLM key（设置 → 记忆服务），看服务端日志有没有报错。

**Q: 插件加载失败 "cannot get property without inject"？**
A: DSH 版本太新/太旧，插件用的是 `ctx.get("slots")` 这种软获取——升级 DSH 到 0.2.x。

**Q: Windows 上服务端起不来？**
A: 看 `service\.venv-win\Scripts\python.exe server.py` 前台跑，看报错。

**Q: B 站不工作？**
A: 需要 bili-cli（Linux 脚本），Windows 上可能不兼容——B 站是可选功能。

**Q: 能跑多个 AI 人格吗？**
A: 能，每个实例一套服务端 + 数据目录 + profile。

## 许可

MIT

---

## 对 dsh-onebot-qq 的本地补丁（插件升级会覆盖，需重打）

下面两处改的不是本仓库的代码，而是第三方插件 `dsh-onebot-qq`（0.9.x）的 `lib/outbound.js`。
**插件一升级就会被覆盖**，升级后要重新打一遍，否则颜文字又会发不出去。

### 1. `stripActions()` 保留颜文字

原实现把括号内容一律删掉：

```js
.replace(/（[^）]{0,120}）/g, '')
.replace(/【[^】]{0,120}】/g, '')
.replace(/\([^)]{0,120}\)/g, '')    // 颜文字也是这种
```

这个函数本意是删「旁白 / 动作」（`（尾巴一甩）`、`(smiles)`），但颜文字 `(￣▽￣)` 同样是半角括号包起来的，于是被一起吃掉。人格里明写着「可以使用文字颜来代表自己的情绪」，结果她说得出来、发不出去。

改成只看括号里面是什么：

```js
const isAction = (inner) => {
    const s = String(inner == null ? '' : inner);
    return /[\u4e00-\u9fa5]/.test(s) || /[A-Za-z]{2,}/.test(s);
};

return text
    .replace(/（([^）]{0,120})）/g, (m, inner) => (isAction(inner) ? '' : m))
    .replace(/【([^】]{0,120})】/g, (m, inner) => (isAction(inner) ? '' : m))
    .replace(/\(([^)]{0,120})\)/g, (m, inner) => (isAction(inner) ? '' : m))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
```

判据（只看括号里面）：

| 括号内 | 判定 | 处理 |
|---|---|---|
| 含汉字（`打了个哈欠`、`尾巴一甩`） | 动作 | 删 |
| 含两个以上英文（`smiles`、`laughs`） | 动作 | 删 |
| 纯符号 / 假名 / 希腊字母 / 单字母 | 颜文字 | **保留** |

> 踩过的坑：正则 `（([^）]{0,120})）` 只有 **一个** 捕获组，回调签名必须是 `(m, inner)`。写成 `(m, _open, inner)` 会参数错位，`inner` 拿到 `undefined`，`isAction` 永远 false，结果一个都删不掉。

### 2. 分句间隔统一 1500ms

```js
const SENTENCE_SPLIT_GAP_MIN_MS = 1500;
const SENTENCE_SPLIT_GAP_MAX_MS = 1500;
```

原来两套实例分别是 1000-1500 / 800-1600，统一成固定 1.5 秒。

### 3. 不许自动开新会话（只有用户发 `/new` 才允许）

**问题**：主套 QQ 私聊每隔几天就分裂出一个新会话窗口。owner 的 `onebot-private-3169341724`
带后缀的会话一度攒到 15 个。

**根因**（`lib/registry.js` 的 `createChat`）：

1. 规范 id `onebot-private-<QQ>` 一旦进了 `retired-sessions.json`（永久黑名单），
   每次拿不到映射就 `freshSessionId()` → `onebot-private-<QQ>-<36进制时间戳>` → 新窗口；
2. 重启瞬间旧进程还攥着写句柄，`resumeChat` 抛 `already owned by an active write handle`，
   旧代码直接 `retireSession()` + 换新 id → 又开一个；
3. `agents.create` 撞日志冲突时同样兜底换新 id。

**修法**：引入 `freshRequested` 标记，**只有 `resetChat()`（用户发 `/new`）会打这个标记**。

| 分支 | 旧行为 | 现在 |
|---|---|---|
| 规范 id 在黑名单 | 换带后缀的新 id | 就地解禁，继续用同一个 id |
| resume 失败（句柄被占） | 退役 + 换新 id | 等 1.5 秒重试，最多 3 次；仍失败也不换 id |
| `agents.create` 失败 | 换新 id 重试 | 直接抛错（不悄悄开新窗口） |
| 被驱逐会话 resume 失败 | 退役 | 保留，按同一 id 继续 |
| `/new` 之后 | 新 id | 新 id（不变） |

```js
const wantFresh = this.freshRequested.has(chatId);
this.freshRequested.delete(chatId);
if (this.isSessionIdBlocked(sessionId) && !wantFresh) {
    this.brokenSessions.delete(sessionId);
    this.retiredSessionIds.delete(sessionId);
    void this.saveRetired();
}
if (wantFresh) sessionId = this.freshSessionId(chatId);
```

> 备份：`lib/registry.js.bak-nonew`。验证：重启 `dsh-web` 后 owner 会话目录仍只有一条，
> 没有新建 `onebot-private-3169341724-*`。
