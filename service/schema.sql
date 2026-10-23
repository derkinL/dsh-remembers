-- companion-memory schema
-- 单文件 SQLite：结构化字段 + BM25 倒排 + 向量 BLOB，一个文件三路索引。
-- 设计依据见 README.md「为什么不用专用向量库」。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 记忆主表
--   tier   L4 人格/关系设定  L3 事件线  L2 人物画像  L1 原子事实  L0 原话
--   subject 记忆主体（谁的事）：self / 人物名 / 宠物名 / 项目名
--   half_life_days NULL = 永不衰减（L4 / L0 用这个）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tier           TEXT    NOT NULL,
  subject        TEXT    NOT NULL DEFAULT 'self',
  text           TEXT    NOT NULL,
  summary        TEXT,
  source_ids     TEXT,                       -- JSON 数组，回溯到原话
  tags           TEXT,                       -- JSON 数组，精确筛选用
  ts             REAL    NOT NULL,           -- 事件发生时间（unix 秒）
  half_life_days REAL,                       -- NULL = 不衰减
  vec            BLOB,                       -- float32 小端，长度 = vec_dim*4
  vec_dim        INTEGER DEFAULT 0,
  vec_model      TEXT,
  created_at     REAL    NOT NULL,
  updated_at     REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_tier    ON memory(tier);
CREATE INDEX IF NOT EXISTS idx_memory_subject ON memory(subject);
CREATE INDEX IF NOT EXISTS idx_memory_ts      ON memory(ts);
CREATE INDEX IF NOT EXISTS idx_memory_tier_ts ON memory(tier, ts);

-- ---------------------------------------------------------------------------
-- BM25 倒排
--   doc_term 存 tf；term_stat 存 df（每写一条记忆增量维护，不做全量重扫）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_term (
  mem_id INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  term   TEXT    NOT NULL,
  tf     REAL    NOT NULL,
  PRIMARY KEY (mem_id, term)
);
CREATE INDEX IF NOT EXISTS idx_doc_term_term ON doc_term(term);

CREATE TABLE IF NOT EXISTS term_stat (
  term TEXT PRIMARY KEY,
  df   INTEGER NOT NULL DEFAULT 0
);

-- 文档长度（BM25 的 b 参数要用平均值）
CREATE TABLE IF NOT EXISTS doc_len (
  mem_id INTEGER PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
  len    REAL NOT NULL
);

-- ---------------------------------------------------------------------------
-- 杂项：词表版本、统计、schema 版本
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
INSERT OR IGNORE INTO meta(k, v) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO meta(k, v) VALUES ('tokenizer_version', 'cjk-bigram-1');

-- ---------------------------------------------------------------------------
-- 检索日志：用于调阈值（哪些 query 零结果、分数分布如何）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         REAL NOT NULL,
  query      TEXT NOT NULL,
  hits       INTEGER NOT NULL,
  top_score  REAL,
  top_bm25   REAL,
  top_vec    REAL,
  outcome    TEXT NOT NULL               -- ok | no_match | vec_only_rejected
);
CREATE INDEX IF NOT EXISTS idx_search_log_ts ON search_log(ts);
