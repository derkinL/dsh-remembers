# 架构

两个进程，一个数据库。插件只管「往提示词里放什么」和「给模型什么工具」，所有记忆都在 Python 服务里。

```
┌──────────────────────── DSH（Node） ────────────────────────┐
│  index.mjs                                                   │
│    ├─ systemPrompt section 「remembers:persona」 ← 每轮必带   │
│    ├─ agent/pre-step  ← 画像 / 发言人 / 记忆召回 / 状态        │
│    ├─ session/event   ← 每轮结束写 L0、抽取、情绪、活动         │
│    ├─ 21 个工具        ← 便签/表情/B站/贴吧/语料/语气           │
│    └─ episode         ← 攒够一轮对话压成 L3                   │
│  client.js（浏览器）                                          │
│    └─ 左栏「她的记忆」：9 张卡片 = 9 个面板，直接 fetch 服务   │
│  client.mjs / config.mjs / tools/tone.js                     │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP（默认 127.0.0.1:8080）
┌──────────────────────────▼──────────────────────────────────┐
│  记忆服务（Python，独立进程，零框架）                          │
│  server.py      ~91 个路由 + 配置热重载 + 静态图               │
│  memory_core.py SQLite + BM25 + 向量余弦 + 时间衰减 + 诚实出口  │
│  extractor.py   LLM 抽事实/说法 + ADD/UPDATE/DELETE/NONE      │
│  scheduler.py   唤醒 / B站 / 贴吧 / 日记 / 自我认知            │
│  embedding.py   OpenAI 兼容 embedding（可选，BM25 兜底）       │
│  llm.py         OpenAI 兼容 chat + 容错 JSON 解析              │
│  surprisal.py   纯文本惊讶度门控（不花钱）                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    service/data/memories.db
                    （SQLite 单文件，备份 = 拷文件）
```

## 一次对话发生了什么

```
用户说话
  │
  ├─ agent/pre-step
  │    ① 画像注入（每个会话一次；L4 里程碑 + L2 画像）
  │    ② 发言人说明（群聊 / 私聊别人时才加，防认错人）
  │    ③ 记忆召回（POST /search，只取「当前场景 + global」）
  │    ④ 状态块（心情/亲密度/在干嘛/天气/她自己的认知）
  │
  ├─ 模型回答
  │
  └─ session/event（turn end）
       ① 写 L0 原话（POST /ingest，短句先过 /surprisal 门控）
       ② 异步 POST /extract → L1/L2/L3 + 学说法
       ③ 情绪 valence/arousal、亲密度、活动日志
       ④ 攒够 40 轮或 120 分钟 → POST /episode 压一条 L3
```

**为什么人格走 systemPrompt、记忆走消息块**：systemPrompt 是 prompt cache 的最顶层前缀，一变整段历史缓存全废。所以稳定内容（人格、口音档案）进 systemPrompt，每轮会变的（召回、状态）作为追加消息。

## 目录

```
dsh-remembers/
├─ index.mjs            主机插件入口（apply + 钩子 + 工具注册）
├─ client.js            浏览器插件（单文件，DSH 前端生态的常规做法）
├─ client.mjs           插件 → 记忆服务的 HTTP 客户端
├─ config.mjs           配置解析（patch config > env > 默认值）
├─ cordis.patch.yml     bundle patch：插入插件行 + 自带 custom 预设
├─ icon.png             插件页图标
├─ locale/              插件页标题/描述（zh, en）
├─ tools/
│  ├─ tone.js           纯规则语气后处理（tone_fix 用）
│  └─ tieba/            贴吧 CLI（服务端 subprocess 调它）
├─ service/             记忆服务（Python）
│  ├─ server.py         入口 + 路由
│  ├─ memory_core.py    SQLite / 检索 / 各业务表
│  ├─ extractor.py      LLM 抽取
│  ├─ scheduler.py      内置调度（不依赖 cron）
│  ├─ llm.py embedding.py surprisal.py
│  ├─ schema.sql        建表 + 迁移基线
│  ├─ seeds.json        默认语料（1020 条，随包发布）
│  ├─ static/           教程图等静态资源
│  ├─ data/             运行时数据（gitignore）
│  └─ deploy/           Linux/systemd/cron 部署脚本
├─ tests/               全部测试（node + python）
├─ docs/                文档（本目录）
├─ ops/                 个人 VPS 专用脚本与第三方补丁（与安装无关）
├─ install.mjs          装插件到 profile（跨平台）
├─ install.sh           Linux/macOS 安装入口
├─ install.ps1          Windows 安装入口
├─ run_all_tests.sh/.ps1 测试入口
└─ package.json
```

每个功能的文件位置、接口和数据表，见 [`docs/features/`](features/)。

## 两层配置

| 层 | 存在哪 | 谁改 | 例子 |
|---|---|---|---|
| 插件配置 | profile 的 `cordis.patch.yml` / 环境变量 | 用户手工 | 服务地址、召回条数、人格段长度 |
| 服务配置 | `service/data/config.json`（设置页写）或 `service/.env` | 设置页 / 安装脚本 | LLM/embedding 的 base、key、model，开关 |

服务端启动时：`config.json` > 环境变量（含 `.env`/`.env.win` 文件）> 内置默认。设置页保存走 `POST /config`，热重建 LLM/embedder，不重启进程。
