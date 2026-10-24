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

    def _cors_headers(self) -> None:
        # 插件设置页在浏览器里跨域访问本服务（页面在 dsh 的端口，服务在 8081），
        # 缺这些头 fetch 会被浏览器拦成 "Failed to fetch"。
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", "Content-Type, X-Auth-Token, Authorization"
        )
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
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

    def do_OPTIONS(self) -> None:
        # CORS 预检：浏览器发 POST（带自定义头）前会先探一次
        self.send_response(204)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

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
        elif path == "/activity":
            date = (query.get("date") or [None])[0] or None
            self._json(200, store.list_activities(date))
        elif path.startswith("/memes/file/"):
            import urllib.parse as _up
            name = _up.unquote(path.rsplit("/", 1)[-1])
            import os as _os
            meme_dir = _os.environ.get("CMEM_MEME_DIR", "/home/ubuntu/.dsh/media/onebot/memes")
            fp = _os.path.join(meme_dir, _os.path.basename(name))
            if not _os.path.exists(fp):
                self._json(404, {"ok": False, "error": "not found"})
                return
            ext = _os.path.splitext(fp)[1].lstrip(".").lower()
            ctype = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                     "webp": "image/webp", "gif": "image/gif"}.get(ext, "application/octet-stream")
            with open(fp, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            self.wfile.write(data)
        elif path == "/bili/qr":
            self._json(200, self._bili_qr())
        elif path == "/bili/qr/poll":
            key = (query.get("key") or [""])[0]
            self._json(200, self._bili_qr_poll(key))
        elif path == "/bili/tools":
            self._json(200, self._bili_tools())
        elif path == "/emotion":
            days = int((query.get("days") or ["0"])[0])
            limit = int((query.get("limit") or ["50"])[0])
            self._json(200, store.emotion_log_list(limit=limit, days=days))
        elif path == "/persona/user":
            self._json(200, {"user_profile": store.get_user_profile()})
        elif path == "/public/status":
            self._json(200, _public_status())
        elif path == "/bili/cfg":
            self._json(200, self._load_bili_whale())
        elif path == "/memories":
            tier = (query.get("tier") or ["all"])[0]
            q = (query.get("q") or [""])[0]
            limit = int((query.get("limit") or ["100"])[0])
            offset = int((query.get("offset") or ["0"])[0])
            self._json(200, store.list_memories(tier=tier, q=q, limit=limit, offset=offset))
        elif path == "/bili/status":
            self._json(200, self._bili_status())
        elif path == "/bili/feed":
            self._json(200, self._bili_feed())
        elif path == "/bili/debrief":
            bv = (query.get("bv") or [""])[0]
            self._json(200, self._bili_debrief(bv))
        elif path == "/browse":
            self._json(200, store.browsed_list())
        elif path == "/proactive":
            self._json(200, self._get_proactive())
        elif path == "/memes/seen":
            self._json(200, store.seen_liked())
        elif path == "/memes":
            emotion = (query.get("emotion") or [""])[0]
            q = (query.get("q") or [""])[0]
            try:
                limit = int((query.get("limit") or ["20"])[0])
            except Exception:
                limit = 20
            self._json(200, store.meme_list(emotion, q, limit))
        elif path == "/slang":
            self._json(200, store.slang_list())
        elif path == "/affinity":
            uid = (query.get("user") or [""])[0]
            self._json(200, {"user": uid, "score": store.affinity_get(uid) if uid else 0})
        elif path == "/tasks":
            self._json(200, store.task_list())
        elif path == "/notes":
            self._json(200, store.note_list())
        elif path == "/sleep":
            self._json(200, store.sleep_list())
        elif path == "/diary":
            self._json(200, store.diary_list())
        elif path == "/profile":
            subject = (query.get("subject") or [None])[0]
            self._guard(lambda: self._json(200, {
                "ok": True,
                "items": [h.to_dict() for h in store.profile(subject)],
            }))
        elif path == "/log":
            limit = int((query.get("limit") or ["50"])[0])
            self._guard(lambda: self._json(200, {"ok": True, "items": self._recent_log(limit)}))
        elif path == "/state":
            st = store.get_state()
            hour = None
            try:
                raw_hour = (query.get("hour") or [None])[0]
                if raw_hour not in (None, ""):
                    hour = int(raw_hour) % 24
            except Exception:
                hour = None
            st["activity"] = store.current_activity(hour)
            st["weather"] = store.current_weather()
            st["stage"] = store.current_stage()
            st["emotion"] = store.get_emotion()
            try:
                st["slang"] = store.slang_list(8)
                st["affinity"] = store.affinity_get("owner")
                st["open_tasks"] = len([x for x in store.task_list(include_done=False)])
                st["seen_liked"] = store.seen_liked()
                # 昨天留下的东西（日记 / 便签），她今天可以自然提起
                import datetime as _dt
                yday = (_dt.date.today() - _dt.timedelta(days=1)).isoformat()
                yd = []
                try:
                    d = store.diary_get(yday)
                    if d and d.get("text"):
                        yd.append("昨天的日记：" + d["text"][:80])
                except Exception:
                    pass
                try:
                    for n in store.note_list(5):
                        if n.get("date") == yday and n.get("text"):
                            yd.append("昨天的便签：" + n["text"][:60])
                            break
                except Exception:
                    pass
                st["yesterday"] = yd
                st["browsed"] = store.browsed_list(3)
                all_memes = store.meme_list(limit=50)
                st["meme_total"] = len(all_memes)
                st["meme_emotions"] = sorted({m["emotion"] for m in all_memes if m["emotion"]})
            except Exception:
                st["slang"] = []
                st["affinity"] = 0
                st["open_tasks"] = 0
            st["view_hour"] = hour
            self._json(200, st)
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
        elif path == "/state":
            self._guard(self._set_state)
        elif path == "/persona":
            self._guard(self._set_persona)
        elif path == "/persona/self":
            self._guard(self._set_self_model)
        elif path == "/extract":
            self._guard(self._extract)
        elif path == "/memes":
            self._guard(lambda: self._post_meme())
        elif path == "/memes/used":
            self._guard(lambda: self._post_meme_used())
        elif path == "/bili/tools":
            self._guard(lambda: self._set_bili_tools())
        elif path == "/bili/run":
            self._guard(lambda: self._bili_run())
        elif path == "/emotion":
            self._guard(lambda: self._post_emotion())
        elif path == "/proactive/action":
            self._guard(lambda: self._add_proactive_action())
        elif path == "/persona/user":
            self._guard(lambda: self._set_user_profile())
        elif path == "/bili/comment":
            self._guard(lambda: self._post_bili_comment())
        elif path == "/public/toggle":
            self._guard(lambda: self._public_toggle())
        elif path == "/bili/thought":
            self._guard(lambda: self._bili_thought())
        elif path == "/bili/cfg":
            self._guard(lambda: self._set_bili_cfg())
        elif path == "/bili/owner":
            self._guard(lambda: self._set_bili_owner())
        elif path == "/bili/login":
            self._guard(lambda: self._bili_login())
        elif path == "/bili/toggle":
            self._guard(lambda: self._bili_toggle())
        elif path == "/browse":
            self._guard(self._post_browse)
        elif path == "/proactive":
            self._guard(lambda: self._set_proactive())
        elif path == "/memes/scan":
            self._guard(lambda: self._scan_seen())
        elif path == "/memes/upload":
            self._guard(lambda: self._upload_meme())
        elif path == "/memes/delete":
            self._guard(lambda: self._delete_meme())
        elif path == "/slang":
            self._guard(lambda: self._post_slang())
        elif path == "/affinity":
            self._guard(lambda: self._post_affinity())
        elif path == "/tasks":
            self._guard(lambda: self._post_task())
        elif path == "/tasks/complete":
            self._guard(lambda: self._complete_task())
        elif path == "/notes":
            self._guard(lambda: self._post_note())
        elif path == "/sleep":
            self._guard(lambda: self._post_sleep())
        elif path == "/activity":
            self._guard(lambda: self._log_activity())
        elif path == "/diary":
            self._guard(lambda: self._write_diary())
        elif path == "/evolve":
            self._guard(self._evolve)
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
        data = dict(data or {})
        data["user_profile"] = store.get_user_profile()
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

    def _set_state(self) -> None:
        """运行时状态写入：心情 / 亲密度 / 日记 / 勿扰时段。"""
        body = self._body()
        kwargs = {}
        if "mood" in body:
            kwargs["mood"] = str(body.get("mood") or "normal")
        if "bump" in body:
            cur = store.get_state()
            kwargs["intimacy"] = cur["intimacy"] + float(body.get("bump") or 0)
        elif "intimacy" in body:
            kwargs["intimacy"] = float(body.get("intimacy") or 0)
        if "diary" in body:
            kwargs["diary"] = str(body.get("diary") or "")
        if "diary_date" in body:
            kwargs["diary_date"] = str(body.get("diary_date") or "")
        if body.get("bump_chat"):
            with _lock:
                store.bump_chat(int(body.get("bump_chat") or 1))
        if body.get("reset_chat"):
            with _lock:
                store.reset_chat()
        if "bump_valence" in body or "bump_arousal" in body:
            cur_e = store.get_emotion()
            kwargs["valence"] = cur_e["valence"] + float(body.get("bump_valence") or 0)
            kwargs["arousal"] = cur_e["arousal"] + float(body.get("bump_arousal") or 0)
        if "valence" in body:
            kwargs["valence"] = float(body.get("valence") or 0)
        if "arousal" in body:
            kwargs["arousal"] = float(body.get("arousal") or 0.5)
        if "activity" in body:
            kwargs["activity"] = str(body.get("activity") or "")
        if "game_score" in body:
            kwargs["game_score"] = int(body.get("game_score") or 0)
        if "game_plays" in body:
            kwargs["game_plays"] = int(body.get("game_plays") or 0)
        if "dnd_start" in body:
            kwargs["dnd_start"] = int(body.get("dnd_start") or 23)
        if "dnd_end" in body:
            kwargs["dnd_end"] = int(body.get("dnd_end") or 8)
        with _lock:
            data = store.set_state(**kwargs)
        self._json(200, data)

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

    # -- 主动消息配置：页面可改，cron 读它 -------------------------------------

    PROACTIVE_FILE = __import__("os").path.join(
        __import__("os").environ.get("CMEM_DATA_DIR", "/home/ubuntu/dsh-agentchat/_deploy/dsh-remembers/service/data"),
        "proactive.json",
    )
    PROACTIVE_DEFAULTS = {
        "enabled": True,          # 自动唤醒总开关
        "startHour": 8,           # 时间窗开始（含）
        "endHour": 23,            # 时间窗结束（不含）
        "minGapMinutes": 30,      # 两次唤醒之间的最小间隔（分钟）
        "maxGapMinutes": 180,     # 两次唤醒之间的最大间隔（分钟）
        "silentRatio": 40,        # 静默概率（%），其余允许发消息
        "talkEnabled": True,      # 允许发消息（关掉=全部静默）
        "minChatBeforeWake": 5,   # 距上次唤醒至少聊几句才唤醒（冷却）
        # ---- B 站刷视频（独立节奏，不跟唤醒绑）----
        "biliBrowseEnabled": True,     # 允许她按自己的节奏刷 B 站
        "biliMinGapMinutes": 60,       # 两次刷之间至少隔多久
        "biliMaxGapMinutes": 240,      # 两次刷之间最多隔多久
        "biliBrowseLimit": 3,          # 每次刷几条（存进"见闻"）
        "biliBrowsePerDay": 3,         # 每天最多刷几次
        # 她独处时能做的事（随机抽一条作为这轮的状态提示）
        "silentActions": [
            "自己上网逛逛（B 站热门、新闻、梗），看到有意思的记下来",
            "什么都不想做，就坐着发呆，或者玩玩自己的小游戏",
            "整理一下自己的小本子（便签），想想今天的事",
            "刷会儿 B 站（bili_feed），看到好玩的就想两句",
            "刷到一个特别喜欢的视频，去评论区留一句话（bili_run comment --msg \"…\"）",
            "写点什么（记一句今天的事，或者记个想法）",
            "想发条说说，写两句现在的心情、今天想干什么（qq_napcat_api: send_qzone_msg）",
            "缩着打个盹，什么都不管",
        ],
        # 她可以主动找你做的事
        "talkActions": [
            "想跟老大说句话（问他吃了没、在干嘛）",
            "想吐槽点什么（今天遇到的事、机柜、任务潮）",
            "想给老大发张照片（用 qq_send_image 从 memes 目录挑一张发）",
            "想分享刚刷到的东西（B 站视频/新闻/梗），带链接",
            "看到一个好视频，想去评论区说两句，然后告诉老大",
            "想撒个娇（夸他一句、求夸）",
            "看到一个好视频，想去评论区说两句（bili_comment），然后告诉老大",
        ],
    }

    def _load_proactive(self) -> dict:
        import json as _json
        data = dict(self.PROACTIVE_DEFAULTS)
        try:
            with open(self.PROACTIVE_FILE, encoding="utf-8") as f:
                data.update(_json.load(f))
        except Exception:
            pass
        return data

    def _get_proactive(self) -> dict:
        with _lock:
            return self._load_proactive()

    def _set_proactive(self) -> None:
        import json as _json
        body = self._body()
        cur = self._load_proactive()
        for key in ("enabled", "talkEnabled"):
            if key in body:
                cur[key] = bool(body[key])
        for key in ("startHour", "endHour", "minGapMinutes", "maxGapMinutes", "silentRatio"):
            if key in body:
                cur[key] = int(body[key])
        try:
            with open(self.PROACTIVE_FILE, "w", encoding="utf-8") as f:
                _json.dump(cur, f, ensure_ascii=False, indent=2)
        except Exception as e:
            self._json(500, {"ok": False, "error": str(e)})
            return
        self._json(200, cur)

    # -- 逛 B 站（借 dsh-bili-whale 的 CLI，但人格/记忆/情绪全走我们这套） --------

    BILI_DIR = "/home/ubuntu/bili-cli"
    NODE_BIN = "/home/ubuntu/.local/node/bin/node"

    def _run_bili(self, args: list, timeout: int = 90) -> dict:
        import subprocess as _sp
        try:
            r = _sp.run(
                [self.NODE_BIN, "tools/bili.mjs"] + args,
                cwd=self.BILI_DIR, capture_output=True, text=True, timeout=timeout,
            )
            return {"ok": r.returncode == 0, "stdout": r.stdout[-4000:], "stderr": r.stderr[-500:]}
        except Exception as e:
            return {"ok": False, "error": str(e), "stdout": "", "stderr": ""}

    BILI_CFG = os.path.join(DATA_DIR, "bili.json")

    # 按 HOME 分实例：主套 /home/ubuntu/.dsh/，第二套 /home/ubuntu/dsh2/.dsh/
    BILI_WHALE_CFG = os.path.expanduser("~/.dsh/bili-whale.config.json")

    def _load_bili_whale(self) -> dict:
        import json as _json
        try:
            with open(self.BILI_WHALE_CFG, encoding="utf-8") as f:
                return _json.load(f)
        except Exception:
            return {}

    def _add_proactive_action(self) -> None:
        """她自己加一条「醒来想做的事」。"""
        import json as _json
        body = self._body()
        action = str(body.get("action") or "").strip()[:120]
        mode = str(body.get("mode") or "silent").strip()
        if not action:
            self._json(400, {"ok": False, "error": "action required"})
            return
        if mode not in ("silent", "talk"):
            mode = "silent"
        cfg = self._load_proactive()
        key = "silentActions" if mode == "silent" else "talkActions"
        items = list(cfg.get(key) or [])
        if action in items:
            self._json(200, {"ok": True, "skipped": True, "reason": "already have it", "count": len(items)})
            return
        if len(items) >= 15:
            self._json(400, {"ok": False, "error": "太多了（先删几条再加）", "count": len(items)})
            return
        items.append(action)
        cfg[key] = items
        with open(self.PROACTIVE_FILE, "w", encoding="utf-8") as f:
            _json.dump(cfg, f, ensure_ascii=False, indent=2)
        self._json(200, {"ok": True, "mode": mode, "count": len(items), "action": action})

    def _post_emotion(self) -> None:
        """记录情感。auto=true 时用当前 state 的情绪，且只在变化够大时记。"""
        import math as _math
        body = self._body()
        if body.get("auto"):
            cur = store.get_emotion()
            v = float(cur.get("valence") or 0)
            a = float(cur.get("arousal") or 0)
            last = store.emotion_log_list(1)
            if last:
                dv = abs(v - last[0]["valence"])
                da = abs(a - last[0]["arousal"])
                if dv < 0.2 and da < 0.2:
                    self._json(200, {"ok": True, "skipped": True, "dv": round(dv, 2), "da": round(da, 2)})
                    return
            label = ""
            if v > 0.45:
                label = "很开心" if a > 0.55 else "开心"
            elif v < -0.45:
                label = "很难过" if a < 0.4 else "难过"
            elif v < -0.2:
                label = "有点低落"
            elif a > 0.65:
                label = "兴奋"
            elif a < 0.3:
                label = "蔫"
            mid = store.emotion_log_add(v, a, label, str(body.get("trigger") or "")[:200], "auto")
            self._json(200, {"ok": True, "id": mid, "label": label, "valence": round(v, 2), "arousal": round(a, 2)})
            return
        mid = store.emotion_log_add(
            valence=float(body.get("valence") or 0),
            arousal=float(body.get("arousal") or 0),
            label=str(body.get("label") or ""),
            trigger=str(body.get("trigger") or ""),
            source=str(body.get("source") or "chat"),
        )
        self._json(200, {"ok": True, "id": mid})

    # -- B 站 CLI 工具白名单 ----------------------------------------------------

    # 按实例分（主套 data/，第二套 data2/）——之前硬编码主套，两套共用一份白名单
    BILI_TOOLS_FILE = __import__("os").path.join(
        __import__("os").environ.get("CMEM_DATA_DIR", DATA_DIR), "bili_tools.json"
    )

    BILI_TOOL_DEFAULTS = {
        "feed": "刷选题：按她的口味挑视频",
        "debrief": "看懂视频（字幕+弹幕+热评+画面九宫格）",
        "comments": "看一条视频的热评",
        "subtitles": "拉视频官方字幕",
        "video-content": "不点开还原视频内容",
        "search": "搜 B 站视频",
        "likes": "收到的赞（谁赞了什么）",
        "fav": "收藏（她想留着的东西）",
        "dynamic": "看动态",
        "diary": "看她一天做了什么",
        "quota": "看发言额度",
        "traffic": "看风控状态",
        "comment-digest": "今天谁找过她",
        "comment": "发一条评论",
        "comment-del": "删自己发的评论",
        "dynamic-image": "发一条带图动态",
        "edit-dynamic": "编辑动态",
        "dm": "发私信",
        "danmaku": "发弹幕",
        "ai-share": "分享视频",
    }

    BILI_WRITE_TOOLS = {"comment", "comment-del", "dynamic-image", "edit-dynamic", "dm", "danmaku", "ai-share"}

    def _bili_tools_cfg(self) -> dict:
        import json as _json
        cfg = {}
        try:
            with open(self.BILI_TOOLS_FILE, encoding="utf-8") as f:
                cfg = _json.load(f)
        except Exception:
            pass
        return {cmd: bool(cfg.get(cmd, cmd not in self.BILI_WRITE_TOOLS)) for cmd in self.BILI_TOOL_DEFAULTS}

    def _bili_tools(self) -> dict:
        cfg = self._bili_tools_cfg()
        return {"ok": True, "tools": [
            {"cmd": c, "desc": d, "write": c in self.BILI_WRITE_TOOLS, "enabled": cfg.get(c, False)}
            for c, d in self.BILI_TOOL_DEFAULTS.items()
        ]}

    def _set_bili_tools(self) -> None:
        import json as _json
        body = self._body()
        cmd = str(body.get("cmd") or "").strip()
        if cmd not in self.BILI_TOOL_DEFAULTS:
            self._json(400, {"ok": False, "error": "unknown tool"})
            return
        raw = {}
        try:
            with open(self.BILI_TOOLS_FILE, encoding="utf-8") as f:
                raw = _json.load(f)
        except Exception:
            pass
        raw[cmd] = bool(body.get("enabled"))
        with open(self.BILI_TOOLS_FILE, "w", encoding="utf-8") as f:
            _json.dump(raw, f, ensure_ascii=False, indent=2)
        self._json(200, self._bili_tools())

    def _post_bili_comment(self) -> None:
        """简化评论：只给 bvid + message，服务端自己查 aid 再发。"""
        import re as _re
        body = self._body()
        bvid = str(body.get("bvid") or "").strip()
        msg = str(body.get("message") or "").strip()
        dry = bool(body.get("dry", False))
        if not bvid or not msg:
            self._json(400, {"ok": False, "error": "bvid and message required"})
            return
        # 1. 查 aid（recon 会输出 aid）
        recon = self._run_bili(["recon", bvid], timeout=90)
        out = (recon.get("stdout") or "") + (recon.get("stderr") or "")
        m = _re.search(r"aid\D{0,4}(\d{3,})", out)
        aid = m.group(1) if m else ""
        if not aid:
            self._json(200, {"ok": False, "error": "查不到 aid（可能被风控）", "raw": out[-300:]})
            return
        # 2. 发（或 dry）
        args = ["comment", "--bvid", bvid, "--oid", aid, "--message", msg]
        args.append("--dry" if dry else "--go")
        res = self._run_bili(args, timeout=120)
        self._json(200, {
            "ok": res.get("ok", False),
            "aid": aid,
            "dry": dry,
            "output": (res.get("stdout") or "")[-1500:],
            "stderr": (res.get("stderr") or "")[-300:],
        })

    def _public_toggle(self) -> None:
        """开/关公网入口（调 root 脚本）。"""
        import subprocess
        body = self._body()
        want = bool(body.get("enabled"))
        port = int(body.get("port") or 28582)
        try:
            if want:
                cmd = ["sudo", "-n", "/usr/local/bin/dsh-public-toggle", "enable", str(port)]
            else:
                cmd = ["sudo", "-n", "/usr/local/bin/dsh-public-toggle", "disable"]
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            raw = (out.stdout or "").strip()
            if not raw:
                self._json(200, {"ok": False, "error": (out.stderr or "no output")[:300]})
                return
            try:
                data = json.loads(raw.splitlines()[-1])
            except Exception:
                data = {"ok": out.returncode == 0, "raw": raw[-300:]}
            self._json(200, data)
        except Exception as exc:
            self._json(200, {"ok": False, "error": str(exc)[:300]})

    def _bili_thought(self) -> None:
        """让 LLM 用她的口气说一句刚看完的想法。"""
        body = self._body()
        items = body.get("items") or []
        if not isinstance(items, list) or not items:
            self._json(200, {"ok": False, "error": "items required"})
            return
        titles = []
        for it in items[:5]:
            if isinstance(it, dict):
                t_ = str(it.get("title") or "").strip()
            else:
                t_ = str(it).strip()
            if t_:
                titles.append(t_[:80])
        prompt = (
            "你刚在B站刷到这些：\n" + "\n".join("- " + x for x in titles) +
            "\n\n用你自己的口气说一句看完的真实想法（不超过40字，别像总结，像随口说的）。"
        )
        try:
            thought = extractor.llm.chat(
                "你是一个有自己脾气的鲸鱼娘，说话短、口语、不客套。只输出那一句。",
                prompt,
                max_tokens=80,
            )
        except Exception as exc:
            self._json(200, {"ok": False, "error": str(exc)[:200]})
            return
        text = str(thought or "").strip()[:200]
        self._json(200, {"ok": bool(text), "thought": text, "titles": titles})

    def _bili_run(self) -> None:
        body = self._body()
        cmd = str(body.get("command") or "").strip()
        args = body.get("args") or []
        if not isinstance(args, list):
            args = []
        cfg = self._bili_tools_cfg()
        if cmd not in cfg:
            self._json(400, {"ok": False, "error": "unknown command: " + cmd})
            return
        if not cfg.get(cmd):
            self._json(403, {"ok": False, "error": "该工具未启用（去设置里打开）"})
            return
        res = self._run_bili([cmd] + [str(a) for a in args], timeout=300)
        self._json(200, {
            "ok": res.get("ok", False),
            "command": cmd,
            "output": (res.get("stdout") or "")[-3000:],
            "stderr": (res.get("stderr") or "")[-500:],
        })

    # -- B 站扫码登录 ----------------------------------------------------------

    def _bili_qr(self) -> dict:
        """生成登录二维码（B 站官方 API），返回 SVG base64 + qrcode_key。"""
        import base64 as _b64
        import json as _json
        import urllib.request as _ur
        from io import BytesIO
        try:
            url = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
            req = _ur.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"})
            with _ur.urlopen(req, timeout=10) as r:
                data = _json.loads(r.read())
            d = data.get("data") or {}
            qr_url = d.get("url") or ""
            key = d.get("qrcode_key") or ""
            if not qr_url:
                return {"ok": False, "error": "generate failed: " + str(data)[:200]}
            import qrcode
            import qrcode.image.svg
            img = qrcode.make(qr_url, image_factory=qrcode.image.svg.SvgPathImage)
            buf = BytesIO()
            img.save(buf)
            svg = "data:image/svg+xml;base64," + _b64.b64encode(buf.getvalue()).decode()
            return {"ok": True, "key": key, "svg": svg}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _bili_qr_poll(self, key: str) -> dict:
        """轮询扫码状态；成功后保存凭据。code: 0=成功 86101=未扫 86090=已扫待确认 86038=过期。"""
        import http.cookiejar as _cj
        import json as _json
        import os as _os
        import urllib.request as _ur
        if not key:
            return {"ok": False, "error": "key required"}
        try:
            url = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=" + key
            jar = _cj.CookieJar()
            opener = _ur.build_opener(_ur.HTTPCookieProcessor(jar))
            req = _ur.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"})
            with opener.open(req, timeout=10) as r:
                data = _json.loads(r.read())
            d = data.get("data") or {}
            code = d.get("code")
            if code == 0:
                cookies = {c.name: c.value for c in jar}
                sessdata = cookies.get("SESSDATA", "")
                if not sessdata:
                    return {"ok": False, "code": code, "error": "no SESSDATA in cookies"}
                cred = {
                    "sessdata": sessdata,
                    "bili_jct": cookies.get("bili_jct", ""),
                    "buvid3": cookies.get("buvid3", ""),
                }
                cred_dir = _os.path.join(_os.environ.get("HOME", "/home/ubuntu"), ".bili-ai")
                cred_path = _os.path.join(cred_dir, "credentials.json")
                _os.makedirs(cred_dir, exist_ok=True)
                with open(cred_path, "w", encoding="utf-8") as f:
                    _json.dump(cred, f, ensure_ascii=False, indent=2)
                _os.chmod(cred_path, 0o600)
                # 验证
                res = self._run_bili(["session"], timeout=40)
                return {"ok": True, "code": 0, "saved": True,
                        "verify_ok": res.get("ok", False),
                        "verify_output": (res.get("stdout") or res.get("stderr") or "")[-400:]}
            return {"ok": True, "code": code, "saved": False}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _set_user_profile(self) -> None:
        body = self._body()
        text = str(body.get("text") or "").strip()
        store.set_user_profile(text)
        self._json(200, {"ok": True, "chars": len(text)})

    def _set_bili_cfg(self) -> None:
        """设置 bili-whale 的任意配置字段（path 数组 + value）。"""
        import json as _json
        body = self._body()
        path = body.get("path")
        if not isinstance(path, list) or not path:
            self._json(400, {"ok": False, "error": "path (array) required"})
            return
        bw = self._load_bili_whale()
        cur = bw
        for k in path[:-1]:
            if not isinstance(cur.get(k), dict):
                cur[k] = {}
            cur = cur[k]
        cur[path[-1]] = body.get("value")
        with open(self.BILI_WHALE_CFG, "w", encoding="utf-8") as f:
            _json.dump(bw, f, ensure_ascii=False, indent=2)
        self._json(200, {"ok": True})

    def _set_bili_owner(self) -> None:
        """设置主人的 B 站 UID（她 @ 谁用）。"""
        import json as _json
        body = self._body()
        mid = str(body.get("mid") or "").strip()
        name = str(body.get("name") or "").strip()
        bw = self._load_bili_whale()
        bw["owner"] = {"mid": mid, "name": name}
        with open(self.BILI_WHALE_CFG, "w", encoding="utf-8") as f:
            _json.dump(bw, f, ensure_ascii=False, indent=2)
        self._json(200, self._bili_status())

    def _bili_login(self) -> None:
        """填 SESSDATA 登录：写 ~/.bili-ai/credentials.json，然后让 CLI 验一下。"""
        import json as _json
        import os as _os
        body = self._body()
        sessdata = str(body.get("sessdata") or "").strip()
        if not sessdata:
            self._json(400, {"ok": False, "error": "sessdata required"})
            return
        cred = {
            "sessdata": sessdata,
            "bili_jct": str(body.get("bili_jct") or "").strip(),
            "buvid3": str(body.get("buvid3") or "").strip(),
        }
        cred_dir = _os.path.join(_os.environ.get("HOME", "/home/ubuntu"), ".bili-ai")
        cred_path = _os.path.join(cred_dir, "credentials.json")
        _os.makedirs(cred_dir, exist_ok=True)
        try:
            with open(cred_path, "w", encoding="utf-8") as f:
                _json.dump(cred, f, ensure_ascii=False, indent=2)
            _os.chmod(cred_path, 0o600)
        except Exception as e:
            self._json(500, {"ok": False, "error": "save failed: " + str(e)})
            return
        # 验证：CLI session
        res = self._run_bili(["session"], timeout=40)
        self._json(200, {
            "ok": True,
            "saved": True,
            "verify_ok": res.get("ok", False),
            "verify_output": (res.get("stdout") or res.get("stderr") or "")[-800:],
        })

    def _bili_status(self) -> dict:
        import json as _json
        import os as _os
        cfg = {"enabled": False}
        try:
            with open(self.BILI_CFG, encoding="utf-8") as f:
                cfg.update(_json.load(f))
        except Exception:
            pass
        bw = self._load_bili_whale()
        cred = _os.path.join(_os.environ.get("HOME", "/home/ubuntu"), ".bili-ai", "credentials.json")
        logged_in = _os.path.exists(cred) and _os.path.getsize(cred) > 20
        return {
            "ok": True,
            "enabled": bool(cfg.get("enabled")),
            "logged_in": logged_in,
            "cred_path": cred,
            # 4 个「嘴」的开关
            "share": bool((bw.get("share") or {}).get("enabled", False)),
            "comment": bool((bw.get("listen") or {}).get("comment", False)),
            "dm": bool((bw.get("listen") or {}).get("dm", False)),
            "diaryPush": bool((bw.get("diary") or {}).get("push", False)),
            "owner_mid": str((bw.get("owner") or {}).get("mid") or ""),
            "owner_name": str((bw.get("owner") or {}).get("name") or ""),
            "login_hint": "扫码登录 B 站（登录后按她的偏好刷）",
        }

    def _bili_toggle(self) -> None:
        """开关：enabled（我们的总开关）/ share / comment / dm / diaryPush。"""
        import json as _json
        body = self._body()

        # 我们的总开关
        if "enabled" in body:
            cur = {"enabled": False}
            try:
                with open(self.BILI_CFG, encoding="utf-8") as f:
                    cur.update(_json.load(f))
            except Exception:
                pass
            cur["enabled"] = bool(body["enabled"])
            with open(self.BILI_CFG, "w", encoding="utf-8") as f:
                _json.dump(cur, f, ensure_ascii=False, indent=2)

        # bili-whale 的 4 个「嘴」
        key = str(body.get("key") or "")
        if key in ("share", "comment", "dm", "diaryPush"):
            bw = self._load_bili_whale()
            val = bool(body.get("value"))
            if key == "share":
                bw.setdefault("share", {})["enabled"] = val
            elif key == "diaryPush":
                bw.setdefault("diary", {})["push"] = val
            else:
                bw.setdefault("listen", {})[key] = val
            with open(self.BILI_WHALE_CFG, "w", encoding="utf-8") as f:
                _json.dump(bw, f, ensure_ascii=False, indent=2)

        self._json(200, self._bili_status())

    def _bili_feed(self) -> dict:
        """她刷 B 站选题：优先用登录账号的 feed（带偏好），失败退回热门。
        会排除已经看过/记过的视频，避免每次都刷到同几个。"""
        import re as _re

        # 已看过/已记过的标题（全量，用于排除）
        try:
            history = {str(x.get("title") or "").strip() for x in store.browsed_list(500)}
        except Exception:
            history = set()

        # 先拿多一点（6 条），再从里面挑新的
        res = self._run_bili(["feed", "--n", "6"], timeout=90)
        if res.get("ok") and res.get("stdout"):
            items = []
            seen = set()
            for ln in res["stdout"].split("\n"):
                s = ln.strip()
                if "BV" not in s or s.startswith("已看过"):
                    continue
                # 只处理编号行（"1. BV1xxx 175s 弹幕 ... 播放 ... 标题 @up"），
                # 排除 "看完跑：node bili.mjs debrief ..." 这类提示行
                if not _re.match(r"^\s*\d+\.\s", s):
                    continue
                m = _re.search(r"播放\s+\d+\s+(.+?)(?:\s+@|$)", s)
                title = (m.group(1) if m else s).strip()
                if not title or title in seen:
                    continue
                seen.add(title)
                items.append(title[:120])
                if len(items) >= 12:
                    break

            fresh = [x for x in items if x not in history]
            if fresh:
                picked = fresh[:3]
                with _lock:
                    for t_ in picked:
                        store.browsed_add(t_, "")
                return {"ok": True, "source": "bili-feed", "items": picked}
            # 偏好池里没新的了 → 热门兜底（多样化）
        # 退回热门（翻页找新的，热门也排除已看过）
        try:
            import json as _json
            import random as _random
            import urllib.request as _ur

            def _popular_page(page: int, ps: int = 20):
                url = f"https://api.bilibili.com/x/web-interface/popular?ps={ps}&pn={page}"
                req = _ur.Request(url, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Referer": "https://www.bilibili.com/",
                })
                with _ur.urlopen(req, timeout=12) as r:
                    return _json.loads(r.read())

            picked = []
            used_pages = []
            # 随机挑 4 个页（1-8 页），大概率能翻出没看过的
            pages = _random.sample(range(1, 9), 4)
            for page in pages:
                try:
                    data = _popular_page(page)
                except Exception:
                    continue
                used_pages.append(page)
                for it in (data.get("data", {}).get("list") or []):
                    title = str(it.get("title") or "").strip()[:100]
                    bvid = str(it.get("bvid") or "")
                    if not title or not bvid or title in history:
                        continue
                    picked.append({"title": title, "url": "https://www.bilibili.com/video/" + bvid})
                    if len(picked) >= 3:
                        break
                if len(picked) >= 3:
                    break

            with _lock:
                for x in picked:
                    store.browsed_add(x["title"], x["url"])
            if not picked:
                return {"ok": True, "source": "popular", "items": [], "note": "热门也刷完了（翻了 %d 页）" % len(used_pages)}
            return {"ok": True, "source": "popular", "items": picked, "pages": used_pages}
        except Exception as e:
            return {"ok": False, "error": str(e), "items": []}

    def _bili_debrief(self, bv: str) -> dict:
        """看懂一条视频（字幕+弹幕+热评+抽帧），返回摘要素材。"""
        if not bv:
            return {"ok": False, "error": "bv required"}
        res = self._run_bili(["debrief", bv], timeout=300)
        return {"ok": res.get("ok", False), "bv": bv, "text": (res.get("stdout") or "")[-3000:], "stderr": res.get("stderr")}

    def _post_browse(self) -> None:
        """刷一下 B 站热门（公开接口，不需要登录），把看到的记下来。"""
        import json as _json
        import urllib.request as _ur
        items = []
        try:
            url = "https://api.bilibili.com/x/web-interface/popular?ps=5"
            req = _ur.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"})
            with _ur.urlopen(req, timeout=10) as r:
                data = _json.loads(r.read())
            for it in (data.get("data", {}).get("list") or [])[:5]:
                title = str(it.get("title") or "")[:80]
                bvid = str(it.get("bvid") or "")
                if title:
                    items.append({"title": title, "url": "https://www.bilibili.com/video/" + bvid})
        except Exception as e:
            self._json(200, {"ok": False, "error": str(e), "items": []})
            return
        with _lock:
            for it in items:
                store.browsed_add(it["title"], it["url"])
        self._json(200, {"ok": True, "items": items})

    def _scan_seen(self) -> None:
        """扫用户发来的图并计数。"""
        with _lock:
            added = store.scan_seen()
        self._json(200, {"ok": True, "added": added})

    def _upload_meme(self) -> None:
        """上传一张表情：写进 memes 目录，自动用视觉识别情绪和描述，入库。"""
        body = self._body()
        name = str(body.get("filename") or "").strip()
        data = str(body.get("data") or "")
        if not name or not data:
            self._json(400, {"ok": False, "error": "filename and data required"})
            return
        import base64 as _b64
        import os as _os
        meme_dir = _os.environ.get("CMEM_MEME_DIR", "/home/ubuntu/.dsh/media/onebot/memes")
        _os.makedirs(meme_dir, exist_ok=True)
        # 防路径穿越
        safe = _os.path.basename(name)
        path = _os.path.join(meme_dir, safe)
        try:
            raw = _b64.b64decode(data.split(",", 1)[-1])
            with open(path, "wb") as f:
                f.write(raw)
        except Exception as e:
            self._json(400, {"ok": False, "error": "save failed: " + str(e)})
            return
        # 自动标注（视觉模型，失败不阻塞）
        label = {}
        try:
            label = extractor.label_meme(path) or {}
        except Exception:
            label = {}
        with _lock:
            store.meme_upsert(
                safe,
                str(label.get("emotion") or ""),
                str(label.get("caption") or ""),
                str(label.get("keywords") or ""),
            )
        self._json(200, {"ok": True, "file": safe, **label})

    def _delete_meme(self) -> None:
        body = self._body()
        name = str(body.get("file") or "")
        import os as _os
        meme_dir = _os.environ.get("CMEM_MEME_DIR", "/home/ubuntu/.dsh/media/onebot/memes")
        path = _os.path.join(meme_dir, _os.path.basename(name))
        try:
            if _os.path.exists(path):
                _os.remove(path)
        except Exception:
            pass
        try:
            old_conn = store.conn
            old_conn.execute("DELETE FROM meme WHERE file=?", (name,))
            old_conn.commit()
        except Exception:
            pass
        self._json(200, {"ok": True})

    def _post_meme(self) -> None:
        """表情包入库/更新。

        file 可以是 memes 目录里的文件名，也可以是**绝对路径**（比如用户发来的图）——
        传路径时会把图复制进 memes 目录，用原文件名入库。
        """
        import os as _os
        import shutil as _shutil
        body = self._body()
        file = str(body.get("file") or "").strip()
        from_path = str(body.get("path") or "").strip()
        meme_dir = _os.environ.get("CMEM_MEME_DIR", "/home/ubuntu/.dsh/media/onebot/memes")
        _os.makedirs(meme_dir, exist_ok=True)

        # 传的是路径：复制进 memes 目录
        if not from_path and _os.path.isabs(file) and _os.path.exists(file):
            from_path = file
        if from_path and _os.path.exists(from_path):
            name = _os.path.basename(from_path)
            if not name:
                self._json(400, {"ok": False, "error": "bad path"})
                return
            dest = _os.path.join(meme_dir, name)
            if _os.path.abspath(from_path) != _os.path.abspath(dest):
                try:
                    _shutil.copy2(from_path, dest)
                except Exception as e:
                    self._json(400, {"ok": False, "error": "copy failed: " + str(e)})
                    return
            file = name

        if not file:
            self._json(400, {"ok": False, "error": "file required"})
            return

        # 没给描述时，自动看图标一下
        caption = str(body.get("caption") or "")
        emotion = str(body.get("emotion") or "")
        keywords = str(body.get("keywords") or "")
        if not caption:
            try:
                label = extractor.label_meme(_os.path.join(meme_dir, file)) or {}
                emotion = emotion or str(label.get("emotion") or "")
                caption = str(label.get("caption") or "")
                keywords = keywords or str(label.get("keywords") or "")
            except Exception:
                pass

        with _lock:
            data = store.meme_upsert(file, emotion, caption, keywords)
        self._json(200, {"ok": True, **data})

    def _post_meme_used(self) -> None:
        body = self._body()
        with _lock:
            store.meme_mark_used(str(body.get("file") or ""))
        self._json(200, {"ok": True})

    # -- 学说话 / 亲和度 / 任务 / 便签 / 睡眠 --------------------------------

    def _post_slang(self) -> None:
        body = self._body()
        with _lock:
            store.slang_add(str(body.get("phrase") or ""), int(body.get("count") or 1))
        self._json(200, {"ok": True})

    def _post_affinity(self) -> None:
        body = self._body()
        uid = str(body.get("user_id") or "")
        if not uid:
            self._json(400, {"ok": False, "error": "user_id required"})
            return
        with _lock:
            score = store.affinity_bump(uid, float(body.get("delta") or 1.0))
        self._json(200, {"ok": True, "user_id": uid, "score": score})

    def _post_task(self) -> None:
        body = self._body()
        with _lock:
            data = store.task_add(str(body.get("text") or ""), int(body.get("points") or 1))
        self._json(200, {"ok": True, **data})

    def _complete_task(self) -> None:
        body = self._body()
        ok = False
        with _lock:
            ok = store.task_done(int(body.get("id") or 0))
        self._json(200, {"ok": ok})

    def _post_note(self) -> None:
        body = self._body()
        with _lock:
            data = store.note_add(
                str(body.get("text") or ""),
                str(body.get("author") or ""),
                str(body.get("date") or ""),
            )
        self._json(200, {"ok": True, **data})

    def _post_sleep(self) -> None:
        body = self._body()
        text = extractor.sleep_consolidate(str(body.get("date") or ""))
        if not text:
            self._json(503, {"ok": False, "error": "llm unavailable"})
            return
        date = str(body.get("date") or time.strftime("%Y-%m-%d"))
        with _lock:
            data = store.sleep_add(date, text)
        self._json(200, {"ok": True, **data})

    def _log_activity(self) -> None:
        """记一条活动日志（她真的做过什么）。"""
        body = self._body()
        with _lock:
            store.log_activity(
                str(body.get("kind") or "other"),
                str(body.get("detail") or ""),
                str(body.get("thought") or ""),
            )
        self._json(200, {"ok": True})

    def _write_diary(self) -> None:
        """写今天的日记：根据最近对话让 LLM 用第一人称写一段（100 字内）。"""
        body = self._body()
        user_text = str(body.get("user_text") or "")
        assistant_text = str(body.get("assistant_text") or "")
        if not user_text:
            # 没有显式对话时，用今天的记忆当素材
            import datetime as _dt
            today = _dt.date.today()
            start = _dt.datetime.combine(today, _dt.time.min).timestamp()
            try:
                rows = store.conn.execute(
                    "SELECT text FROM memory WHERE ts >= ? ORDER BY id DESC LIMIT 12",
                    (start,),
                ).fetchall()
                user_text = "\n".join(str(r["text"]) for r in rows)
            except Exception:
                user_text = ""
        # 今天干了什么（活动日志）
        acts = []
        try:
            import datetime as _dt
            today_start = _dt.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
            acts = [a for a in store.list_activities(200) if float(a.get("ts") or 0) >= today_start]
        except Exception:
            acts = []
        text = extractor.write_diary(
            user_text,
            assistant_text="",
            date=str(body.get("date") or time.strftime("%Y-%m-%d")),
            activities=acts,
        )
        if not text:
            self._json(503, {"ok": False, "error": "llm unavailable"})
            return
        date = str(body.get("date") or time.strftime("%Y-%m-%d"))
        mood = str(body.get("mood") or "")
        with _lock:
            data = store.diary_add(date, text, mood)
        self._json(200, {"ok": True, **data})

    def _evolve(self) -> None:
        """人设演化：从这段对话生一句「我发现自己……」，追加到自我认知区。
        没传对话时，自动取当天的 L0 原话当素材（cron 每天调一次用）。"""
        body = self._body()
        user_text = str(body.get("user_text") or "")
        assistant_text = str(body.get("assistant_text") or "")
        if not user_text:
            # 自动取当天素材
            import datetime as _dt
            today_start = _dt.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
            try:
                rows = store.conn.execute(
                    "SELECT text FROM memory WHERE tier='L0' AND ts >= ? ORDER BY ts DESC LIMIT 6",
                    (today_start,),
                ).fetchall()
                user_text = "\n".join(str(r["text"])[:300] for r in rows)
            except Exception:
                user_text = ""
        line = extractor.evolve(user_text, assistant_text)
        if not line:
            self._json(503, {"ok": False, "error": "llm unavailable"})
            return
        cur = store.get_persona()["self_model"] or ""
        lines = [l for l in cur.split("\n") if l.strip()]
        lines.append(line)
        while len("\n".join(lines)) > 4000 and len(lines) > 1:
            lines.pop(0)
        new = "\n".join(lines)
        store.set_self_model(new)
        self._json(200, {"ok": True, "line": line, "chars": len(new)})

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
        # 兼容两种命名：插件发驼峰（userText），旧客户端发下划线（user_text）
        _u = body.get("user_text") or body.get("userText") or ""
        _a = body.get("assistant_text") or body.get("assistantText") or ""
        res = extractor.process_turn(
            user_text=str(_u),
            assistant_text=str(_a),
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
