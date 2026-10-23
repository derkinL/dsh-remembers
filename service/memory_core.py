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

import json
import math
import re
import sqlite3
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
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        schema = schema_path or (Path(__file__).with_name("schema.sql"))
        self.conn.executescript(Path(schema).read_text(encoding="utf-8"))
        self.conn.commit()

    # -- 写入 ---------------------------------------------------------------

    def add(self, item: MemoryInput) -> int:
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
        blob, dim = _pack_vec(vec)
        self.conn.execute(
            "UPDATE memory SET vec=?, vec_dim=?, vec_model=?, updated_at=? WHERE id=?",
            (blob, dim, model, time.time(), mem_id),
        )
        self.conn.commit()

    def forget(self, mem_id: int) -> bool:
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
        df_rows = self.conn.execute(
            f"SELECT term, df FROM term_stat WHERE term IN ({placeholders})", terms
        ).fetchall()
        df = {r["term"]: r["df"] for r in df_rows}
        if not df:
            return {}

        hits = self.conn.execute(
            f"""SELECT dt.mem_id, dt.term, dt.tf, dl.len
                FROM doc_term dt JOIN doc_len dl ON dl.mem_id = dt.mem_id
                WHERE dt.term IN ({placeholders})""",
            terms,
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

    def vec_search(self, query_vec: Sequence[float], candidate_ids: set[int] | None = None) -> dict[int, float]:
        rows = self.conn.execute(
            "SELECT id, vec, vec_dim FROM memory WHERE vec IS NOT NULL"
        ).fetchall()
        if not rows:
            return {}
        q = np.asarray(query_vec, dtype=np.float32)
        qn = float(np.linalg.norm(q)) or 1.0
        scored: dict[int, float] = {}
        for r in rows:
            v = np.frombuffer(r["vec"], dtype="<f4")
            if v.size != q.size:
                continue
            denom = (float(np.linalg.norm(v)) or 1.0) * qn
            scored[int(r["id"])] = float(np.dot(q, v) / denom)
        return scored

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

        rows = self._load_rows(candidates, tiers, subject)
        if not rows:
            if log:
                self._log_search(query, 0, None, None, None, "no_match")
            return []

        bm25_max = max(bm25.values(), default=0.0) or 1.0
        out: list[Hit] = []
        for r in rows:
            mid = r["id"]
            b_raw = bm25.get(mid, 0.0)
            v_raw = max(0.0, vec.get(mid, 0.0))
            rec = _recency(r["ts"], r["half_life_days"], now)
            # 饱和映射而不是「除以本批最大值」：后者会让只有一个候选的弱命中
            # 变成满分（实测「量子纠缠」曾以 0.709 命中无关记忆）。
            fused = W_BM25 * _norm_bm25(b_raw) + W_VEC * v_raw + W_RECENCY * rec
            out.append(
                Hit(
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
                )
            )

        out.sort(key=lambda h: h.score, reverse=True)

        # ---- 诚实出口 ----
        # 没有「有意义的」关键词命中时，向量必须自己达到高余弦才够格：
        # 实测这个 embedding 在无关内容上也能给到 0.65，低门槛等于放任她记错。
        if bm25_max < MIN_BM25_ABS:
            best_cos = max((h.vec for h in out), default=0.0)
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
        kept: list[Hit] = []
        for h in out:
            kw_ok = h.bm25 >= MIN_BM25_ABS
            vec_ok = h.vec >= VEC_ONLY_MIN_COS
            if not (kw_ok or vec_ok):
                continue
            if not kw_ok and h.score < min_fused:
                continue
            kept.append(h)
        kept = kept[:top_k]
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
