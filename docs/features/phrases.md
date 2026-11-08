# 功能：学说话 / 语料库 / 口音

目标不是「背梗」，是让她的句子像人说的：会接梗、会冷收尾、会阴阳一句。

## 三条腿

| 腿 | 干什么 | 频率 |
|---|---|---|
| **候选池** | 从私聊、群聊、B 站评论、贴吧楼层里摘**原句**（不做抽象） | 每轮 / 每次逛 |
| **转正** | 子 AI 过一遍候选：判「是不是说话方式」、归一 canon、打标签/场景/意思/用法 | 每 3 天 |
| **口音档案** | 把已转正、出现 ≥3 次的说法归纳成 200 字，写进人格【我的口音】 | 每 3 天（或手动「立即重写」） |

检索有三级兜底：**embedding 余弦 → LLM 挑 → 话题词表**。挑出来的 1–2 句放在每轮状态块里（`state.phrase_hints`），不写进 systemPrompt——避免打穿 prompt cache。

## 默认语料

`service/seeds.json`：1020 条（来自 [dsh-fish-tone-flavor](https://github.com/MX3a48c5/dsh-fish-tone)，MIT），带 `situation / style / raw / tag / scene / meaning / usage / tail`。
启动时导入，`source='seed'`：**不参与学习打分，也不吃 40 条上限**。所以新装也有东西可用，不用先喂三个月。

## 文件树

```
service/
├─ seeds.json                  # 默认语料（随包发布）
├─ extractor.py                # 抽取/转正提示词、learn_* prompt、pick_phrase_hints、口音归纳
├─ server.py                   # /phrases /phrases/tags /phrases/scene /expressions
│                              # /learn/prompt /learn/switch /learn/stats /voice /voice/rebuild
│                              # _state 里算 phrase_hints（embedding→LLM→话题词表）
├─ memory_core.py              # expressions / expr_vec 表；canon 归并、hits、trim(40/来源)
└─ schema.sql                  # expressions, expr_vec
index.mjs                      # find_phrases / learn_expression 工具；状态块注入 hints；口音进人格段
client.js                      # 「学说话」面板：语料库分类卡片 + 抽取/注入提示词编辑 + 计数
services 侧                   # scheduler 每 3 天触发转正与口音重写
tests/python/test_slang.py     # 旧 slang 门槛（历史表，仍保留）
```

## 表：`expressions`

`scope`（global / tieba / bili / chat）、`situation`、`style`、`raw`（原句）、`source`、`likes`、`hits`、`canon`、`scene`、`meaning`、`usage`、`tail`（能不能收尾）、`status`（candidate / active / rejected）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/phrases?tag=&q=` | 已转正的说法（场景词精确匹配优先） |
| GET | `/phrases/tags`、`/phrases/scene` | 分类 / 场景词 |
| POST | `/expressions` | 新增/修改（设置页与 AI 共用） |
| GET/POST | `/learn/prompt` | 「学聊天」「学网友」两段提示词（可改） |
| POST | `/learn/switch` | 学习总开关 |
| GET | `/learn/stats` | 候选/已转正/来源计数 |
| GET | `/voice`、POST `/voice/rebuild` | 口音档案（读 / 立即重写） |

## 已知边界

- **新语料要等重启才编码**：启动时批量补 `expr_vec`，运行期新增不即时补（有意为之，影响不大）。
- 转正和口音重写都要 LLM；没配 LLM 时停在候选池，`find_phrases` 仍能按标签/场景查已有的。
- `slang` 表是上一代机制：插件仍会写（`recordSlang`），但**没有任何注入读它**，属于遗留死路径（见 [体检报告](../audit.md)）。
