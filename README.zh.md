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
| **亲密度** | 真实对话才涨（0.2/轮），阶段 陌生→熟悉→亲密→依赖（上限 1000） |
| **真实活动** | 今天干了什么（聊天/游戏/B站/主动找你），带想法（thought）字段 |
| **自我认知** | 每天 22:00 演化一次（"我发现自己开始用本澜自称了"） |
| **日记** | 每天 23:00 基于当天记忆生成第一人称日记 |
| **B 站** | 刷视频、看懂视频、发评论、发说说（可选，需要 bili-cli） |
| **表情包** | 按情绪/关键词找图，自动收集用户常发的图 |
| **便签/任务** | 她自己记便签、给你派活、标记完成 |
| **睡眠巩固** | 每晚 LLM 整理当天记忆，生成叙述 |

## 架构

```
DSH（插件 index.mjs）
  ├─ 人格注入（每轮必带）
  ├─ 记忆检索（相关性触发）
  ├─ 设置页签（6 个 tab：记忆服务/人格设定/表情包/主动消息/B站/记忆）
  └─ 工具（13 个：记便签/派任务/找表情/刷B站...）

记忆服务（Python，server.py，独立进程）
  ├─ SQLite（memories.db）
  ├─ LLM 抽取（记忆/情绪/活动）
  ├─ 向量检索（可选，BM25 兜底）
  └─ HTTP API（8080 默认）
```

**两个独立进程**：DSH 插件只管注入和工具，记忆全在服务端。

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

装好后 DSH 设置里多出 **6 个页签**：

| 页签 | 内容 |
|---|---|
| **记忆服务** | LLM key、模型、抽取开关 |
| **人格设定** | 角色卡、用户画像 |
| **鲸鱼日记本** | 她现在/自我认知/时间线（已并入记忆） |
| **表情包** | 图库 + 编辑 |
| **主动消息** | 唤醒动作编辑器 |
| **B 站** | 登录、启用、工具白名单、浏览节奏 |
| **记忆** | L0-L4 + 情感 + 活动 + 见闻 + 便签 + 她状态 |

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
