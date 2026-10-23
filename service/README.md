# companion-memory

给「情感陪伴型」AI 用的长期记忆服务。向量 + 精确检索一起用，但**不让向量单独说"我记得"**。

零框架依赖：`python:3.12-slim` + `numpy` 就是全部运行时。

```
Docker 单容器
├── SQLite 单文件        → 结构化字段 / BM25 倒排 / 向量 BLOB，三路索引同一份数据
├── 自建 CJK BM25        → 中文 bigram 分词，不依赖 SQLite FTS 默认分词
├── numpy 向量检索       → 十万条以内暴力余弦就够（见「为什么不用向量数据库」）
├── 外部 embedding API   → 挂了就自动降级成纯 BM25，不拖垮服务
└── MCP stdio shim       → DSH 直接连，零插件先验证记忆质量
```

## 为什么这样设计（都有实测依据）

| 发现 | 后果 | 这里的对策 |
|---|---|---|
| 库中没有相关内容时，向量仍返回 0.65+ 的分数 | 她会**自信地记错** | 诚实出口：没有关键词命中时，向量余弦必须 ≥0.55 才够格 |
| 向量分数分布极窄（0.61–0.77） | 阈值形同虚设 | 归一化用饱和映射，不用「除以本批最大值」 |
| 「嗯 / 想你」没有语义可检索 | 短句必失忆 | `focus` 参数：当前话题额外 ×5 权重 |
| 半年前的关键事实被衰减压到检索不出来 | 重要的事会消失 | 衰减**只影响排序**，不影响准入；L4/L0 永不衰减 |
| 人格设定和检索结果重复注入 | 白烧 token | L4 单独走 `/profile`，不进 `/search` |

## 快速开始

```bash
cp .env.example .env          # 填 embedding 端点（不填也能跑，只是没有语义召回）
docker compose up -d --build
curl -s localhost:8080/health | python -m json.tool
```

写入几条记忆：

```bash
curl -s localhost:8080/ingest -H 'Content-Type: application/json' -d '{
  "tier": "L4", "subject": "user",
  "text": "你叫她小宝，不许叫全名。你们约好每周日晚上聊天。",
  "tags": ["relationship"]
}'
```

检索：

```bash
curl -s localhost:8080/search -H 'Content-Type: application/json' -d '{
  "query": "嗯", "focus": "她说不想干了", "top_k": 3
}'
```

零 Docker 本地跑：

```bash
CMEM_DATA_DIR=./data CMEM_PORT=8080 python server.py
```

## 分层

| tier | 内容 | 半衰期 | 注入方式 |
|---|---|---|---|
| **L4** | 人格 + 关系约定（她是谁、你叫什么、许过什么） | 永不衰减 | 每轮必带（`/profile`） |
| **L3** | 事件（某天发生了什么） | 90 天 | 检索 |
| **L2** | 人物画像（稳定偏好、雷区、家人宠物） | 180 天 | 检索 |
| **L1** | 原子事实（一句话说清） | 30 天 | 检索 |
| **L0** | 原话（全文，回溯用） | 永不衰减 | 只在被检索到时展开 |

## 打分

```
score = 0.55 · bm25/(bm25+3) + 0.25 · max(0, cos) + 0.20 · 2^(-age/半衰期)
```

**准入 ≠ 排序**：

- 准入：`bm25 ≥ 0.5`（真关键词命中）**或** `cos ≥ 0.55`（高置信语义命中）
- 排序：上面的融合分，衰减只在这里起作用

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康 + embedding 状态 + 统计 |
| GET | `/stats` | 条数 / 平均长度 / 词表 / 已向量化 |
| GET | `/profile?subject=` | L4 人格块，每轮必带 |
| GET | `/persona` | 人格设定：宪法区 + 自我认知区 + 各自长度与上限 |
| POST | `/persona` | 设置页保存，两半都能写（没传的字段保持原值） |
| POST | `/persona/self` | **AI 侧入口，只能写自我认知区** —— 没有 `constitution` 参数 |
| POST | `/ingest` | 写一条，`embed:false` 可跳过向量 |
| POST | `/search` | 混合检索，`query` + `focus` |
| POST | `/forget/{id}` | 删除 |
| POST | `/consolidate` | 保守去重（同 tier+subject 完全同文只留最新） |
| GET | `/log?limit=` | 检索日志，调阈值用 |

### 人格为什么单开一张表

`L4` 是记忆里的既成事实，靠 MCP 灌、会被 export/import 当记忆搬走，也没有编辑入口。人格是配置：要能编辑、要分区、要能限制谁有权写哪一半。

两个字段就是那堵墙：

```sql
CREATE TABLE persona (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  constitution    TEXT NOT NULL DEFAULT '',   -- 只剩设置页能写
  self_model      TEXT NOT NULL DEFAULT '',   -- AI 也能写
  updated_at      REAL NOT NULL DEFAULT 0,
  self_updated_at REAL NOT NULL DEFAULT 0
);
```

`set_persona()` 两半都改（只给设置页），`set_self_model()` 只改后半（给插件）。超长写入在进库之前就抛 `ValueError`，失败不会把旧内容写坏。

## 调阈值

`/log` 的 `outcome` 有三个值，对着看就能调：

| outcome | 含义 | 该调什么 |
|---|---|---|
| `ok` | 正常命中 | — |
| `no_match` | 关键词和向量都没够格 | 若本应命中 → 降 `MIN_BM25_ABS` |
| `vec_only_rejected` | 只有向量像，被诚实出口拦了 | 若语义召回太保守 → 降 `VEC_ONLY_MIN_COS` |

阈值都在 `memory_core.py` 顶部常量区。

## 接入 DSH

### 方式一：MCP（已验证，零代码）

DSH 的 profile MCP 配置里加一条 stdio 命令：

```json
{
  "mcpServers": {
    "companion-memory": {
      "command": "python",
      "args": ["/path/to/dsh-remembers/service/mcp_server.py"],
      "env": {
        "CMEM_URL": "http://127.0.0.1:8080",
        "CMEM_AUTH_TOKEN": "和容器里一致"
      }
    }
  }
}
```

工具面：`memory_search` / `memory_ingest` / `memory_profile` / `memory_forget` / `memory_stats`。

**局限**：这是「模型主动调用」模式，她得想起来去查。做技术助手够用，做陪伴不够——陪伴要的是**不请自来**。

### 方式二：插件（已实现，在 `plugin/`）

```bash
./deploy.sh     # 先起服务
./install.sh    # 再装插件（DSH_PROFILE=desktop ./install.sh 换 profile）
```

插件是薄客户端，只挂三个钩子：

| 钩子 | 行为 |
|---|---|
| `agent/created` / `agent/session-start` | `agent.inject()` 注入 L4 人格块 |
| `agent/pre-step` | 检索有命中才返回 `{kind:"enter", messages:[...decision.messages, recall]}` |
| `session/event` + `turn/end` | 把这一轮原话写进 L0（不抽摘要，保证说过的话不丢） |

四个实现要点（都是踩出来的）：

- **注入走 pre-step 返回新 messages**，不是 `agent.appendUserMessage`——直接 append 会绕过宿主的消息闸门。
- **消息用宿主构造器** `createUserMessage({ content:[{type:"text",text}], source:{ kind:"plugin:dsh-remembers", plugin, form } })`，不手搓对象。
- **人格走 system prompt 的独立段，记忆走 pre-step**：人格是「一直成立的前提」，得摆在权重最高的位置；记忆是「想起什么算什么」，有命中才追加。人格段确实会被声明 `complete:true` 的预设整段吞掉，所以 `agent.inject` 那条 L4 兜底路保留着。
- **空结果不注入**，且**同内容去重**（sha256，同一会话不重复塞）。

本地验证：mock ctx + 真服务，16 项断言全过（profile 注入、召回注入、去重、无命中不注入、subagent 跳过、L0 写入、原话可检索、空轮不写、人格段接管 self 的 L4、AI 改不动宪法、越权参数被忽略、超长拒绝、人格段渲染、空人格不注入）。

服务跑起来不需要 Docker：`requirements.txt` 里只有 `numpy>=1.26`，`python server.py` 直接起。Docker 只是给 VPS 部署用的（隔离、开机自启、备份 cron）。

> **未验证**：真实 `@deepseek-ai/dsh-llm`（打包在 app.asar 内，磁盘上没有展开包），本地用结构等价的 mock 替身。装到 VPS 后第一件事是确认日志里有 `[dsh-remembers] loaded`。

**为什么不让插件直接读写 SQLite**：服务化之后，姐姐在本地、妹妹在 VPS 可以共享同一份记忆，也能各自隔离；插件只当客户端，DSH 升级换代时插件薄、重写成本低。

## 别和 OpenViking 同时开

两边都做「注入 + 召回」，同时开会：token 双份、召回互相打架、记忆两套互不可见。

- 妹妹（VPS）→ 用这套
- 我（本地）→ 继续 OpenViking

要共享就只留一边，别让两个系统都以为自己记得。

## 为什么不用向量数据库

情感陪伴的数据量：聊一年、每天 50 条 ≈ 1.8 万条。1024 维 float32 = 4 KB/条 ≈ 72 MB。

numpy 在一次 `dot` 里算完，毫秒级。上 Qdrant / Milvus 只是多一个要备份、要升级、会挂的容器。

**等真到百万条再换 pgvector**，那时改的是 `vec_search()` 一个函数。

## 实测结果（本地，2026-10-23）

| 场景 | 结果 |
|---|---|
| `query=加班` | 命中「三月那次她加班到凌晨两点…」0.42 |
| `query=嗯` + `focus=她说不想干了` | **0.69**（比不带 focus 的 0.38 明显提升） |
| `query=量子纠缠退相干`（库中没有） | **空** ✅ |
| 正交向量 + 无关键词 | **空** ✅ |
| 向量余弦 0.97 + 弱关键词 | 命中 0.59 ✅ |
| L1 5 天前 vs 200 天前 | recency 0.891 vs 0.010（排序靠后但**仍可检索**） |
| MCP `initialize` / `tools/list` / `tools/call` | 全部通过 |

## 下一步（没做，别以为是坏的）

- **LLM 抽取**：现在要靠调用方给 `tier` 和原文。真正的自动分层要加一个抽取步骤（可参考 OpenViking 的 Phase 2 做法）。
- **空闲整理（dream）**：现在的 `/consolidate` 只做完全重复合并；语义去重和关系画像生成要模型参与。
- **关系图谱**：人名/事件之间的连线现在靠 `subject` 字段，没有真正的图结构。
- **中文分词**：bigram 是够用的下限；要更准可以接 jieba 或 pkuseg，但会多一个依赖。

## 文件

| 文件 | 作用 |
|---|---|
| `schema.sql` | 表结构（memory / doc_term / term_stat / doc_len / search_log） |
| `memory_core.py` | 分词、BM25、向量、衰减、融合、诚实出口 |
| `embedding.py` | 外部 embedding 客户端（失败降级） |
| `server.py` | HTTP 服务（标准库） |
| `mcp_server.py` | MCP stdio shim |
| `test_core.py` | 本地自测，不依赖 Docker |
| `Dockerfile` / `docker-compose.yml` | 部署 |

跑自测：

```bash
python test_core.py
```
