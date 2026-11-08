# 功能：学说话 / 参考语料 / 口音

目标不是「背梗」，是让她的句子像人说的：会接梗、会冷收尾、会阴阳一句。

**1.2.1 起拆成两件事，各走各的**：

| 层 | 用来干什么 | 从哪来 | 进不进人格 |
|---|---|---|---|
| **参考语料** | 每轮挑 1–2 句贴进状态块，给她「这个场合别人怎么说」的参考 | 默认 1020 条 + 从 B 站/贴吧抓的原句 | **不进** |
| **口音档案** | 一段 200 字「我平时怎么说话」，写在人格【我的口音】 | **她自己说过的话**（`self_line`）的统计 + 最近原句 | **进**（每 3 天重写） |

## 为什么换了机制

旧机制：网友原句 → 候选池 → 相似说法攒够 3 次（hits≥3）→ 转正 → 进口音。

线上跑了两周的数据：

```
learned = 33 条，全部 hits=1，active=0
/voice  →  {"doc": "", "promoted": 0}
```

原因不是 bug，是设计不可达：抽取每条原句只出现一次，`hits` 永远到不了 3。
所以「口音」从部署那天起就是空的。换成从**她自己的发言**量：

```
她每轮回复 → POST /selfline → self_line 表
   ↓ 满 8 句（约一两天）
统计：中位句长 / 短句比例 / 句尾标点率 / 语气词 / 表情标签率
   ↓ 有 LLM 就让它写成 200 字；没有就按统计拼一段
口音档案（source=self）→ 人格【我的口音】，3 天重写一次
```

样本不足 8 句时（刚装、刚清库），先用参考语料顶一版，并在档案里明写
「样本不足：她自己说过 N 句，这条暂时是参考语料」——不假装已经学会。

## 每轮的参考是怎么给的

`/state` 里算 `phrase_hints`，三级兜底：

```
embedding 余弦（配了向量模型）
  ↓ 没配 / 没过阈值
LLM 从候选里挑（配了对话模型）
  ↓ 也没有
话题词表
```

挑出来的 1–2 句放在**状态块**里，不写进 systemPrompt（避免打穿 prompt cache）。

## 文件树

```
service/
├─ seeds.json                # 默认 1020 条语料（随包发布）
├─ extractor.py              # 抽取/判定提示词、pick_phrase_hints、build_voice_doc
├─ server.py                 # /phrases /expressions /learn/* /voice /voice/rebuild
│                            # POST|GET /selfline（她自己的发言）
│                            # _voice_stats / _voice_doc_rule / rebuild_voice
├─ memory_core.py            # expressions、expr_vec、self_line 三张表
└─ schema.sql                # expressions, expr_vec, self_line
index.mjs                    # find_phrases / learn_expression 工具；hints 注入；口音进人格段
client.js                    # 「学说话」面板：参考语料分类卡片 + 提示词编辑 + 口音区（可立即重写）
tests/python/test_selfline.py  # self_line + 口音样本优先级
tests/python/test_slang.py     # 旧 slang 门槛（历史表，仍保留）
```

## 表

- `expressions`：参考语料。`raw / source / likes / hits / canon / scene / meaning / usage / tail / status`。
  `status` 现在只影响「这条参不参与参考池」，**不再决定口音**。
- `self_line`：她自己说过的话（`ts / text / session / scope`），口音的唯一可靠来源。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/phrases?tag=&q=` | 参考语料（场景词精确匹配优先） |
| GET | `/phrases/tags`、`/phrases/scene` | 分类 / 场景词 |
| POST | `/expressions` | 新增/修改参考说法（设置页与 AI 共用） |
| GET/POST | `/learn/prompt` | 「学聊天」「学网友」两段抽取提示词（可改） |
| POST | `/learn/switch` | 学习总开关 |
| GET | `/learn/stats` | 参考语料计数 |
| **GET/POST** | **`/selfline`** | 她自己的发言：读最近 N 条 / 写一条（插件每轮上报） |
| GET | `/voice` | 口音档案（doc / samples / stats / source / selfCount） |
| POST | `/voice/rebuild` | 立即重写口音档案 |

## 已知边界

- 口音要满 8 句自发言才生成；刚装的那一两天是「参考语料顶替版」，会标明。
- 新加的参考语料要等重启才编码向量（`expr_vec` 启动时补齐）。
- 判定/转正/口音重写都要 LLM；没配 LLM 时口音用规则拼接，参考语料仍可用。
