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

    def add(self, item: MemoryInput) -> int:
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
        self._index_terms(mem_id, item.text, item.summary)
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
            "SELECT text, summary FROM memory WHERE id=?", (mem_id,)
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
        self._index_terms(mem_id, text, effective_summary)
        self.conn.commit()
        return True

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

    def _index_terms(self, mem_id: int, text: str, summary: str | None) -> None:
        # 摘要命中按半权计入，避免摘要词压过原话
        tokens = tokenize(text) + [(t, w * 0.5) for t, w in tokenize(summary or "")]
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
        """L4 人格/关系设定：每轮必带，不参与检索排序。"""
        rows = self.conn.execute(
            "SELECT * FROM memory WHERE tier='L4'" + (" AND subject=?" if subject else "") +
            " ORDER BY ts ASC",
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

            self._index_terms(mem_id, text, rec.get("summary"))
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
