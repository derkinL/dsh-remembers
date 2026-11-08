# dsh-remembers

> **她记得。想不起的时候，她会说想不起。**

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 做的**人格 + 记忆**插件，为情感陪伴场景设计——不是给代码助手用的。

```
你：哎
她：[想起 3 个月前那通凌晨两点的电话] ……还在想那天的事。
```

不是「检索到相关文档」，是「她记得你说过什么」。
人格每轮必带，记忆按相关性出现，学说话让她的句子像人说的。

**两部分**：
- DSH 插件（Node）——人格段、记忆召回、21 个工具、左边栏「她的记忆」面板（9 张卡）。
- 记忆服务（Python + SQLite，独立进程）——分层记忆、LLM 抽取、向量/关键词检索、定时调度。

---

## 功能

| 类别 | 能力 | 文档 |
|---|---|---|
| **分层记忆** | L0 原话 → L1 事实 → L2 画像 → L3 事件 → L4 里程碑；BM25 + 向量 + 时间衰减 + 诚实出口 | [memory](docs/features/memory.md) |
| **人格注入** | 身份卡 / 形象 / 主人画像 / 铁律 / 口音，走 systemPrompt 独立段，每轮必带 | [persona](docs/features/persona.md) |
| **学说话 / 语料库** | 内置 1020 条默认语料（分类/场景/意思/用法/能否收尾）+ 从聊天和评论区学来的原句；每 3 天转正一次，归纳成 200 字口音 | [phrases](docs/features/phrases.md) |
| **表情包** | 按情绪/关键词找图、学图、多图库、发送频率（0 / 20% / 50% / 100%） | [memes](docs/features/memes.md) |
| **主动消息** | 内置调度：唤醒 / 刷 B 站 / 逛贴吧 / 写日记 / 自我认知，不依赖 cron | [proactive](docs/features/proactive.md) |
| **贴吧** | 逛吧、读帖、楼中楼、回帖；回帖时给几句「那个吧的人这么说的」当参考 | [tieba](docs/features/tieba.md) |
| **B 站** | 刷视频、看视频（字幕 + 九宫格帧）、发评论 | [bili](docs/features/bili.md) |
| **QQ 通道** | 接第三方 onebot 插件；主动唤醒靠它才真的开口 | [qq](docs/features/qq.md) |
| **设置页** | 12 家厂商的对话/向量模型（带 logo 和常用模型下拉）、密钥脱敏、热生效 | [settings](docs/features/settings.md) |
| **语气后处理** | `tone_fix`：纯规则压标点、破折号换逗号、可选句尾尾巴 | [tone](docs/features/tone.md) |

## 快速开始

前置：**Node.js ≥ 22.19**、**Python ≥ 3.10**、DSH 0.2.x。

### Windows

```powershell
git clone https://github.com/derkinL/dsh-remembers
cd dsh-remembers
.\install.ps1 -Profile desktop
```

### Linux / VPS（推荐）

```bash
git clone https://github.com/derkinL/dsh-remembers
cd dsh-remembers
bash install.sh                      # 默认 web profile
sudo bash service/deploy/deploy-native.sh   # 开机自启 + 崩溃重启（systemd）
```

### 装完三步

1. 填 key：`service/.env`（Windows 是 `service/.env.win`）→ `CMEM_LLM_KEY=sk-xxx`
   —— 或者启动后在「她的记忆 → 记忆服务」里填，热生效。
2. 重启 DSH。
3. 左边栏「插件」下面会出现 **她的记忆**。

不填 key 也能跑：原话会存成 L0，只是不会抽事实、不会写日记。

详细步骤与排错：[Windows](docs/deploy/windows.md) · [Linux/VPS](docs/deploy/linux.md) · [Docker](docs/deploy/docker.md)

## 工作原理

```
用户说话
  ├─ agent/pre-step   画像（一次）→ 发言人说明 → 记忆召回 → 状态块
  ├─ 模型回答
  └─ session/event    写 L0 → 异步抽 L1/L2/L3 → 情绪/亲密度/活动 → 攒够压 episode
```

人格走 `systemPrompt`（稳定，缓存友好），召回和状态走追加消息（每轮会变）。
细节见 [架构](docs/architecture.md)。

## 项目结构

```
dsh-remembers/
├─ index.mjs           主机插件：人格段 / 4 个钩子 / 21 个工具
├─ client.js           浏览器插件：左栏入口 + 9 个面板（单文件，DSH 前端常态）
├─ client.mjs          插件 → 服务的 HTTP 客户端
├─ config.mjs          配置解析（patch config > env > 默认）
├─ cordis.patch.yml    bundle patch（插入插件行 + 自带 custom 预设）
├─ icon.png locale/    插件页图标与文案
├─ tools/
│  ├─ tone.js          纯规则语气后处理
│  └─ tieba/           贴吧 CLI（服务端 subprocess 调用）
├─ service/            记忆服务（Python）
│  ├─ server.py        90+ 个路由 + 配置热重载
│  ├─ memory_core.py   SQLite / BM25 / 向量 / 衰减
│  ├─ extractor.py     LLM 抽取 + 转正
│  ├─ scheduler.py     唤醒 / B站 / 贴吧 / 日记 / 演化
│  ├─ seeds.json       默认语料（随包发布）
│  ├─ schema.sql static/ deploy/
│  └─ data/            运行时数据（gitignore）
├─ tests/              node + python 测试
├─ docs/               架构 / 每个功能一份文件树 / 部署 / 体检报告
├─ ops/                个人 VPS 脚本与第三方补丁（与安装无关）
├─ install.mjs/.sh/.ps1
└─ run_all_tests.sh/.ps1
```

每个功能点对应哪些文件，见 [docs/features/](docs/features/) 里各篇的文件树。

## 配置

两层，互不干扰：

| 层 | 位置 | 谁改 |
|---|---|---|
| 插件 | profile 的 `cordis.patch.yml`、环境变量 `CMEM_*` | 手工 |
| 服务 | `service/data/config.json`（设置页写）、`service/.env` | 设置页 / 安装脚本 |

常用环境变量：`CMEM_PORT`（默认 8080）、`CMEM_HOST`（默认 127.0.0.1）、`CMEM_DATA_DIR`、`CMEM_EXTRACT`、`CMEM_SCHEDULER=0`（关调度）、`CMEM_INJECT_PATH`（QQ 注入文件）。

## 功能可用性（重要）

装完就有的是**记忆 + 人格 + 语料库 + 表情包 + 设置**。下面这些要额外条件，不满足不会崩，只是没效果：

| 功能 | 需要 |
|---|---|
| 记忆抽取 / 日记 / 转正 | LLM key |
| 语义召回 | embedding（不配就 BM25） |
| 主动开口 | QQ 通道（`dsh-onebot-qq` + NapCat） |
| 贴吧 | Node + 贴吧 Cookie（回帖默认关） |
| B 站 | 外部 `bili-cli`，且要改 `server.py` 里两条写死路径 |

完整矩阵：[compatibility](docs/compatibility.md)。

## 测试

```bash
bash run_all_tests.sh        # 或 Windows: .\run_all_tests.ps1
```

5 个 Python 套件（检索/门控/迁移/解析/门槛）+ 3 个 Node 套件（主机注册面、前端 9 页、语气规则）。当前 **8/8 全绿**。

## 已知问题

完整清单在 [体检报告](docs/audit.md)，最值得知道的三条：

1. **B 站/QQ 绑作者环境**：路径写死，别人装完用不了（不影响其他功能）。
2. **没有 QQ 通道时主动唤醒只写日志**，不会真的发消息。
3. **`slang` 表是上一代机制**：仍在写，但没有注入读它（统一走 `expressions`）。

## 许可

MIT。默认语料来自 [dsh-fish-tone-flavor](https://github.com/MX3a48c5/dsh-fish-tone)（MIT），贴吧 CLI 基于 [dsh-tieba-dive](https://github.com/Topkill/tiebaskill)（见 `tools/tieba/LICENSE-tieba-dive`）。
