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
  GET  /persona                     人格设定：宪法区 + 自我认知区
  POST /persona                     设置页保存（两半都能写）
  POST /persona/self                插件/AI 写入（只能写自我认知区，宪法区没有参数）
  POST /episode                     把一段对话压成一条 L3 事件记录（需要配 LLM）
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
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
AUTH_TOKEN = os.environ.get("CMEM_AUTH_TOKEN", "")
MAX_BODY = 1 << 20  # 1 MiB


def _mask(secret: str) -> str:
    """返回给前端时只露头尾，避免 key 明文出现在页面/日志里。"""
    if not secret:
        return ""
    if len(secret) <= 10:
        return "***"
    return f"{secret[:6]}…{secret[-4:]}"


def _load_config() -> dict:
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as exc:  # noqa: BLE001
        print(f"[cmem] config.json unreadable, ignoring: {type(exc).__name__}: {exc}", flush=True)
        return {}


def _save_config(cfg: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)   # 原子替换：写一半断电不会留下坏文件
    try:
        os.chmod(CONFIG_PATH, 0o600)  # 里面是 key
    except OSError:
        pass


def _pick(cfg: dict, key: str, env_name: str, default: str = "") -> str:
    """config.json 优先于环境变量：界面上改过的值应该盖掉启动时的 env。"""
    value = cfg.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return os.environ.get(env_name, default)


def _pick_flag(cfg: dict, key: str, env_name: str, default: str = "0") -> bool:
    value = cfg.get(key)
    if isinstance(value, bool):
        return value
    return os.environ.get(env_name, default).strip().lower() in {"1", "true", "yes", "on"}

_lock = threading.Lock()
store: MemoryStore
embedder: Embedder
llm: LLM
extractor: Extractor
gate: SurprisalGate


def _flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _build_llm(cfg: dict) -> LLM:
    return LLM(
        base_url=_pick(cfg, "llm_base", "CMEM_LLM_BASE"),
        api_key=_pick(cfg, "llm_key", "CMEM_LLM_KEY"),
        model=_pick(cfg, "llm_model", "CMEM_LLM_MODEL"),
        timeout=float(_pick(cfg, "llm_timeout", "CMEM_LLM_TIMEOUT", "60")),
    )


def _build_embedder(cfg: dict) -> Embedder:
    return Embedder(
        base_url=_pick(cfg, "embed_base", "CMEM_EMBED_BASE"),
        api_key=_pick(cfg, "embed_key", "CMEM_EMBED_KEY"),
        model=_pick(cfg, "embed_model", "CMEM_EMBED_MODEL"),
        timeout=float(_pick(cfg, "embed_timeout", "CMEM_EMBED_TIMEOUT", "20")),
        batch_size=int(_pick(cfg, "embed_batch", "CMEM_EMBED_BATCH", "16")),
    )


def _rebuild(cfg: dict) -> dict:
    """按配置重建 LLM / Embedder / Extractor / Gate。

    设置页保存后调这里热生效，不用重启进程。
    """
    global llm, embedder, extractor, gate
    llm = _build_llm(cfg)
    embedder = _build_embedder(cfg)
    extractor = Extractor(llm, store, ExtractConfig(
        enabled=_pick_flag(cfg, "extract", "CMEM_EXTRACT"),
        max_facts=int(_pick(cfg, "extract_max_facts", "CMEM_EXTRACT_MAX_FACTS", "6")),
        neighbor_k=int(_pick(cfg, "extract_neighbors", "CMEM_EXTRACT_NEIGHBORS", "5")),
    ), embedder=embedder)
    gate = SurprisalGate(
        embedder=embedder,
        threshold=float(_pick(cfg, "surprisal_threshold", "CMEM_SURPRISAL_THRESHOLD", "0.35")),
    )
    return {
        "llm": llm.health(),
        "embedding": embedder.health(),
        "extract_enabled": extractor.enabled,
        "surprisal_threshold": gate.threshold,
    }


def _init() -> None:
    global store
    os.makedirs(DATA_DIR, exist_ok=True)
    store = MemoryStore(DB_PATH, schema_path=os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql"))
    cfg = _load_config()
    status = _rebuild(cfg)
    print(
        f"[cmem] db={DB_PATH} config={CONFIG_PATH if os.path.exists(CONFIG_PATH) else '(env only)'} "
        f"embedding={'on:' + embedder.model if embedder.enabled else 'off'} "
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
        elif path == "/persona":
            self._guard(self._get_persona)
        elif path == "/export":
            self._guard(self._export)
        elif path == "/config":
            self._guard(self._get_config)
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
        elif path == "/reindex":
            self._guard(self._reindex)
        elif path == "/config":
            self._guard(self._set_config)
        elif path == "/persona":
            self._guard(self._set_persona)
        elif path == "/persona/self":
            self._guard(self._set_self_model)
        elif path == "/extract":
            self._guard(self._extract)
        elif path == "/episode":
            self._guard(self._episode)
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

    # -- 人格设定（二合一里的「人」那一半） ---------------------------------

    def _persona_payload(self, data: dict) -> dict:
        return {
            "ok": True,
            **data,
            "chars": {
                "constitution": len(data["constitution"]),
                "self_model": len(data["self_model"]),
            },
            "limits": {
                "constitution": MemoryStore.CONSTITUTION_MAX,
                "self_model": MemoryStore.SELF_MODEL_MAX,
            },
        }

    def _get_persona(self) -> None:
        self._json(200, self._persona_payload(store.get_persona()))

    def _set_persona(self) -> None:
        """设置页保存。两半都能写；没传的字段保持原值。"""
        body = self._body()
        constitution = body.get("constitution")
        self_model = body.get("self_model")
        if constitution is None and self_model is None:
            raise ValueError("constitution or self_model is required")
        with _lock:
            data = store.set_persona(
                constitution=None if constitution is None else str(constitution),
                self_model=None if self_model is None else str(self_model),
            )
        self._json(200, self._persona_payload(data))

    def _set_self_model(self) -> None:
        """AI 写作入口：只能写自我认知区。

        宪法区在这里改不了 —— 不是指望调用方自觉，是这个端点压根没有那个
        参数。插件侧的 persona_update 工具打到这儿，坏掉的插件也只能改掉
        半张卡。
        """
        body = self._body()
        raw = body.get("text")
        if raw is None:
            raw = body.get("content")
        text = str(raw or "")
        if not text.strip():
            raise ValueError("text is required")
        with _lock:
            data = store.set_self_model(text)
        self._json(200, self._persona_payload(data))

    def _episode(self) -> None:
        """把一段对话压成一条 L3 事件记录（episode）。

        调用时机由插件决定（攒够 N 轮或超时），这里只负责压缩 + 落库。
        只要求配了 LLM，不看 extract 开关——逐条抽取按轮算钱，episode 按段算。
        没配 LLM 时返回 503，插件侧静默跳过：这条链路不能影响对话本身。
        """
        body = self._body()
        turns = body.get("turns")
        if not isinstance(turns, list) or not turns:
            raise ValueError("turns is required")
        res = extractor.summarize_episode(
            turns=turns[:400],
            subject=str(body.get("subject") or "self"),
            window_hint=str(body.get("window") or ""),
        )
        self._json(200 if res.get("ok") else 503, res)

    def _get_config(self) -> None:
        """给设置页读的配置。密钥一律脱敏，只告诉前端「设了没有」。"""
        cfg = _load_config()
        llm_key = _pick(cfg, "llm_key", "CMEM_LLM_KEY")
        embed_key = _pick(cfg, "embed_key", "CMEM_EMBED_KEY")
        self._json(200, {
            "ok": True,
            "path": CONFIG_PATH,
            "current": {
                "llm_base": _pick(cfg, "llm_base", "CMEM_LLM_BASE"),
                "llm_model": _pick(cfg, "llm_model", "CMEM_LLM_MODEL"),
                "llm_key_masked": _mask(llm_key),
                "llm_key_set": bool(llm_key),
                "llm_key_env": bool(os.environ.get("CMEM_LLM_KEY")),
                "embed_base": _pick(cfg, "embed_base", "CMEM_EMBED_BASE"),
                "embed_model": _pick(cfg, "embed_model", "CMEM_EMBED_MODEL"),
                "embed_key_masked": _mask(embed_key),
                "embed_key_set": bool(embed_key),
                "embed_key_env": bool(os.environ.get("CMEM_EMBED_KEY")),
                "extract": _pick_flag(cfg, "extract", "CMEM_EXTRACT"),
                "surprisal_threshold": float(_pick(cfg, "surprisal_threshold", "CMEM_SURPRISAL_THRESHOLD", "0.35")),
            },
            "status": {
                "llm_enabled": llm.enabled,
                "llm_model": llm.model or None,
                "llm_calls": llm.calls,
                "llm_failures": llm.failures,
                "llm_last_error": llm.last_error,
                "embedding_enabled": embedder.enabled,
                "embedding_model": embedder.model or None,
                "extract_enabled": extractor.enabled,
            },
        })

    def _set_config(self) -> None:
        """保存配置并热生效（不重启进程）。

        前端把脱敏后的 key 原样传回来时（含 … 或 ***）不覆盖真实值——
        否则用户只改模型名也会把密钥洗成掩码。
        """
        body = self._body()
        cfg = _load_config()

        for key in ("llm_base", "llm_model", "llm_key", "embed_base", "embed_model", "embed_key"):
            if key not in body:
                continue
            value = str(body[key] or "").strip()
            if key.endswith("_key") and (not value or "…" in value or value == "***"):
                if not value:
                    cfg[key] = ""      # 明确清空
                continue           # 掩码回传：保持原值
            cfg[key] = value

        if "extract" in body:
            cfg["extract"] = bool(body["extract"])
        if "surprisal_threshold" in body:
            try:
                cfg["surprisal_threshold"] = max(0.0, min(1.0, float(body["surprisal_threshold"])))
            except (TypeError, ValueError):
                pass

        _save_config(cfg)
        with _lock:
            status = _rebuild(cfg)
        self._json(200, {"ok": True, "path": CONFIG_PATH, "status": status})

    def _surprisal(self) -> None:
        """惊讶度门控：这一轮值不值得写进 L0。"""
        body = self._body()
        text = str(body.get("text") or "")
        context = str(body.get("context") or "")
        res = gate.score(text, context)
        self._json(200, {"ok": True, **res})

    def _reindex(self) -> None:
        """重建倒排索引。改了分词/权重，或者从老库升级过来之后跑一次。"""
        with _lock:
            res = store.reindex()
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
