# dsh-remembers

**她记得。想不起的时候，她会说想不起。**

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 做的记忆插件，为情感陪伴场景设计——不是给代码助手用的。

```
用户：嗯
她：[想起 3 个月前那通凌晨两点的电话] ……还在想那天的事？
```

不是"检索到相关文档"，是"她记得你说过什么"。

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

## 架构

```
┌─────────────────────────────────────────┐
│ dsh-remembers（本仓库根，DSH 插件）      │
│  agent/created  → 注入 L4 人格与关系约定 │
│  agent/pre-step → 检索，有命中才注入     │
│  turn/end       → 原话写进 L0           │
└───────────────┬─────────────────────────┘
                │ HTTP
┌───────────────▼─────────────────────────┐
│ companion-memory（service/，Docker）     │
│  SQLite 单文件：结构化 / BM25 / 向量     │
│  中文 bigram BM25 + numpy 余弦           │
│  分层衰减 + 融合 + 诚实出口              │
└─────────────────────────────────────────┘
```

插件是薄客户端，重活在服务里。服务挂了只影响"想起"，不影响对话。

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

插件行为（mock ctx + 真服务，11 项断言）：profile 注入、召回注入、同内容去重、无命中不注入、subagent 跳过、L0 写入、原话可检索、空轮不写。

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
