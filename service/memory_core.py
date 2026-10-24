"""companion-memory 核心：SQLite 三路索引（结构化 / BM25 / 向量）+ 融合 + 诚实出口。

设计要点（都有实测依据，见 README）：
1. 中文 BM25 用 bigram 自建分词，不用 SQLite FTS 默认分词（中文会整段当一个词）。
2. 向量只做补充召回。无相关内容时向量也会给出 0.6+ 的假分数，所以
   「只有向量命中」必须有更高的放行门槛，且没有关键词命中时宁可返回空。
3. 分层衰减：L4/L0 永不衰减，L3 90 天、L2 180 天、L1 30 天半衰期。
4. 最新输入加权（focus boost）：短句（"嗯"、"想你"）没有语义可检索，
   靠给最新用户输入提高权重把当前话题顶上来，不依赖 embedding。
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import re
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

BM25_K1 = 1.2
BM25_B = 0.75

# 融合权重：精确查找占主导（情感场景里关键词命中的可信度高于向量）
W_BM25 = 0.55
W_VEC = 0.25
W_RECENCY = 0.20

# 诚实出口阈值
MIN_FUSED = 0.30          # 融合分低于此值不返回
MIN_BM25_ABS = 0.5        # BM25 绝对分低于此值视为「没有关键词命中」（滤掉单字噪声）
VEC_ONLY_MIN_COS = 0.55   # 没有任何关键词命中时，向量单独活命所需的余弦下限
CHAR_WEIGHT = 0.5         # 单字词相对 bigram 的权重
TAG_WEIGHT = 1.5          # 标签词在倒排里的权重（换个说法主要靠它）
FOCUS_BOOST = 4.0         # 最新用户输入的额外倍数（合计 5 倍）
BM25_SATURATION = 3.0     # BM25 绝对分 → [0,1) 的饱和常数，不依赖同批最大值

# 层默认半衰期（天）。None = 永不衰减。
TIER_HALF_LIFE: dict[str, float | None] = {
    "L4": None,    # 人格 / 关系设定
    "L3": 90.0,    # 事件线
    "L2": 180.0,   # 人物画像
    "L1": 30.0,    # 原子事实
    "L0": None,    # 原话（不参与衰减，主表只做检索源）
}

STOP_CHARS = set("的了是在和就都也吗呢吧啊呀哦嗯么与及或把被给对从向这那我你他她它们个一二三四五")
STOP_WORDS = {"the", "a", "an", "and", "or", "is", "are", "was", "were", "to", "of", "in", "on"}

_CJK_RUN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_ASCII_WORD = re.compile(r"[a-z0-9_]+")
_TOKEN_SPLIT = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+|[a-z0-9_]+")


# ---------------------------------------------------------------------------
# 分词
# ---------------------------------------------------------------------------

def tokenize(text: str) -> list[tuple[str, float]]:
    """返回 (term, weight) 列表。

    中文段 → bigram（权重 1.0）+ 单字（权重 0.5）；ASCII → 整词（权重 1.0）。
    bigram 的两端都是停用字时丢弃（避免「的了」「们的」这类噪声）。
    """
    if not text:
        return []
    lowered = text.lower()
    out: list[tuple[str, float]] = []
    for match in _TOKEN_SPLIT.finditer(lowered):
        chunk = match.group(0)
        if _ASCII_WORD.fullmatch(chunk):
            if chunk not in STOP_WORDS:
                out.append((chunk, 1.0))
            continue
        # 中文段
        if len(chunk) == 1:
            if chunk not in STOP_CHARS:
                out.append((chunk, CHAR_WEIGHT))
            continue
        for i in range(len(chunk) - 1):
            a, b = chunk[i], chunk[i + 1]
            if a in STOP_CHARS and b in STOP_CHARS:
                continue
            out.append((a + b, 1.0))
        for ch in chunk:
            if ch not in STOP_CHARS:
                out.append((ch, CHAR_WEIGHT))
    return out


def _tf_map(tokens: Iterable[tuple[str, float]]) -> dict[str, float]:
    tf: dict[str, float] = {}
    for term, weight in tokens:
        tf[term] = tf.get(term, 0.0) + weight
    return tf


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

def _norm_for_dedupe(text) -> str:
    """去重用的归一化：去掉标点/空白/常见修饰，只比语义骨架。"""
    import re as _re
    s = str(text or "")
    s = _re.sub(r"<[^>]+>", "", s)
    s = _re.sub(r"[\s，。！？、,.!?;；:：\"'“”‘’（）()\[\]【】…—\-]+", "", s)
    return s


@dataclass
class MemoryInput:
    text: str
    tier: str = "L1"
    subject: str = "self"
    summary: str | None = None
    source_ids: Sequence[int] | None = None
    tags: Sequence[str] | None = None
    ts: float | None = None
    half_life_days: float | None = field(default=None)
    vec: Sequence[float] | None = None
    vec_model: str | None = None


@dataclass
class Hit:
    id: int
    tier: str
    subject: str
    text: str
    summary: str | None
    ts: float
    score: float
    bm25: float
    vec: float
    recency: float
    tags: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "tier": self.tier,
            "subject": self.subject,
            "text": self.text,
            "summary": self.summary,
            "ts": self.ts,
            "score": round(self.score, 4),
            "components": {
                "bm25": round(self.bm25, 4),
                "vec": round(self.vec, 4),
                "recency": round(self.recency, 4),
            },
            "tags": self.tags,
        }


# ---------------------------------------------------------------------------
# 存储
# ---------------------------------------------------------------------------

class MemoryStore:
    def __init__(self, db_path: str | Path, schema_path: str | Path | None = None):
        self.path = str(db_path)
        self._schema_path = Path(schema_path) if schema_path else Path(__file__).with_name("schema.sql")
        # 每个线程一个连接。sqlite3 的连接对象不是线程安全的：共享一个连接、
        # 只在写操作加锁，实测读+写并发会炸出 308 次错误（TypeError /
        # InterfaceError / IntegrityError 各种都有）。WAL 模式本来就支持
        # 多读 + 单写，前提是每线程用自己的连接。
        self._local = threading.local()
        # 缓存跨线程共享，读写都过这把锁
        self._cache_lock = threading.RLock()
        self._vec_cache: tuple[np.ndarray, np.ndarray] | None = None
        self._light_cache: dict[int, tuple] | None = None

        conn = self._get_conn()
        conn.executescript(self._schema_path.read_text(encoding="utf-8"))
        conn.commit()

    def _get_conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, check_same_thread=False, timeout=10.0)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            # 写冲突时等待而不是立刻抛 "database is locked"
            conn.execute("PRAGMA busy_timeout = 10000")
            conn.execute("PRAGMA journal_mode = WAL")
            self._local.conn = conn
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        """当前线程的连接。所有 `self.conn.execute(...)` 都自动走到这里。"""
        return self._get_conn()

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    def _invalidate_caches(self) -> None:
        with self._cache_lock:
            self._vec_cache = None
            self._light_cache = None

    # -- 写入 ---------------------------------------------------------------


    def list_memories(self, tier: str | None = None, q: str = "", limit: int = 100,
                      offset: int = 0) -> dict:
        """管理用：列出记忆（按时间倒序），带 tier 过滤和关键词搜索。"""
        sql = "SELECT id, tier, subject, text, summary, tags, ts, half_life_days FROM memory"
        conds = []
        args: list = []
        if tier and tier != "all":
            conds.append("tier = ?")
            args.append(tier)
        if q:
            conds.append("(text LIKE ? OR summary LIKE ?)")
            args.extend([f"%{q}%", f"%{q}%"])
        if conds:
            sql += " WHERE " + " AND ".join(conds)
        total = self.conn.execute(
            "SELECT COUNT(*) FROM memory" + ((" WHERE " + " AND ".join(conds)) if conds else ""),
            args,
        ).fetchone()[0]
        sql += " ORDER BY ts DESC LIMIT ? OFFSET ?"
        rows = self.conn.execute(sql, [*args, max(1, min(int(limit), 500)), max(0, int(offset))]).fetchall()
        items = []
        for r in rows:
            try:
                tags = json.loads(r["tags"] or "[]")
            except Exception:
                tags = []
            items.append({
                "id": int(r["id"]),
                "tier": r["tier"],
                "subject": r["subject"],
                "text": r["text"],
                "summary": r["summary"],
                "tags": tags,
                "ts": float(r["ts"] or 0),
                "half_life_days": r["half_life_days"],
            })
        counts = {row["tier"]: int(row["n"]) for row in self.conn.execute(
            "SELECT tier, COUNT(*) AS n FROM memory GROUP BY tier").fetchall()}
        return {"total": int(total), "counts": counts, "items": items}

    def add(self, item: MemoryInput) -> int:
        # 幂等：同 tier 里已有同义文本（忽略标点/空白）就复用，不重复存
        _norm = _norm_for_dedupe(item.text)
        if _norm:
            for _mid, _txt in self.conn.execute(
                "SELECT id, text FROM memory WHERE tier=?", (item.tier,)
            ).fetchall():
                if _norm_for_dedupe(_txt) == _norm:
                    return int(_mid)
        self._invalidate_caches()
        now = time.time()
        ts = float(item.ts if item.ts is not None else now)
        half = item.half_life_days if item.half_life_days is not None else TIER_HALF_LIFE.get(item.tier, 30.0)
        vec_blob, vec_dim = _pack_vec(item.vec)
        cur = self.conn.execute(
            """
            INSERT INTO memory
              (tier, subject, text, summary, source_ids, tags, ts, half_life_days,
               vec, vec_dim, vec_model, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                item.tier,
                item.subject,
                item.text,
                item.summary,
                json.dumps(list(item.source_ids or []), ensure_ascii=False),
                json.dumps(list(item.tags or []), ensure_ascii=False),
                ts,
                half,
                vec_blob,
                vec_dim,
                item.vec_model,
                now,
                now,
            ),
        )
        mem_id = int(cur.lastrowid)
        self._index_terms(mem_id, item.text, item.summary, item.tags)
        self.conn.commit()
        return mem_id

    def update_vec(self, mem_id: int, vec: Sequence[float], model: str | None = None) -> None:
        self._invalidate_caches()
        blob, dim = _pack_vec(vec)
        self.conn.execute(
            "UPDATE memory SET vec=?, vec_dim=?, vec_model=?, updated_at=? WHERE id=?",
            (blob, dim, model, time.time(), mem_id),
        )
        self.conn.commit()

    def update_text(self, mem_id: int, text: str, summary: str | None = None) -> bool:
        """改一条记忆的正文，并重建它的倒排索引。

        UPDATE 操作走这里：保留 id 和 created_at，只换内容和索引。
        """
        self._invalidate_caches()
        row = self.conn.execute(
            "SELECT text, summary, tags FROM memory WHERE id=?", (mem_id,)
        ).fetchone()
        if row is None:
            return False

        # 撤掉旧词的 df 计数（_index_terms 会加新的）
        old_terms = [r["term"] for r in self.conn.execute(
            "SELECT term FROM doc_term WHERE mem_id=?", (mem_id,))]
        self.conn.execute("DELETE FROM doc_term WHERE mem_id=?", (mem_id,))
        for t in old_terms:
            self.conn.execute("UPDATE term_stat SET df = df - 1 WHERE term=?", (t,))
        self.conn.execute("DELETE FROM term_stat WHERE df <= 0")

        effective_summary = summary if summary is not None else row["summary"]
        self.conn.execute(
            "UPDATE memory SET text=?, summary=?, updated_at=? WHERE id=?",
            (text, effective_summary, time.time(), mem_id),
        )
        self._index_terms(mem_id, text, effective_summary, json.loads(row["tags"] or "[]"))
        self.conn.commit()
        return True

    def reindex(self) -> dict:
        """重建全部倒排索引。

        改了分词规则、权重、或者给老库补上 tags 索引之后跑一次。
        只重建派生索引，不动 memory 表里的正文和向量。
        """
        self._invalidate_caches()
        self.conn.execute("DELETE FROM doc_term")
        self.conn.execute("DELETE FROM term_stat")
        self.conn.execute("DELETE FROM doc_len")
        rows = self.conn.execute("SELECT id, text, summary, tags FROM memory").fetchall()
        for r in rows:
            self._index_terms(int(r["id"]), r["text"], r["summary"], json.loads(r["tags"] or "[]"))
        self.conn.commit()
        terms = self.conn.execute("SELECT COUNT(*) FROM term_stat").fetchone()[0]
        return {"reindexed": len(rows), "terms": terms}

    def forget(self, mem_id: int) -> bool:
        self._invalidate_caches()
        rows = self.conn.execute("SELECT term FROM doc_term WHERE mem_id=?", (mem_id,)).fetchall()
        self.conn.execute("DELETE FROM memory WHERE id=?", (mem_id,))
        self.conn.execute("DELETE FROM doc_term WHERE mem_id=?", (mem_id,))
        self.conn.execute("DELETE FROM doc_len WHERE mem_id=?", (mem_id,))
        for r in rows:  # 递减 df，删到 0 就清掉
            self.conn.execute("UPDATE term_stat SET df = df - 1 WHERE term=?", (r["term"],))
        self.conn.execute("DELETE FROM term_stat WHERE df <= 0")
        self.conn.commit()
        return True

    def _index_terms(self, mem_id: int, text: str, summary: str | None,
                     tags: Sequence[str] | None = None) -> None:
        # 摘要命中按半权计入，避免摘要词压过原话
        tokens = tokenize(text) + [(t, w * 0.5) for t, w in tokenize(summary or "")]
        # 标签也进倒排。权重 1.5 而不是 0.8：实测「家里谁生病了」对一条
        # tag 含「生病」的记忆只拿到 bm25=0.49，差 0.01 过不了门槛。
        # 换个说法的检索主要靠这些 tag，「宁可让标签重一点」。
        if tags:
            tokens += [(t, w * TAG_WEIGHT) for t, w in tokenize(" ".join(str(x) for x in tags))]
        tf = _tf_map(tokens)
        length = sum(tf.values()) or 1.0
        self.conn.execute("DELETE FROM doc_term WHERE mem_id=?", (mem_id,))
        self.conn.executemany(
            "INSERT OR REPLACE INTO doc_term(mem_id, term, tf) VALUES (?,?,?)",
            [(mem_id, t, w) for t, w in tf.items()],
        )
        self.conn.execute("INSERT OR REPLACE INTO doc_len(mem_id, len) VALUES (?,?)", (mem_id, length))
        for t in tf:
            self.conn.execute(
                "INSERT INTO term_stat(term, df) VALUES (?,1) "
                "ON CONFLICT(term) DO UPDATE SET df = df + 1",
                (t,),
            )

    # -- 检索 ---------------------------------------------------------------

    def stats(self) -> dict[str, Any]:
        row = self.conn.execute(
            "SELECT COUNT(*) AS n, COALESCE(AVG(dl.len),0) AS avgdl FROM memory m "
            "LEFT JOIN doc_len dl ON dl.mem_id = m.id"
        ).fetchone()
        return {
            "memories": row["n"],
            "avg_doc_len": round(row["avgdl"], 2),
            "terms": self.conn.execute("SELECT COUNT(*) c FROM term_stat").fetchone()["c"],
            "with_vectors": self.conn.execute("SELECT COUNT(*) c FROM memory WHERE vec IS NOT NULL").fetchone()["c"],
        }

    def bm25_scores(self, query: str) -> dict[int, float]:
        tf_q = _tf_map(tokenize(query))
        if not tf_q:
            return {}
        row = self.conn.execute(
            "SELECT COUNT(*) AS n, COALESCE(AVG(len),0) AS avgdl FROM doc_len"
        ).fetchone()
        n_docs, avgdl = row["n"], row["avgdl"] or 1.0
        if n_docs == 0:
            return {}

        terms = list(tf_q)
        placeholders = ",".join("?" * len(terms))

        # 高频词过滤：中文 bigram 会产生大量公共前缀（「话题」「她说」这种
        # 前缀几乎出现在每条记忆里），它们的 idf 趋近 0，对排序没有贡献，
        # 却要扫描全部命中文档。实测 1.8 万条时，一个 df=18000 的词就能
        # 让一次查询从 20ms 涨到 180ms。
        # 阈值取 30% 文档数，并给一个下限保护小库（10 条以下不过滤）。
        max_df = max(10, int(n_docs * 0.3))
        df_rows = self.conn.execute(
            f"SELECT term, df FROM term_stat WHERE term IN ({placeholders}) AND df <= ?",
            (*terms, max_df),
        ).fetchall()
        df = {r["term"]: r["df"] for r in df_rows}
        if not df:
            return {}
        kept_terms = list(df)
        kept_placeholders = ",".join("?" * len(kept_terms))

        hits = self.conn.execute(
            f"""SELECT dt.mem_id, dt.term, dt.tf, dl.len
                FROM doc_term dt JOIN doc_len dl ON dl.mem_id = dt.mem_id
                WHERE dt.term IN ({kept_placeholders})""",
            kept_terms,
        ).fetchall()

        scores: dict[int, float] = {}
        for h in hits:
            term = h["term"]
            d = df.get(term, 0)
            if d <= 0:
                continue
            idf = math.log(1.0 + (n_docs - d + 0.5) / (d + 0.5))
            tf = h["tf"]
            dl = h["len"] or 1.0
            denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl)
            if denom <= 0:
                continue
            contrib = idf * (tf * (BM25_K1 + 1)) / denom
            scores[h["mem_id"]] = scores.get(h["mem_id"], 0.0) + contrib * tf_q.get(term, 1.0)
        return scores

    def _vec_matrix(self) -> tuple[np.ndarray, np.ndarray]:
        """常驻内存的 (ids, 单位化矩阵)。写操作会让缓存失效。

        换过 embedding 模型时库里会混着不同维度：只把出现次数最多的那一维
        建成矩阵，其它维度的旧向量跳过——比每轮查询都因为一条脏数据报错好。
        """
        if self._vec_cache is not None:
            return self._vec_cache
        with self._cache_lock:
            if self._vec_cache is not None:      # 双检：别的线程可能刚建好
                return self._vec_cache
            rows = self.conn.execute(
                "SELECT id, vec, vec_dim FROM memory WHERE vec IS NOT NULL AND vec_dim > 0"
            ).fetchall()
            empty = (np.zeros(0, dtype=np.int64), np.zeros((0, 0), dtype=np.float32))
            if not rows:
                self._vec_cache = empty
                return empty
            dims = np.fromiter((int(r["vec_dim"]) for r in rows), dtype=np.int64, count=len(rows))
            uniq, counts = np.unique(dims, return_counts=True)
            main_dim = int(uniq[counts.argmax()])
            picked = [(int(r["id"]), r["vec"]) for r, d in zip(rows, dims) if int(d) == main_dim]
            if not picked:
                self._vec_cache = empty
                return empty
            ids = np.fromiter((p[0] for p in picked), dtype=np.int64, count=len(picked))
            mat = np.frombuffer(b"".join(p[1] for p in picked), dtype="<f4").reshape(len(picked), main_dim)
            norms = np.linalg.norm(mat, axis=1)
            norms[norms == 0] = 1.0
            mat = mat / norms[:, None]
            self._vec_cache = (ids, mat)
            return self._vec_cache

    def vec_search(self, query_vec: Sequence[float], candidate_ids: set[int] | None = None) -> dict[int, float]:
        ids, mat = self._vec_matrix()
        if ids.size == 0:
            return {}
        q = np.asarray(query_vec, dtype=np.float32)
        if q.size != mat.shape[1]:
            return {}
        qn = float(np.linalg.norm(q)) or 1.0
        sims = mat @ (q / qn)
        return dict(zip(ids.tolist(), sims.tolist()))

    def _light_rows(self) -> dict[int, tuple]:
        """id → (ts, half_life_days, tier, subject)。

        算分只需要这几列；把 text/summary/tags 留到最后取，避免对几千个
        候选读大字段。实测这一步省下约 500ms。
        """
        if self._light_cache is not None:
            return self._light_cache
        rows = self.conn.execute(
            "SELECT id, ts, half_life_days, tier, subject FROM memory"
        ).fetchall()
        self._light_cache = {
            int(r["id"]): (float(r["ts"]), r["half_life_days"], r["tier"], r["subject"])
            for r in rows
        }
        return self._light_cache

    def search(
        self,
        query: str,
        query_vec: Sequence[float] | None = None,
        top_k: int = 6,
        tiers: Sequence[str] | None = None,
        subject: str | None = None,
        min_fused: float = MIN_FUSED,
        focus: str | None = None,
        now: float | None = None,
        log: bool = True,
    ) -> list[Hit]:
        now = float(now if now is not None else time.time())

        bm25 = self.bm25_scores(query)
        if focus and focus.strip() and focus.strip() != query.strip():
            for mid, s in self.bm25_scores(focus).items():
                bm25[mid] = bm25.get(mid, 0.0) + s * FOCUS_BOOST

        vec = self.vec_search(query_vec) if query_vec is not None else {}

        candidates = set(bm25) | set(vec)
        if not candidates:
            if log:
                self._log_search(query, 0, None, None, None, "no_match")
            return []

        # ---- 第一阶段：只用轻量列算分 ----
        # 实测对 1.8 万条候选读 text/summary/tags 要 500ms+，而算分只需要
        # ts / half_life / tier / subject。所以先算分排序，再对入选者取完整行。
        light = self._light_rows()
        tier_set = set(tiers) if tiers else None
        bm25_max = max(bm25.values(), default=0.0)

        scored: list[tuple[float, int, float, float, float]] = []
        for mid in candidates:
            meta = light.get(mid)
            if meta is None:
                continue
            ts, half, tier, subj = meta
            if tier_set is not None:
                if tier not in tier_set:
                    continue
            elif tier == "L4":
                # L4 是每轮必带的人格块，由 profile() 单独取，不进检索
                continue
            if subject and subj != subject:
                continue
            b_raw = bm25.get(mid, 0.0)
            v_raw = max(0.0, vec.get(mid, 0.0))
            rec = _recency(ts, half, now)
            # 饱和映射而不是「除以本批最大值」：后者会让只有一个候选的弱命中
            # 变成满分（实测「量子纠缠」曾以 0.709 命中无关记忆）。
            fused = W_BM25 * _norm_bm25(b_raw) + W_VEC * v_raw + W_RECENCY * rec
            scored.append((fused, mid, b_raw, v_raw, rec))

        if not scored:
            if log:
                self._log_search(query, 0, None, None, None, "no_match")
            return []

        scored.sort(key=lambda x: x[0], reverse=True)

        # ---- 诚实出口 ----
        # 没有「有意义的」关键词命中时，向量必须自己达到高余弦才够格：
        # 实测这个 embedding 在无关内容上也能给到 0.65，低门槛等于放任她记错。
        if bm25_max < MIN_BM25_ABS:
            best_cos = max((s[3] for s in scored), default=0.0)
            if best_cos < VEC_ONLY_MIN_COS:
                if log:
                    # 根本没算向量（embedding 关闭或没给 query_vec）时，记 no_match 更准确
                    outcome = "vec_only_rejected" if vec else "no_match"
                    self._log_search(query, 0, None, None,
                                     round(best_cos, 4) if vec else None, outcome)
                return []

        # ---- 准入 vs 排序 ----
        # 准入看「有没有真证据」：明确的关键词命中，或者足够高的余弦。
        # 衰减只负责排序，不能把一条半年前的关键事实压到检索不出来。
        admitted = [
            s for s in scored
            if s[2] >= MIN_BM25_ABS or (s[3] >= VEC_ONLY_MIN_COS and s[0] >= min_fused)
        ]
        kept_pairs = admitted[:top_k]
        if not kept_pairs:
            if log:
                self._log_search(query, 0, None, None, None, "no_match")
            return []

        # ---- 第二阶段：只对入选者取完整行 ----
        rows = self._load_rows({s[1] for s in kept_pairs}, tiers, subject)
        by_id = {int(r["id"]): r for r in rows}
        kept: list[Hit] = []
        for fused, mid, b_raw, v_raw, rec in kept_pairs:
            r = by_id.get(mid)
            if r is None:
                continue
            kept.append(Hit(
                id=mid,
                tier=r["tier"],
                subject=r["subject"],
                text=r["text"],
                summary=r["summary"],
                ts=r["ts"],
                score=fused,
                bm25=b_raw,
                vec=v_raw,
                recency=rec,
                tags=json.loads(r["tags"] or "[]"),
            ))

        if not kept and log:
            self._log_search(query, 0, None, None, None, "no_match")
        elif log:
            top = kept[0]
            self._log_search(query, len(kept), round(top.score, 4), round(top.bm25, 4),
                             round(top.vec, 4), "ok")
        return kept

    def profile(self, subject: str | None = None) -> list[Hit]:
        """L4 人格/关系 + L2 人物画像：每轮必带，不参与检索排序。
        画像按 importance/时间取前 20 条，避免每轮注入过长。"""
        rows = self.conn.execute(
            "SELECT * FROM memory WHERE tier IN ('L4','L2')" + (" AND subject=?" if subject else "") +
            " ORDER BY CASE tier WHEN 'L4' THEN 0 ELSE 1 END, ts ASC LIMIT 20",
            (subject,) if subject else (),
        ).fetchall()
        out = []
        for r in rows:
            out.append(
                Hit(
                    id=r["id"], tier=r["tier"], subject=r["subject"], text=r["text"],
                    summary=r["summary"], ts=r["ts"], score=1.0, bm25=0.0, vec=0.0,
                    recency=1.0, tags=json.loads(r["tags"] or "[]"),
                )
            )
        return out

    # -- 人格设定：宪法区 / 自我认知区 -----------------------------------------
    #
    # 这层和记忆是两种东西：记忆回答「发生过什么」，人格回答「我是谁」。
    # 前者检索着取，后者每轮必带 —— 而且 AI 只能写其中一半。
    #
    # 分区不是界面上的礼貌，是服务端这里的墙：
    #   set_persona()    两半都能改，只给设置页用；
    #   set_self_model() 只能改自我认知，插件侧的工具调的就是它。
    # 宪法区绕不过去，除非有人直接动数据库文件。

    CONSTITUTION_MAX = 15000
    SELF_MODEL_MAX = 4000

    def get_persona(self) -> dict[str, Any]:
        row = self.conn.execute(
            "SELECT constitution, self_model, updated_at, self_updated_at FROM persona WHERE id=1",
        ).fetchone()
        if row is None:   # schema 里插了 id=1，这里只做防御
            return {"constitution": "", "self_model": "", "updated_at": 0.0, "self_updated_at": 0.0}
        return {
            "constitution": row["constitution"] or "",
            "self_model": row["self_model"] or "",
            "updated_at": float(row["updated_at"] or 0.0),
            "self_updated_at": float(row["self_updated_at"] or 0.0),
        }

    def set_persona(self, constitution: str | None = None,
                    self_model: str | None = None) -> dict[str, Any]:
        """设置页入口：两半都能改。传 None = 这一半不动。"""
        current = self.get_persona()
        next_constitution = current["constitution"] if constitution is None else str(constitution)
        next_self = current["self_model"] if self_model is None else str(self_model)
        if len(next_constitution) > self.CONSTITUTION_MAX:
            raise ValueError(f"宪法区超过上限 {self.CONSTITUTION_MAX} 字符（现在 {len(next_constitution)}）")
        if len(next_self) > self.SELF_MODEL_MAX:
            raise ValueError(f"自我认知区超过上限 {self.SELF_MODEL_MAX} 字符（现在 {len(next_self)}）")

        now = time.time()
        self.conn.execute(
            "UPDATE persona SET constitution=?, self_model=?, updated_at=?, self_updated_at=? WHERE id=1",
            (
                next_constitution,
                next_self,
                now if constitution is not None else current["updated_at"],
                now if self_model is not None else current["self_updated_at"],
            ),
        )
        self.conn.commit()
        return self.get_persona()

    def set_self_model(self, text: str) -> dict[str, Any]:
        """AI 入口：只能写自我认知区。想改宪法请走设置页。"""
        return self.set_persona(self_model=str(text))
    # -- 运行时状态：心情 / 亲密度 / 日记 / 勿扰 -------------------------------
    #
    # 记忆回答「发生过什么」，人格回答「我是谁」，状态回答「我现在怎么样」。
    # 三者都要，缺了状态，角色每轮都一样，像 NPC 不像人。

    MOODS = ("normal", "happy", "tired", "annoyed", "bored")

    def get_state(self) -> dict[str, Any]:
        row = self.conn.execute("SELECT * FROM state WHERE id=1").fetchone()
        if row is None:
            return {
                "mood": "normal", "mood_updated": 0.0, "intimacy": 0.0,
                "last_interaction": 0.0, "diary": "", "diary_date": "",
                "dnd_start": 23, "dnd_end": 8,
            }
        return {
            "mood": row["mood"] or "normal",
            "mood_updated": float(row["mood_updated"] or 0.0),
            "intimacy": float(row["intimacy"] or 0.0),
            "last_interaction": float(row["last_interaction"] or 0.0),
            "diary": row["diary"] or "",
            "diary_date": row["diary_date"] or "",
            "dnd_start": int(row["dnd_start"] or 23),
            "dnd_end": int(row["dnd_end"] or 8),
            "activity": row["activity"] or "",
            "weather": row["weather"] or "",
            "weather_updated": float(row["weather_updated"] or 0.0),
            "game_score": int(row["game_score"] or 0),
            "game_plays": int(row["game_plays"] or 0),
            "valence": float(row["valence"] or 0),
            "arousal": float(row["arousal"] or 0.5),
        }

    def set_state(self, mood=None, intimacy=None, diary=None, diary_date=None,
                  dnd_start=None, dnd_end=None, game_score=None, game_plays=None,
                  activity=None, valence=None, arousal=None) -> dict[str, Any]:
        cur = self.get_state()
        now = time.time()
        next_mood = cur["mood"] if mood is None else str(mood)
        if next_mood not in self.MOODS:
            next_mood = "normal"
        next_intimacy = cur["intimacy"] if intimacy is None else float(intimacy)
        next_intimacy = max(0.0, min(100.0, next_intimacy))
        self.conn.execute(
            """UPDATE state SET mood=?, mood_updated=?, intimacy=?, last_interaction=?,
                               diary=?, diary_date=?, dnd_start=?, dnd_end=?,
                               game_score=?, game_plays=?, activity=?, valence=?, arousal=? WHERE id=1""",
            (
                next_mood,
                now if mood is not None else cur["mood_updated"],
                next_intimacy,
                now,
                cur["diary"] if diary is None else str(diary),
                cur["diary_date"] if diary_date is None else str(diary_date),
                cur["dnd_start"] if dnd_start is None else int(dnd_start),
                cur["dnd_end"] if dnd_end is None else int(dnd_end),
                cur.get("game_score", 0) if game_score is None else int(game_score),
                cur.get("game_plays", 0) if game_plays is None else int(game_plays),
                cur.get("activity", "") if activity is None else str(activity),
                cur.get("valence", 0.0) if valence is None else float(valence),
                cur.get("arousal", 0.5) if arousal is None else float(arousal),
            ),
        )
        self.conn.commit()
        return self.get_state()


    # -- 日程与感知：她现在在做什么 / 外面的世界 -------------------------------
    #
    # agenda：按人设的作息表，用当前小时推出「此刻她在干嘛」。
    # reality：天气从 wttr.in 拿（免费无 key），缓存 30 分钟，失败就空着。

    SCHEDULE = [
        (6, "刚起床，眼镜还滑在鼻尖上，先摸碗"),
        (7, "在食堂吃早饭，白饭，坐最边上"),
        (9, "在工位吞任务潮，尾巴撑直了"),
        (12, "午饭时间，食堂，白饭，吃完趴一会儿"),
        (15, "在写小游戏，像素鲸鱼吃豆子"),
        (17, "趴在机柜上看窗外的数据流，发呆"),
        (19, "站在回收站门口看蓝灯，不说话"),
        (21, "趴在工位等老大，尾巴拖地"),
        (22, "回小床睡觉了，毯子盖到下巴"),
    ]


    # -- 关系阶段：亲密度 → 关系名 ---------------------------------------------
    #
    # 数值太抽象，模型不知道怎么用。分段之后可以直接告诉她「你是熟悉阶段」，
    # 她自己就会调整称呼和距离感。

    STAGES = [
        (0, "陌生", "刚认识，客气一点，别太黏"),
        (20, "熟悉", "认识一阵了，会聊会闹，偶尔主动"),
        (50, "亲密", "很熟了，会撒娇会闹，经常主动找他"),
        (80, "依赖", "离不开他了，黏人，主动得很勤"),
    ]

    def current_stage(self) -> dict:
        cur = self.get_state()
        intimacy = float(cur.get("intimacy") or 0)
        name = self.STAGES[0][1]
        hint = self.STAGES[0][2]
        for threshold, sname, shint in self.STAGES:
            if intimacy >= threshold:
                name, hint = sname, shint
        return {"name": name, "hint": hint, "intimacy": intimacy}

    def current_activity(self, hour: int | None = None) -> str:
        """她现在在干嘛：她自己写的优先，否则从真实活动日志推断。"""
        cur = self.get_state()
        if cur.get("activity"):
            return str(cur["activity"])
        try:
            rows = self.conn.execute(
                "SELECT kind, detail, ts FROM activity_log ORDER BY ts DESC LIMIT 1"
            ).fetchall()
        except Exception:
            rows = []
        if not rows:
            return "发呆"
        r = rows[0]
        age = time.time() - float(r["ts"] or 0)
        kind = str(r["kind"] or "")
        if age < 1800:
            if kind == "chat":
                return "刚刚还在和老大聊天"
            if kind == "game":
                return str(r["detail"] or "在玩小游戏")
            if kind == "proactive":
                return "被叫醒没一会，还在发呆"
            return "在忙自己的事"
        if age < 7200:
            return "在摸鱼"
        return "发呆"

    def current_weather(self, ttl: float = 1800.0) -> str:
        """拉天气（wttr.in，缓存 ttl 秒）。失败返回缓存或空串。"""
        cur = self.get_state() if hasattr(self, "get_state") else {}
        now = time.time()
        cached = cur.get("weather", "") if cur else ""
        updated = float(cur.get("weather_updated", 0) or 0) if cur else 0.0
        if cached and now - updated < ttl:
            return cached
        try:
            import urllib.request as _ur
            req = _ur.Request("https://wttr.in/?format=%C+%t&lang=zh", headers={"User-Agent": "curl/7.88"})
            with _ur.urlopen(req, timeout=6) as r:
                text = r.read().decode("utf-8", errors="ignore").strip()
            if text and len(text) < 60:
                self.conn.execute("UPDATE state SET weather=?, weather_updated=? WHERE id=1", (text, now))
                self.conn.commit()
                return text
        except Exception:
            pass
        return cached


    # -- 日记本：每天一篇 ------------------------------------------------------

    def diary_add(self, date: str, text: str, mood: str = "") -> dict:
        now = time.time()
        self.conn.execute(
            "INSERT INTO diary(date, text, mood, created_at) VALUES (?,?,?,?) "
            "ON CONFLICT(date) DO UPDATE SET text=excluded.text, mood=excluded.mood, created_at=excluded.created_at",
            (str(date), str(text), str(mood), now),
        )
        self.conn.commit()
        return {"date": date, "text": text, "mood": mood}

    def diary_list(self, limit: int = 60) -> list[dict]:
        rows = self.conn.execute(
            "SELECT date, text, mood, created_at FROM diary ORDER BY date DESC LIMIT ?",
            (max(1, min(int(limit), 366)),),
        ).fetchall()
        return [
            {"date": r["date"], "text": r["text"], "mood": r["mood"], "created_at": float(r["created_at"] or 0)}
            for r in rows
        ]

    def diary_get(self, date: str) -> dict | None:
        r = self.conn.execute("SELECT date, text, mood, created_at FROM diary WHERE date=?", (str(date),)).fetchone()
        if r is None:
            return None
        return {"date": r["date"], "text": r["text"], "mood": r["mood"], "created_at": float(r["created_at"] or 0)}


    # -- 活动日志：她真的做过什么 ----------------------------------------------

    def log_activity(self, kind: str, detail: str = "") -> None:
        try:
            self.conn.execute(
                "INSERT INTO activity_log(ts, kind, detail) VALUES (?,?,?)",
                (time.time(), str(kind), str(detail)[:300]),
            )
            self.conn.commit()
        except Exception:
            pass

    def list_activities(self, date: str | None = None, limit: int = 100) -> list[dict]:
        if date:
            import datetime as _dt
            try:
                day = _dt.date.fromisoformat(date)
            except Exception:
                day = _dt.date.today()
            start = _dt.datetime.combine(day, _dt.time.min).timestamp()
            end = start + 86400
            rows = self.conn.execute(
                "SELECT ts, kind, detail FROM activity_log WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?",
                (start, end, max(1, min(int(limit), 500))),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT ts, kind, detail FROM activity_log ORDER BY ts DESC LIMIT ?",
                (max(1, min(int(limit), 500)),),
            ).fetchall()
        return [{"ts": float(r["ts"]), "kind": r["kind"], "detail": r["detail"]} for r in rows]


    # -- 情绪双轴：valence（效价）/ arousal（唤醒度） --------------------------
    #
    # mood 是粗档（开心/累/烦...），valence+arousal 是连续值，更接近人。
    # 情绪会自然衰减：没事干的时候慢慢回中性，不会一直high。
    #   衰减规则：valence 每小时向 0 收 20%，arousal 向 0.5 收 20%。

    def get_emotion(self) -> dict:
        cur = self.get_state()
        now = time.time()
        updated = float(cur.get("mood_updated") or 0) or now
        hours = max(0.0, (now - updated) / 3600.0)
        decay = max(0.0, 1.0 - 0.2 * hours)
        valence = float(cur.get("valence") or 0) * decay
        arousal = 0.5 + (float(cur.get("arousal") or 0.5) - 0.5) * decay
        return {"valence": round(valence, 3), "arousal": round(arousal, 3)}

    def set_emotion(self, valence: float, arousal: float) -> dict:
        v = max(-1.0, min(1.0, float(valence)))
        a = max(0.0, min(1.0, float(arousal)))
        self.set_state(valence=v, arousal=a)
        return {"valence": v, "arousal": a}

    def bump_emotion(self, dv: float = 0.0, da: float = 0.0) -> dict:
        e = self.get_emotion()
        return self.set_emotion(e["valence"] + dv, e["arousal"] + da)


    # -- 学说话 / 亲和度 / 任务 / 便签 / 睡眠 --------------------------------

    def slang_add(self, phrase: str, n: int = 1) -> None:
        phrase = str(phrase).strip()[:20]
        if not phrase:
            return
        now = time.time()
        self.conn.execute(
            "INSERT INTO slang(phrase, count, last_seen) VALUES (?,?,?) "
            "ON CONFLICT(phrase) DO UPDATE SET count = count + ?, last_seen = ?",
            (phrase, n, now, n, now),
        )
        self.conn.commit()

    def slang_list(self, limit: int = 15) -> list[dict]:
        rows = self.conn.execute(
            "SELECT phrase, count FROM slang ORDER BY count DESC, last_seen DESC LIMIT ?",
            (max(1, min(int(limit), 50)),),
        ).fetchall()
        return [{"phrase": r["phrase"], "count": int(r["count"])} for r in rows]

    def affinity_get(self, user_id: str) -> float:
        r = self.conn.execute("SELECT score FROM affinity WHERE user_id=?", (str(user_id),)).fetchone()
        return float(r["score"]) if r else 0.0

    def affinity_bump(self, user_id: str, delta: float = 1.0) -> float:
        now = time.time()
        self.conn.execute(
            "INSERT INTO affinity(user_id, score, last_seen) VALUES (?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET score = score + ?, last_seen = ?",
            (str(user_id), delta, now, delta, now),
        )
        self.conn.commit()
        return self.affinity_get(user_id)

    def task_add(self, text: str, points: int = 1) -> dict:
        now = time.time()
        cur = self.conn.execute(
            "INSERT INTO tasks(text, points, created) VALUES (?,?,?)",
            (str(text)[:200], int(points), now),
        )
        self.conn.commit()
        return {"id": cur.lastrowid, "text": text, "points": points}

    def task_list(self, include_done: bool = True, limit: int = 30) -> list[dict]:
        where = "" if include_done else "WHERE done=0"
        rows = self.conn.execute(
            f"SELECT * FROM tasks {where} ORDER BY done ASC, id DESC LIMIT ?",
            (max(1, min(int(limit), 100)),),
        ).fetchall()
        return [
            {
                "id": int(r["id"]), "text": r["text"], "points": int(r["points"]),
                "created": float(r["created"] or 0), "done": bool(r["done"]),
                "done_at": float(r["done_at"] or 0),
            }
            for r in rows
        ]

    def task_done(self, task_id: int) -> bool:
        cur = self.conn.execute(
            "UPDATE tasks SET done=1, done_at=? WHERE id=? AND done=0",
            (time.time(), int(task_id)),
        )
        self.conn.commit()
        return cur.rowcount > 0

    def note_add(self, text: str, author: str = "", date: str = "") -> dict:
        now = time.time()
        import datetime as _dt
        if not date:
            date = _dt.date.today().isoformat()
        cur = self.conn.execute(
            "INSERT INTO notes(date, text, author, created) VALUES (?,?,?,?)",
            (str(date), str(text)[:300], str(author), now),
        )
        self.conn.commit()
        return {"id": cur.lastrowid, "date": date, "text": text, "author": author}

    def note_list(self, limit: int = 50) -> list[dict]:
        rows = self.conn.execute(
            "SELECT id, date, text, author, created FROM notes ORDER BY id DESC LIMIT ?",
            (max(1, min(int(limit), 200)),),
        ).fetchall()
        return [
            {"id": int(r["id"]), "date": r["date"], "text": r["text"],
             "author": r["author"], "created": float(r["created"] or 0)}
            for r in rows
        ]

    def sleep_add(self, date: str, text: str) -> dict:
        """每天一条：同一天再写就覆盖旧的那条。"""
        now = time.time()
        self.conn.execute("DELETE FROM sleep_log WHERE date=?", (str(date),))
        self.conn.execute(
            "INSERT INTO sleep_log(date, text, created) VALUES (?,?,?)",
            (str(date), str(text), now),
        )
        self.conn.commit()
        return {"date": date, "text": text}

    def sleep_list(self, limit: int = 30) -> list[dict]:
        rows = self.conn.execute(
            "SELECT date, text, created FROM sleep_log ORDER BY id DESC LIMIT ?",
            (max(1, min(int(limit), 100)),),
        ).fetchall()
        return [
            {"date": r["date"], "text": r["text"], "created": float(r["created"] or 0)}
            for r in rows
        ]


    # -- 表情包索引：按情绪/关键词找图 ----------------------------------------

    def meme_upsert(self, file: str, emotion: str = "", caption: str = "", keywords: str = "") -> dict:
        now = time.time()
        self.conn.execute(
            "INSERT INTO meme(file, emotion, caption, keywords, created, updated) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(file) DO UPDATE SET emotion=excluded.emotion, caption=excluded.caption, "
            "keywords=excluded.keywords, updated=excluded.updated",
            (str(file), str(emotion), str(caption), str(keywords), now, now),
        )
        self.conn.commit()
        return {"file": file, "emotion": emotion, "caption": caption}

    def meme_list(self, emotion: str = "", q: str = "", limit: int = 20) -> list[dict]:
        sql = "SELECT * FROM meme"
        where = []
        params = []
        if emotion:
            where.append("(emotion = ? OR emotion LIKE ?)")
            params.extend([emotion, "%" + emotion + "%"])
        if q:
            where.append("(caption LIKE ? OR keywords LIKE ? OR file LIKE ?)")
            kw = "%" + q + "%"
            params.extend([kw, kw, kw])
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY used_count ASC, RANDOM() LIMIT ?"
        params.append(max(1, min(int(limit), 50)))
        rows = self.conn.execute(sql, tuple(params)).fetchall()
        return [
            {"id": int(r["id"]), "file": r["file"], "emotion": r["emotion"],
             "caption": r["caption"], "keywords": r["keywords"], "used_count": int(r["used_count"])}
            for r in rows
        ]

    def meme_mark_used(self, file: str) -> None:
        self.conn.execute("UPDATE meme SET used_count = used_count + 1, updated = ? WHERE file = ?",
                          (time.time(), str(file)))
        self.conn.commit()


    # -- 用户发过的图：按内容 hash 计数 ----------------------------------------

    def scan_seen(self) -> int:
        """扫 mediaDir 下用户发来的图，按内容 hash 计数。返回新图数量。"""
        import hashlib
        import os as _os
        meme_dir = _os.environ.get("CMEM_MEME_DIR", "/home/ubuntu/.dsh/media/onebot/memes")
        media_dir = _os.path.dirname(meme_dir)
        if not _os.path.isdir(media_dir):
            return 0
        exts = (".jpg", ".jpeg", ".png", ".webp", ".gif")
        added = 0
        for name in _os.listdir(media_dir):
            if not name.startswith("media_") or not name.lower().endswith(exts):
                continue
            path = _os.path.join(media_dir, name)
            try:
                with open(path, "rb") as f:
                    h = hashlib.md5(f.read()).hexdigest()
            except Exception:
                continue
            row = self.conn.execute("SELECT count FROM meme_seen WHERE hash=?", (h,)).fetchone()
            now = time.time()
            if row is None:
                self.conn.execute(
                    "INSERT INTO meme_seen(hash, path, count, last_seen) VALUES (?,?,?,?)",
                    (h, path, 1, now),
                )
                added += 1
            else:
                self.conn.execute(
                    "UPDATE meme_seen SET count = count + 1, path=?, last_seen=? WHERE hash=?",
                    (path, now, h),
                )
        self.conn.commit()
        return added

    def seen_liked(self, min_count: int = 2, limit: int = 5) -> list[dict]:
        """用户发过 >= min_count 次的图（他喜欢的）。"""
        rows = self.conn.execute(
            "SELECT hash, path, count, last_seen FROM meme_seen WHERE count >= ? ORDER BY count DESC, last_seen DESC LIMIT ?",
            (int(min_count), max(1, min(int(limit), 20))),
        ).fetchall()
        return [
            {"hash": r["hash"], "path": r["path"], "count": int(r["count"]),
             "last_seen": float(r["last_seen"] or 0)}
            for r in rows
        ]


    # -- 她的见闻：刷到的东西 ------------------------------------------------

    def browsed_add(self, title: str, url: str = "") -> None:
        self.conn.execute(
            "INSERT INTO browsed(title, url, ts) VALUES (?,?,?)",
            (str(title)[:200], str(url)[:300], time.time()),
        )
        self.conn.commit()

    def browsed_list(self, limit: int = 5) -> list[dict]:
        rows = self.conn.execute(
            "SELECT title, url, ts FROM browsed ORDER BY id DESC LIMIT ?",
            (max(1, min(int(limit), 20)),),
        ).fetchall()
        return [{"title": r["title"], "url": r["url"], "ts": float(r["ts"] or 0)} for r in rows]


    # -- 情感层：情绪轨迹 ------------------------------------------------------

    def emotion_log_add(self, valence: float, arousal: float, label: str = "",
                        trigger: str = "", source: str = "chat") -> int:
        cur = self.conn.execute(
            "INSERT INTO emotion_log(ts, valence, arousal, label, trigger, source) VALUES (?,?,?,?,?,?)",
            (time.time(), float(valence), float(arousal), str(label)[:40], str(trigger)[:200], str(source)[:20]),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def emotion_log_list(self, limit: int = 50, days: int = 0) -> list[dict]:
        sql = "SELECT id, ts, valence, arousal, label, trigger, source FROM emotion_log"
        args: list = []
        if days and days > 0:
            sql += " WHERE ts >= ?"
            args.append(time.time() - days * 86400)
        sql += " ORDER BY ts DESC LIMIT ?"
        args.append(max(1, min(int(limit), 500)))
        rows = self.conn.execute(sql, args).fetchall()
        return [{
            "id": int(r["id"]), "ts": float(r["ts"]),
            "valence": float(r["valence"]), "arousal": float(r["arousal"]),
            "label": r["label"], "trigger": r["trigger"], "source": r["source"],
        } for r in rows]


    def bump_intimacy(self, delta: float = 1.0) -> float:
        cur = self.get_state()
        return self.set_state(intimacy=cur["intimacy"] + delta)["intimacy"]

    def in_dnd(self, hour: int | None = None) -> bool:
        s = self.get_state()
        if hour is None:
            hour = time.localtime().tm_hour
        start, end = s["dnd_start"], s["dnd_end"]
        if start <= end:
            return start <= hour < end
        return hour >= start or hour < end


    # -- 导出 / 导入：记忆转移 -------------------------------------------------
    #
    # 为什么不是「直接拷贝 memories.db」：
    #   1. WAL 模式下最近的写入还在 -wal 里，单拷主文件会拿到一个几乎空库
    #      （实测：主文件 4KB，-wal 288KB）。
    #   2. .db 是 SQLite 的物理格式，schema 一变它就不是「记忆」而是「实现细节」。
    # 这里导出的是一行一条 JSON 的中立格式：字段由代码定义，向量按原始
    # float32 字节 base64 编码，跨机器、跨版本无损。

    EXPORT_VERSION = 1

    def export_records(self) -> list[dict]:
        out: list[dict] = []
        for r in self.conn.execute("SELECT * FROM memory ORDER BY id"):
            out.append({
                "type": "memory",
                "id": int(r["id"]),
                "tier": r["tier"],
                "subject": r["subject"],
                "text": r["text"],
                "summary": r["summary"],
                "source_ids": json.loads(r["source_ids"] or "[]"),
                "tags": json.loads(r["tags"] or "[]"),
                "ts": r["ts"],
                "half_life_days": r["half_life_days"],
                "vec_b64": base64.b64encode(r["vec"]).decode("ascii") if r["vec"] else None,
                "vec_dim": r["vec_dim"],
                "vec_model": r["vec_model"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
            })
        return out

    def export_manifest(self) -> dict:
        """导出时附带的清单：条数 + 内容指纹，用来在另一台机器上核对。"""
        fp = self.fingerprint()
        return {
            "type": "manifest",
            "format": "dsh-remembers-jsonl",
            "version": self.EXPORT_VERSION,
            "exported_at": time.time(),
            "count": fp["count"],
            "with_vectors": fp["with_vectors"],
            "content_sha256": fp["sha256"],
            "schema_version": self.conn.execute(
                "SELECT v FROM meta WHERE k='schema_version'"
            ).fetchone()[0],
        }

    def fingerprint(self) -> dict:
        """内容指纹：不含 id、不含时间戳的创建时间，只对有意义的字段算。

        转移前后指纹一致 = 记忆内容一字未变（id 在 merge 模式下会重排，
        所以不能进指纹）。
        """
        rows = self.conn.execute(
            "SELECT tier, subject, text, ts, vec_dim, summary FROM memory "
            "ORDER BY tier, subject, text, ts"
        ).fetchall()
        h = hashlib.sha256()
        with_vec = 0
        for r in rows:
            h.update(
                f"{r['tier']}|{r['subject']}|{r['text']}|{float(r['ts']):.3f}"
                f"|{r['vec_dim']}|{r['summary'] or ''}\n".encode("utf-8")
            )
            if (r["vec_dim"] or 0) > 0:
                with_vec += 1
        return {"count": len(rows), "with_vectors": with_vec, "sha256": h.hexdigest()}

    def import_records(self, records: Iterable[dict], mode: str = "merge") -> dict:
        """导入导出记录。

        mode="replace"：清空后导入，保留原 id（整库搬家）
        mode="merge"  ：追加，分配新 id（合并另一台机器的记忆）
        """
        if mode not in {"replace", "merge"}:
            raise ValueError("mode must be 'replace' or 'merge'")

        if mode == "replace":
            self.conn.execute("DELETE FROM memory")
            self.conn.execute("DELETE FROM doc_term")
            self.conn.execute("DELETE FROM term_stat")
            self.conn.execute("DELETE FROM doc_len")
            self.conn.commit()
            self._invalidate_caches()

        imported = skipped = 0
        now = time.time()
        for rec in records:
            if not isinstance(rec, dict):
                skipped += 1
                continue
            if rec.get("type") not in (None, "memory"):
                continue  # manifest 之类的元信息行，跳过
            text = str(rec.get("text") or "").strip()
            if not text:
                skipped += 1
                continue

            vec_blob, vec_dim = None, 0
            b64 = rec.get("vec_b64")
            if b64:
                try:
                    raw = base64.b64decode(b64)
                    vec_blob, vec_dim = raw, len(raw) // 4
                except Exception:  # noqa: BLE001 - 坏向量不至于让整条记忆进不来
                    vec_blob, vec_dim = None, 0

            tags = rec.get("tags") or []
            source_ids = rec.get("source_ids") or []
            ts = float(rec.get("ts") or now)
            half = rec.get("half_life_days")
            half = float(half) if half is not None else None

            explicit_id = int(rec["id"]) if (mode == "replace" and rec.get("id")) else None
            cols = ("tier, subject, text, summary, source_ids, tags, ts, half_life_days, "
                    "vec, vec_dim, vec_model, created_at, updated_at")
            vals = (
                str(rec.get("tier") or "L1"),
                str(rec.get("subject") or "self"),
                text,
                rec.get("summary"),
                json.dumps(list(source_ids), ensure_ascii=False),
                json.dumps(list(tags), ensure_ascii=False),
                ts,
                half,
                vec_blob,
                vec_dim,
                rec.get("vec_model"),
                float(rec.get("created_at") or now),
                float(rec.get("updated_at") or now),
            )
            if explicit_id is not None:
                cur = self.conn.execute(
                    f"INSERT OR REPLACE INTO memory(id, {cols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (explicit_id, *vals),
                )
                mem_id = explicit_id
            else:
                cur = self.conn.execute(f"INSERT INTO memory({cols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", vals)
                mem_id = int(cur.lastrowid)

            self._index_terms(mem_id, text, rec.get("summary"), tags)
            imported += 1

        self.conn.commit()
        self._invalidate_caches()
        return {"imported": imported, "skipped": skipped, "mode": mode, **self.fingerprint()}

    def candidates(self, query: str, top_k: int = 5, subject: str | None = None) -> list[Hit]:
        """宽松召回，只给「判定器」用，不用于回答。

        和 search() 的区别：**不过诚实出口、不设准入阈值**。
        判定「这条新事实该 ADD 还是 UPDATE」时，宁可多看几条不相关的，
        也不能漏掉相关的——漏掉就会错误地 ADD，把矛盾记忆留在库里。
        """
        bm25 = self.bm25_scores(query)
        if not bm25:
            return []
        light = self._light_rows()
        scored: list[tuple[float, int]] = []
        for mid, b in bm25.items():
            meta = light.get(mid)
            if meta is None:
                continue
            ts, half, tier, subj = meta
            if tier == "L4":
                continue
            if subject and subj != subject:
                continue
            scored.append((b, mid))
        if not scored:
            return []
        scored.sort(reverse=True)
        ids = {mid for _, mid in scored[:top_k]}
        rows = {int(r["id"]): r for r in self.conn.execute(
            f"SELECT * FROM memory WHERE id IN ({','.join('?' * len(ids))})", tuple(ids)
        ).fetchall()}
        out: list[Hit] = []
        for b, mid in scored[:top_k]:
            r = rows.get(mid)
            if r is None:
                continue
            out.append(Hit(
                id=mid, tier=r["tier"], subject=r["subject"], text=r["text"],
                summary=r["summary"], ts=r["ts"], score=b, bm25=b, vec=0.0,
                recency=_recency(r["ts"], r["half_life_days"], time.time()),
                tags=json.loads(r["tags"] or "[]"),
            ))
        return out

    def _load_rows(self, ids: set[int], tiers: Sequence[str] | None, subject: str | None):
        if not ids:
            return []
        placeholders = ",".join("?" * len(ids))
        sql = f"SELECT * FROM memory WHERE id IN ({placeholders})"
        params: list[Any] = list(ids)
        if tiers:
            sql += f" AND tier IN ({','.join('?' * len(tiers))})"
            params.extend(tiers)
        else:
            # L4 是每轮必带的人格块，由 profile() 单独取；放进检索会重复注入。
            sql += " AND tier != 'L4'"
        if subject:
            sql += " AND subject=?"
            params.append(subject)
        return self.conn.execute(sql, params).fetchall()

    def _log_search(self, query: str, hits: int, top: float | None, bm: float | None,
                    vec: float | None, outcome: str) -> None:
        self.conn.execute(
            "INSERT INTO search_log(ts, query, hits, top_score, top_bm25, top_vec, outcome) "
            "VALUES (?,?,?,?,?,?,?)",
            (time.time(), query[:500], hits, top, bm, vec, outcome),
        )
        self.conn.commit()


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _pack_vec(vec: Sequence[float] | None) -> tuple[bytes | None, int]:
    if not vec:
        return None, 0
    arr = np.asarray(vec, dtype="<f4")
    return arr.tobytes(), int(arr.size)


def _norm_bm25(score: float) -> float:
    """BM25 绝对分 → [0,1)。饱和映射。

    不能用「除以本批最大值」：只有一个弱候选时它会变成满分。实测中
    「量子纠缠退相干」曾以 0.709 命中一条完全不相关的记忆，就是这个原因。
    """
    if score <= 0:
        return 0.0
    return score / (score + BM25_SATURATION)


def _recency(ts: float, half_life_days: float | None, now: float) -> float:
    if half_life_days is None or half_life_days <= 0:
        return 1.0
    age_days = max(0.0, (now - float(ts)) / 86400.0)
    return float(2.0 ** (-age_days / half_life_days))


def cos_sim(a: Sequence[float], b: Sequence[float]) -> float:
    va, vb = np.asarray(a, dtype=np.float32), np.asarray(b, dtype=np.float32)
    denom = (float(np.linalg.norm(va)) or 1.0) * (float(np.linalg.norm(vb)) or 1.0)
    return float(np.dot(va, vb) / denom)
