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
-- 人格设定（二合一里的「人」那一半）
--
-- 为什么单独一张表、而不是塞进 memory 的 L4：
--   L4 是「记忆里的既成事实」，靠 MCP memory_ingest 手工灌，没有编辑入口，
--   还会被 export/import 当成记忆流搬来搬去。人格设定是「配置」：要能编辑、
--   要能分区、要能限制谁有权写哪一半 —— 用它自己的表最省事。
--
-- 两个字段就是那堵墙：
--   constitution 宪法区：身份、硬边界、称呼。只有设置页能改（服务端校验），
--                AI 那侧的 /persona/self 接口碰不到它。
--   self_model   自我认知区：AI 记录「我发现自己是什么样」。可演化，有长度上限。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS persona (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  constitution     TEXT NOT NULL DEFAULT '',
  self_model       TEXT NOT NULL DEFAULT '',
  updated_at       REAL NOT NULL DEFAULT 0,
  self_updated_at  REAL NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO persona(id, constitution, self_model, updated_at, self_updated_at)
  VALUES (1, '', '', 0, 0);

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

-- ---------------------------------------------------------------------------
-- 角色运行时状态（行为逻辑层）
--   mood         心情：normal / happy / tired / annoyed / bored
--   intimacy     亲密度 0-100，互动累积
--   diary        今天写的一句话
--   dnd_start    勿扰开始小时（默认 23）
--   dnd_end      勿扰结束小时（默认 8）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  mood             TEXT NOT NULL DEFAULT 'normal',
  mood_updated     REAL NOT NULL DEFAULT 0,
  intimacy         REAL NOT NULL DEFAULT 0,
  last_interaction REAL NOT NULL DEFAULT 0,
  diary            TEXT NOT NULL DEFAULT '',
  diary_date       TEXT NOT NULL DEFAULT '',
  dnd_start        INTEGER NOT NULL DEFAULT 23,
  dnd_end          INTEGER NOT NULL DEFAULT 8,
  valence          REAL NOT NULL DEFAULT 0,
  arousal          REAL NOT NULL DEFAULT 0.5,
  activity         TEXT NOT NULL DEFAULT '',
  weather          TEXT NOT NULL DEFAULT '',
  weather_updated  REAL NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO state(id) VALUES (1);

-- ---------------------------------------------------------------------------
-- 日记本：每天一篇（按日期唯一）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diary (
  date       TEXT PRIMARY KEY,          -- YYYY-MM-DD
  text       TEXT NOT NULL DEFAULT '',
  mood       TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 活动日志：她真的做过什么（时间线）
--   kind: chat / game / proactive / online / diary / other
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         REAL NOT NULL,
  kind       TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(ts);

-- ---------------------------------------------------------------------------
-- 学说话：用户口头禅/常用短语
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS slang (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phrase     TEXT NOT NULL UNIQUE,
  count      INTEGER NOT NULL DEFAULT 1,
  last_seen  REAL NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 社交亲和度：对不同的人的熟悉程度
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS affinity (
  user_id    TEXT PRIMARY KEY,
  score      REAL NOT NULL DEFAULT 0,
  last_seen  REAL NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 任务：她给主人派的任务（Phosphene 那类）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  points     INTEGER NOT NULL DEFAULT 1,
  created    REAL NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  done_at    REAL NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 共享便签：日历/留言
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT '',
  created    REAL NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 睡眠巩固：每晚整理
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sleep_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  created    REAL NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 表情包索引：每张图有情绪分类 + 描述 + 关键词（AI 按情绪找图）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meme (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file         TEXT NOT NULL UNIQUE,
  emotion      TEXT NOT NULL DEFAULT '',
  caption      TEXT NOT NULL DEFAULT '',
  keywords     TEXT NOT NULL DEFAULT '',
  used_count   INTEGER NOT NULL DEFAULT 0,
  created      REAL NOT NULL DEFAULT 0,
  updated      REAL NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 用户发过的图（按内容 hash 去重计数）：发得越多越说明喜欢
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meme_seen (
  hash       TEXT PRIMARY KEY,
  path       TEXT NOT NULL DEFAULT '',
  count      INTEGER NOT NULL DEFAULT 1,
  last_seen  REAL NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 她的见闻：刷到的东西（B 站热门等）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS browsed (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  title   TEXT NOT NULL DEFAULT '',
  url     TEXT NOT NULL DEFAULT '',
  ts      REAL NOT NULL DEFAULT 0
);
