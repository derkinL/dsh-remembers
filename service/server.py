"""companion-memory HTTP 服务（零依赖：只用标准库 + numpy）。

为什么不用 FastAPI：这个场景 QPS 极低，而「装得上就能跑」比框架规范更重要。
一个 python:3.12-slim + numpy 就是全部运行时，没有 pydantic 版本地狱。

端点
  GET  /health                      健康 + embedding 状态 + 记忆统计
  GET  /stats                       记忆统计
  GET  /profile?subject=            取 L4 人格块（每轮必带）
  POST /ingest                      写一条记忆（可带 embed 开关）
  POST /search                      混合检索（BM25 + 向量 + 衰减 + 诚实出口）
  POST /forget/{id}                 删除一条
  GET  /log?limit=50                最近检索日志（调阈值用）
  POST /consolidate                 整理：按 text 完全重复合并（先给个保守版）
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from embedding import Embedder
from extractor import ExtractConfig, Extractor
from llm import LLM
from memory_core import MemoryInput, MemoryStore
from surprisal import SurprisalGate

DATA_DIR = os.environ.get("CMEM_DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "memories.db")
AUTH_TOKEN = os.environ.get("CMEM_AUTH_TOKEN", "")
MAX_BODY = 1 << 20  # 1 MiB

_lock = threading.Lock()
store: MemoryStore
embedder: Embedder
llm: LLM
extractor: Extractor
gate: SurprisalGate


def _flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _init() -> None:
    global store, embedder, llm, extractor, gate
    os.makedirs(DATA_DIR, exist_ok=True)
    store = MemoryStore(DB_PATH, schema_path=os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql"))
    embedder = Embedder(
        base_url=os.environ.get("CMEM_EMBED_BASE", ""),
        api_key=os.environ.get("CMEM_EMBED_KEY", ""),
        model=os.environ.get("CMEM_EMBED_MODEL", ""),
        timeout=float(os.environ.get("CMEM_EMBED_TIMEOUT", "20")),
        batch_size=int(os.environ.get("CMEM_EMBED_BATCH", "16")),
    )
    # 写入门控用到的 LLM：抽取事实 + 逐条判定（mem0 那套）
    llm = LLM(
        base_url=os.environ.get("CMEM_LLM_BASE", ""),
        api_key=os.environ.get("CMEM_LLM_KEY", ""),
        model=os.environ.get("CMEM_LLM_MODEL", ""),
        timeout=float(os.environ.get("CMEM_LLM_TIMEOUT", "60")),
    )
    extractor = Extractor(llm, store, ExtractConfig(
        enabled=_flag("CMEM_EXTRACT"),
        max_facts=int(os.environ.get("CMEM_EXTRACT_MAX_FACTS", "6")),
        neighbor_k=int(os.environ.get("CMEM_EXTRACT_NEIGHBORS", "5")),
    ))
    gate = SurprisalGate(
        embedder=embedder,
        threshold=float(os.environ.get("CMEM_SURPRISAL_THRESHOLD", "0.35")),
    )
    print(
        f"[cmem] db={DB_PATH} "
        f"embedding={'on:' + embedder.model if embedder.enabled else 'off (BM25 only)'} "
        f"extract={'on:' + llm.model if extractor.enabled else 'off'} "
        f"surprisal_threshold={gate.threshold}",
        flush=True,
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "companion-memory/1.0"

    # -- 基础 ---------------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:  # 安静一点，错误才打
        if args and str(args[0]).startswith(("4", "5")):
            sys.stderr.write("[cmem] %s\n" % (fmt % args))

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("body too large")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _raw_body(self, limit: int = MAX_BODY) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        if length > limit:
            raise ValueError(f"body too large ({length} > {limit})")
        return self.rfile.read(length)

    def _authorized(self) -> bool:
        if not AUTH_TOKEN:
            return True
        provided = self.headers.get("X-Auth-Token") or ""
        if provided == AUTH_TOKEN:
            return True
        auth = self.headers.get("Authorization") or ""
        return auth == f"Bearer {AUTH_TOKEN}"

    def _guard(self, fn) -> None:
        if not self._authorized():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            fn()
        except ValueError as exc:
            self._json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    # -- 路由 ---------------------------------------------------------------

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path, query = parsed.path.rstrip("/") or "/", parse_qs(parsed.query)
        if path == "/health":
            self._guard(lambda: self._json(200, {
                "ok": True,
                "db": DB_PATH,
                "stats": store.stats(),
                "embedding": embedder.health(),
                "llm": llm.health(),
                "extract_enabled": extractor.enabled,
                "surprisal_threshold": gate.threshold,
            }))
        elif path == "/stats":
            self._guard(lambda: self._json(200, {"ok": True, "stats": store.stats()}))
        elif path == "/profile":
            subject = (query.get("subject") or [None])[0]
            self._guard(lambda: self._json(200, {
                "ok": True,
                "items": [h.to_dict() for h in store.profile(subject)],
            }))
        elif path == "/log":
            limit = int((query.get("limit") or ["50"])[0])
            self._guard(lambda: self._json(200, {"ok": True, "items": self._recent_log(limit)}))
        elif path == "/export":
            self._guard(self._export)
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path == "/ingest":
            self._guard(lambda: self._ingest())
        elif path == "/search":
            self._guard(lambda: self._search())
        elif path.startswith("/forget/"):
            mem_id = path.rsplit("/", 1)[-1]
            self._guard(lambda: self._forget(mem_id))
        elif path == "/consolidate":
            self._guard(lambda: self._consolidate())
        elif path == "/import":
            self._guard(self._import)
        elif path == "/surprisal":
            self._guard(self._surprisal)
        elif path == "/extract":
            self._guard(self._extract)
        else:
            self._json(404, {"ok": False, "error": "not found"})

    # -- 业务 ---------------------------------------------------------------

    def _ingest(self) -> None:
        body = self._body()
        text = (body.get("text") or "").strip()
        if not text:
            raise ValueError("text is required")
        tier = str(body.get("tier") or "L1")
        subject = str(body.get("subject") or "self")

        vec = None
        vec_model = None
        if body.get("embed", True) and embedder.enabled:
            vec = embedder.embed_one(text)
            vec_model = embedder.model if vec else None

        with _lock:
            mid = store.add(MemoryInput(
                text=text,
                tier=tier,
                subject=subject,
                summary=body.get("summary"),
                source_ids=body.get("source_ids"),
                tags=body.get("tags"),
                ts=body.get("ts"),
                half_life_days=body.get("half_life_days"),
                vec=vec,
                vec_model=vec_model,
            ))
        self._json(200, {"ok": True, "id": mid, "embedded": vec is not None,
                         "embedding_error": None if vec or not embedder.enabled else embedder.last_error})

    def _search(self) -> None:
        body = self._body()
        query = (body.get("query") or "").strip()
        focus = body.get("focus")
        if not query and not focus:
            raise ValueError("query or focus is required")

        qvec = None
        if embedder.enabled and body.get("embed_query", True):
            qvec = embedder.embed_one(query or focus or "")

        hits = store.search(
            query=query,
            query_vec=qvec,
            top_k=int(body.get("top_k") or 6),
            tiers=body.get("tiers"),
            subject=body.get("subject"),
            min_fused=float(body.get("min_fused") or 0.30),
            focus=focus,
        )
        self._json(200, {
            "ok": True,
            "query": query,
            "hits": [h.to_dict() for h in hits],
            "count": len(hits),
            "embedding_used": qvec is not None,
        })

    def _forget(self, mem_id: str) -> None:
        with _lock:
            ok = store.forget(int(mem_id))
        self._json(200, {"ok": ok, "id": int(mem_id)})

    def _consolidate(self) -> None:
        """保守版整理：同 tier+subject 下 text 完全相同的只留最新一条。

        不做 LLM 摘要/合并——那需要模型调用，属于下一阶段，不要在这个
        文件里偷偷引入外部依赖。
        """
        rows = store.conn.execute(
            """SELECT id, tier, subject, text FROM memory
               ORDER BY tier, subject, updated_at DESC, id DESC"""
        ).fetchall()
        seen: set[tuple[str, str, str]] = set()
        removed = 0
        for r in rows:
            key = (r["tier"], r["subject"], r["text"])
            if key in seen:
                store.forget(int(r["id"]))
                removed += 1
            else:
                seen.add(key)
        self._json(200, {"ok": True, "removed": removed})

    def _export(self) -> None:
        """导出成 JSONL：一行一条记忆，第一行是清单（条数 + 内容指纹）。

        这是「转移格式」，不是存储格式。直接拷 memories.db 在 WAL 模式下
        会丢最近的写入，而且 .db 是物理格式，schema 一变就不可读。
        """
        manifest = store.export_manifest()
        records = store.export_records()
        lines = [json.dumps(manifest, ensure_ascii=False)]
        lines.extend(json.dumps(r, ensure_ascii=False) for r in records)
        body = ("\n".join(lines) + "\n").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="memories.jsonl"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _import(self) -> None:
        """导入 JSONL。?mode=merge（默认，分配新 id）或 ?mode=replace（整库替换）。"""
        qs = parse_qs(urlparse(self.path).query)
        mode = (qs.get("mode") or ["merge"])[0]
        raw = self._raw_body(limit=512 << 20)
        if not raw:
            raise ValueError("empty body")
        text = raw.decode("utf-8", "replace")

        records: list[dict] = []
        bad = 0
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1
        if not records:
            raise ValueError("no parseable records")

        manifest = next((r for r in records if isinstance(r, dict) and r.get("type") == "manifest"), None)
        with _lock:
            res = store.import_records(records, mode=mode)

        check = "ok"
        if manifest:
            expected = manifest.get("count")
            if expected is not None and int(expected) != res["count"]:
                check = f"mismatch: 清单 {expected} 条，库内现有 {res['count']} 条"
            elif manifest.get("content_sha256") and mode == "replace":
                fp = store.fingerprint()
                if fp["sha256"] != manifest["content_sha256"]:
                    check = "content_sha256 不一致：记忆内容与导出时不同"
        self._json(200, {"ok": True, **res, "bad_lines": bad, "manifest_check": check})

    def _surprisal(self) -> None:
        """惊讶度门控：这一轮值不值得写进 L0。"""
        body = self._body()
        text = str(body.get("text") or "")
        context = str(body.get("context") or "")
        res = gate.score(text, context)
        self._json(200, {"ok": True, **res})

    def _extract(self) -> None:
        """LLM 抽取 + 逐条判定（ADD/UPDATE/DELETE/NONE）。

        耗时可能到几十秒（两次 LLM 调用），调用方应当 fire-and-forget。
        没配 LLM 时返回 503 和 degraded 原因，调用方退回到直接存原话。
        """
        body = self._body()
        res = extractor.process_turn(
            user_text=str(body.get("user_text") or ""),
            assistant_text=str(body.get("assistant_text") or ""),
            subject=str(body.get("subject") or "self"),
        )
        self._json(200 if res.get("ok") else 503, res)

    def _recent_log(self, limit: int) -> list[dict]:
        rows = store.conn.execute(
            "SELECT ts, query, hits, top_score, top_bm25, top_vec, outcome "
            "FROM search_log ORDER BY id DESC LIMIT ?",
            (max(1, min(limit, 500)),),
        ).fetchall()
        return [dict(r) for r in rows]


def main() -> None:
    _init()
    host = os.environ.get("CMEM_HOST", "0.0.0.0")
    port = int(os.environ.get("CMEM_PORT", "8080"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[cmem] listening on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[cmem] shutting down", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
