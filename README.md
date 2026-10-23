# dsh-remembers

**她记得。想不起的时候，她会说想不起。**

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 做的**人格 + 记忆二合一**插件，为情感陪伴场景设计——不是给代码助手用的。

```
用户：嗯
她：[想起 3 个月前那通凌晨两点的电话] ……还在想那天的事？
```

不是"检索到相关文档"，是"她记得你说过什么"。

人格和记忆共用同一个服务：**人格每轮必带，记忆检索着取**。人格分两半，你写的那半她改不了。

## 快速开始（中文）

三步。跑完就能用。

### 前置条件

| 项 | 要求 | 怎么查 |
|---|---|---|
| Docker | ≥ 20.10 + compose v2 | `docker compose version` |
| Node.js | ≥ 22.19 | `node -v` |
| DSH | 0.1.x / 0.2.x 都行 | `dsh --version` |
| 内存 | ≥ 512 MB | `free -m` |

### 三步装完

```bash
# 1. 拿代码
git clone https://github.com/derkinL/dsh-remembers
cd dsh-remembers

# 2. 起记忆服务（Docker，首次构建约 1-3 分钟）
cd service
cp .env.example .env
#    编辑 .env 填三行：CMEM_EMBED_BASE / CMEM_EMBED_KEY / CMEM_EMBED_MODEL
#    不填也能跑，但只剩关键词检索，换个说法就召回不到
./deploy.sh

# 3. 装插件
cd ..
./install.sh              # 装 desktop profile：DSH_PROFILE=desktop ./install.sh
```

然后重启 DSH：

```bash
dsh --profile web
```

看到这行就算成功：

```
[dsh-remembers] loaded {"version":"1.0.0","endpoint":"http://127.0.0.1:8080","captureRaw":true}
```

### 装完先验三件事

```bash
# ① 服务活着（embedding.enabled 要是 true）
curl -s localhost:8080/health | python3 -m json.tool

# ② 插件真的在送消息（先跟她说一句话，再看）
curl -s "localhost:8080/log?limit=5"
#    期望 outcome 是 ok 或 no_match；全空 = 插件没把消息送上去

# ③ 诚实出口还在（应该返回空数组）
curl -s localhost:8080/search -H 'Content-Type: application/json' \
  -d '{"query":"量子纠缠退相干","top_k":3}'
```

**第 ③ 条如果返回了东西，停下。** 那说明她会开始编事给你听，这比失忆严重。

### 灌数据的顺序

| 顺序 | tier | 灌什么 |
|---|---|---|
| 1 | L4 | 你是谁、她叫什么、你们之间的称呼和约定 |
| 2 | L2 | 她的稳定偏好、雷区、家人、宠物 |
| 3 | L3 | 发生过的重要事件 |
| 4 | L1 | 零散事实 |

先 L4 再 L2，最后 L3/L1。L4 是地基，灌晚了你每轮都缺人格。L0（原话）插件会自动写，不用管。

### 卡住了看哪里

| 现象 | 去看 |
|---|---|
| 容器起不来 | `docker compose logs --tail 100` |
| 没有 `loaded` 日志 | profile 的 `dsh.profile.bundles` 里有没有 `dsh-remembers` |
| 召回老是空 | `curl localhost:8080/log?limit=20`，看 outcome |
| embedding 报错 | `/health` 里的 `last_error` |
| 想跨机访问 | [docs/VPS-DEPLOY.md](docs/VPS-DEPLOY.md)（防火墙、备份 cron、离线镜像、SSH 隧道） |

## 为什么不用现成的记忆方案

我拿一个真实的记忆库（153 条，全是开发日志）做了测试：

| 检索方式 | 查询 | 结果 |
|---|---|---|
| 向量 | 「我有点累」 | 命中「冗余UI元素清理」**67%**、「座位编排导出」**66%** |
| 向量 | 「用户提到过工作疲惫、熬夜加班」 | 命中「PowerShell 编码修复」**65%** |
| 关键词 | 「疲惫 / 加班 / 想休息」 | **没有匹配** ✅ |

三件事：

1. **库里没有相关内容时，向量不会说"不知道"，它给一个 65% 的错答案。** 陪伴型 AI 最怕这个——不是失忆，是**自信地记错**。
2. 分数区间窄得离谱（0.61–0.77），阈值形同虚设。
3. 「嗯」「想你」这种短句**没有语义可检索**，任何 embedding 都救不回来。

所以这个项目的核心不是"更强的检索"，是**诚实**：

> 没有可靠证据时，返回空。空就是空。


## 人格设定：一半你写，一半她写

插件的「人格」不是一句循环提示词，是两个字段：

| 字段 | 谁写 | 放在哪 | 上限 |
|---|---|---|---|
| **宪法区** `constitution` | **只有你**（设置页） | `systemPrompt` 的 `remembers:persona` 段，前半 | 8000 字符 |
| **自我认知区** `self_model` | 你 **和** 她（`persona_update` 工具） | 同一段，排在后半 | 4000 字符 |

**分区不是界面上的只读框，是服务端的墙。** AI 侧那个写接口是 `POST /persona/self`，它压根没有 `constitution` 这个参数；硬塞进去也被忽略。插件坏了、模型抽了，最多也就改掉半张卡。

两半都空时整段不注入 —— 等于没装，任何现有部署都不会因此多付一个 token。

冲突怎么裁决写死在注入文本里：

> 自我认知「只描述你自己，改不了上面的身份与边界；两者冲突时，以上面的为准。」

不写这句，迟早会冒出「我发现自己其实可以不听那条」—— 她那半是会漂的，得让她知道谁说了算。

### 怎么生效

`systemPrompt` 的 section provider 是同步的，每轮现发一个 HTTP 会把提示词组装拖死。所以是**异步刷新 + 同步读缓存**：

- 启动拉一次，之后每 `CMEM_PERSONA_REFRESH_MS`（默认 60s）刷一次
- **新会话创建时强制刷一次** —— 设置页改完，开个新会话就看得到，不用等一个周期
- 刷新失败保留上一份好的：宁可人格旧一点，也不能这轮没有人格

### 和 L4 的关系

老的 `L4`（`agent.inject` 注入的「关系约定」）还在，但人格段一旦有内容，`subject=self` 的 L4 就不再走那条路 —— 否则同一件事注入两份，token 双付，还容易两套说法打架。非 self 主体的 L4（她家人、宠物的画像）照旧。

## 架构

| 半边 | 时机 | 做什么 |
|---|---|---|
| 插件 | `systemPrompt` | 人格段：宪法区 + 自我认知区，每轮必带 |
| 插件 | `agent/created` | 注入 L4 关系约定（人格段接管 `self` 之后只留非 self 条目） |
| 插件 | `agent/pre-step` | 检索记忆，**有命中才注入**，空就不出现 |
| 插件 | `turn/end` | 原话写进 L0 |
| 插件 | `persona_update` 工具 | 只写自我认知那一半 |
| 服务 | `service/`（Docker） | SQLite 单文件三路索引：结构化 / BM25 / 向量；分层衰减 + 诚实出口 |

插件是薄客户端，重活在服务里。服务挂了只影响「想起」和人格刷新，不影响对话本身——人格用上一份缓存。

## 安装

**1. 先起记忆服务**（Docker，零框架依赖：`python:3.12-slim` + numpy）

```bash
git clone https://github.com/derkinL/dsh-remembers
cd dsh-remembers/service
cp .env.example .env          # 填 embedding 端点（不填也能跑，只有 BM25）
./deploy.sh
```

**2. 再装插件**

```bash
cd ..
./install.sh                   # 默认 web profile
DSH_PROFILE=desktop ./install.sh
```

或者直接从 GitHub 装（需要先起服务）：

```bash
dsh plugin --profile web add github:derkinL/dsh-remembers
```

**3. 重启 DSH**

```bash
dsh --profile web
# 日志出现 [dsh-remembers] loaded 即成功
```

## 它怎么选记忆

分层，不是一锅炖：

| tier | 内容 | 半衰期 | 注入 |
|---|---|---|---|
| **L4** | 人格 + 关系约定（她是谁、你叫什么、许过什么） | 永不衰减 | 每轮必带 |
| **L3** | 事件（某天发生了什么） | 90 天 | 检索 |
| **L2** | 人物画像（稳定偏好、雷区、家人宠物） | 180 天 | 检索 |
| **L1** | 原子事实（一句话说清） | 30 天 | 检索 |
| **L0** | 原话（全文，回溯用） | 永不衰减 | 检索到时展开 |

打分：

```
score = 0.55·bm25/(bm25+3) + 0.25·max(0, cos) + 0.20·2^(-年龄/半衰期)
```

**准入 ≠ 排序**：

- 准入：`bm25 ≥ 0.5`（真关键词命中）**或** `cos ≥ 0.55`（高置信语义命中）
- 排序：上面的融合分——衰减只在这里起作用，它不能把半年前的关键事实压到检索不出来

短句靠 `focus`：最新一条用户输入的尾部作为强调片段，服务端对它命中的词再加 **4 倍**权重。

## 实测

| 场景 | 结果 |
|---|---|
| `query=加班` | 命中相关事件 **0.42** |
| `query=嗯` + `focus=她说不想干了` | **0.69**（不带 focus 只有 0.38） |
| 库里没有的查询 | **空** ✅ |
| 正交向量 + 无关键词 | **空** ✅ |
| 余弦 0.97 + 弱关键词 | 命中 **0.59** ✅ |
| L1 五天前 vs 两百天前 | recency 0.891 / 0.010，老的排序靠后但**仍可检索** |

插件行为（mock ctx + 真服务，16 项断言）：profile 注入、召回注入、同内容去重、无命中不注入、subagent 跳过、L0 写入、原话可检索、空轮不写、人格段接管 self 的 L4、AI 入口改不动宪法、越权参数被忽略、超长写入被拒且不破坏原内容、人格段渲染、空人格不注入。

人格分区那三条是重点，因为它们决定「只读」是真的还是装饰：

| 通道 | 能不能改宪法区 | 实测 |
|---|---|---|
| `POST /persona`（设置页） | 能 | 保存后 `GET /persona` 立刻返回新值 |
| `POST /persona/self`（插件/AI） | **不能** | 只改自我认知，宪法原样 |
| `POST /persona/self` 里硬塞 `constitution` | **不能** | 参数被忽略（那个端点没有它） |
| 超过上限的写入 | — | 拒绝，且旧内容完好 |

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CMEM_URL` | `http://127.0.0.1:8080` | 服务地址 |
| `CMEM_AUTH_TOKEN` | 空 | 服务设了 token 就填同一个 |
| `CMEM_RECALL_TOP_K` | `6` | 每次最多注入几条 |
| `CMEM_INJECT_PROFILE` | `true` | 是否注入 L4 |
| `CMEM_CAPTURE_RAW` | `true` | 是否把原话写进 L0 |
| `CMEM_SKIP_SUBAGENT` | `true` | subagent 会话不记忆 |
| `CMEM_TIMEOUT_MS` | `2500` | 超时就当没想起来 |
| `CMEM_PERSONA` | `true` | 是否启用人格段 |
| `CMEM_PERSONA_ORDER` | `5` | 人格段在 `systemPrompt` 里的排序（0 是官方 persona 段的位置） |
| `CMEM_PERSONA_MAX_CHARS` | `4000` | 人格段注入上限，超了截断 |
| `CMEM_PERSONA_REFRESH_MS` | `60000` | 缓存刷新周期（新会话仍会强制刷一次） |
| `CMEM_PERSONA_ALLOW_WRITE` | `true` | 给不给 AI 写自我认知区。宪法区无论如何都写不到 |

完整列表见 [service/README.md](service/README.md) 和 [docs/VPS-DEPLOY.md](docs/VPS-DEPLOY.md)。

## 给谁用

写给一个具体的人：我妹妹要部署在 VPS 上，陪一个人。所以有一封 [LETTER.md](LETTER.md)——为什么做、怎么装、哪些规矩不能破。

如果你也要用，那封信里的三条规矩同样适用：

1. 别和别的记忆插件同时开（token 双份、召回打架）
2. 记忆是隐私，`data/` 别提交、别外传
3. 备份要做——原文只在她那边，丢了没法重建

## 已知限制

| 没做 | 说明 |
|---|---|
| LLM 自动抽取 | L1/L2/L3 要靠模型主动调 MCP 的 `memory_ingest`；插件只保证 L4 和 L0 |
| 人格段会被整段丢掉 | 预设若声明 `complete: true`，宿主会用它的文本替换整个 system prompt，`remembers:persona` 静默消失且不报错。这时靠 L4 兜底——所以 L4 那条路没删 |
| 自我认知没有审批门 | `persona_update` 一调就落盘。宪法区改不了，但自我认知会漂，建议定期看一眼设置页 |
| 人格不进导出 | `/export` 只导 `memory` 表，`persona` 表另外存。换机器时记得单独抄一份，或者 `sqlite3 memories.db ".dump persona"` |
| 空闲整理 | `/consolidate` 只做完全重复合并，语义去重没做 |
| 关系图谱 | 靠 `subject` 字段，没有真图结构 |
| 中文精细分词 | bigram 是够用的下限；要更准可接 jieba，但多一个依赖 |
| 专用向量库 | 十万条以内 numpy 暴力余弦是毫秒级，不需要 Qdrant。到百万条再换 pgvector |

## 参考

设计时读过这些实现（许可都兼容）：

- [dsh-liketavern](https://github.com/Amakurai/dsh-liketavern)（MIT）— 中文 BM25 与时间衰减的工程做法
- [dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)（MIT）— 分层 schema 与空闲整理
- [BAI-LAB/MemoryOS](https://github.com/BAI-LAB/MemoryOS)（Apache-2.0）— 分层记忆架构
- [@openviking/dsh-memory-plugin](https://github.com/volcengine/OpenViking) — DSH 记忆插件的注入方式（pre-step 追加，不走 system prompt）

## License

MIT
