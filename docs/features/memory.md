# 功能：分层记忆（L0–L4）

她记得你说过什么；想不起来的时候会说想不起来，而不是编一段。

## 分层

| 层 | 内容 | 半衰期 | 谁写 |
|---|---|---|---|
| **L0** | 原话（每轮用户消息） | 不衰减 | 插件 `session/event` → `POST /ingest` |
| **L1** | 原子事实（「她不吃香菜」） | 30 天 | `extract`（LLM） |
| **L2** | 人物画像（考研、怕黑、养猫） | 180 天 | `extract` + 自动累积到 `profiles` |
| **L3** | 事件（那晚加班到两点） | 90 天 | `extract` / `POST /episode` |
| **L4** | 人格与关系约定 | 不衰减 | 设置页手编 / 人格卡 |

检索 = BM25 关键词 + 向量余弦（可选）+ 时间衰减 + **诚实出口**（分数不够就返回空，不硬凑）。

## 一次写入 / 一次召回

```
写入：turn end
  user 文本 ≥6 字
    → POST /surprisal（纯文本，不花钱）→ store=false 就丢
    → POST /ingest 写 L0
    → 异步 POST /extract → 抽 L1/L2/L3 + 学说法
    → 攒满 40 轮 / 120 分钟 → POST /episode 压一条 L3

召回：pre-step
  POST /search {query, focus, top_k, scopes}
    → BM25(中文 bigram 倒排) + 向量 + recency 加权
    → 分数 < 阈值 → 空数组（她就说「不记得」）
```

## 文件树

```
index.mjs                      # 写 L0 / 触发抽取 / episode / 召回注入
client.mjs                     # /ingest /search /extract /episode 的 HTTP 封装
service/
├─ server.py                   # /ingest /search /extract /episode /reindex
│                              # /memories /forget/{id} /consolidate /export /import
├─ memory_core.py              # 建表、分词、BM25、向量、衰减、诚实出口、迁移
├─ extractor.py                # LLM 抽事实 + ADD/UPDATE/DELETE/NONE 判定
├─ surprisal.py                # 惊讶度门控（寒暄/重复不值得存）
├─ schema.sql                  # memory / doc_term / term_stat / doc_len / search_log
└─ backup.py                   # 在线整库备份 + restore 校验
tests/python/test_core.py      # 检索、衰减、融合、诚实出口
tests/python/test_transfer.py  # A 库 → JSONL → B 库，一字不差
```

## 表

`memory`（主语/场景/层级/向量/半衰期）、`doc_term` + `term_stat` + `doc_len`（BM25）、`search_log`（调阈值用）。

## 多用户隔离

- 每条记忆带 `user_id` + `scope`（`private:<qq>` / `group:<gid>` / `global`）。
- 召回只取「当前会话 scope + global」，别人的私聊不会串进来。
- 系统提示词里只放主人画像；群聊 / 私聊别人时，额外注入「现在说话的是谁」。

## 已知边界

- `POST /episode`、`/extract` 需要配 LLM；没配就返回 `degraded`（记忆仍会以 L0 原话保存）。
- 向量检索要配 embedding；没配就用 BM25，召回质量下降但仍可用。
- `/consolidate`（按文本去重）有接口但没有调度器调用，属于手动工具。
- 迁移时用 `POST /export`（JSONL）和 `POST /import`；整库备份用 `backup.py`（含人格，`/export` 不含）。
