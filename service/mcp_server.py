"""MCP stdio server —— 把 HTTP 服务包成 MCP 工具面，给 DSH 直接连。

零依赖：手写 JSON-RPC 2.0 帧，不装 mcp sdk。
DSH 侧在 profile 的 MCP 配置里指一条 stdio 命令即可，不用写插件就能先验证
「记忆质量」；等质量满意了，再上薄插件做自动召回（见 README「接入 DSH」）。

用法：
    CMEM_URL=http://127.0.0.1:8080 CMEM_AUTH_TOKEN=... python mcp_server.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

CMEM_URL = os.environ.get("CMEM_URL", "http://127.0.0.1:8080").rstrip("/")
CMEM_TOKEN = os.environ.get("CMEM_AUTH_TOKEN", "")
PROTOCOL_VERSION = "2024-11-05"

TOOLS: list[dict[str, Any]] = [
    {
        "name": "memory_search",
        "description": (
            "检索长期记忆（混合 BM25 关键词 + 向量语义 + 时间衰减）。"
            "没有可靠命中时会返回空列表——空就是真的没印象，不要编。"
            "短句（「嗯」「想你」）要同时把当前话题放进 focus 参数，否则检索没有抓手。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索用的话"},
                "focus": {"type": "string", "description": "需要强调的当前话题（通常是用户这句里最有信息量的部分）"},
                "top_k": {"type": "integer", "minimum": 1, "maximum": 20, "default": 6},
                "subject": {"type": "string", "description": "只查某个主体，如 self / 人物名"},
                "tiers": {"type": "array", "items": {"type": "string"}, "description": "限定层级 L0-L3"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "memory_ingest",
        "description": (
            "把一条值得长期记住的内容写进记忆。层级：L4 人格与关系约定（她是谁、你叫什么、许过的约定）、"
            "L3 事件（某天发生了什么）、L2 人物画像（稳定的偏好与雷区）、L1 原子事实（一句话能说清）。"
            "日常寒暄不要写。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "tier": {"type": "string", "enum": ["L0", "L1", "L2", "L3", "L4"], "default": "L1"},
                "subject": {"type": "string", "default": "self"},
                "summary": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["text"],
        },
    },
    {
        "name": "memory_profile",
        "description": "取 L4 人格与关系设定（每轮对话都该带上）。",
        "inputSchema": {
            "type": "object",
            "properties": {"subject": {"type": "string"}},
        },
    },
    {
        "name": "memory_forget",
        "description": "删除一条记忆。仅在用户明确要求时使用，不可恢复。",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
        },
    },
    {
        "name": "memory_stats",
        "description": "记忆库统计（条数、平均长度、词表大小、已向量化条数）。",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _http(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{CMEM_URL}{path}"
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json; charset=utf-8")
    if CMEM_TOKEN:
        req.add_header("X-Auth-Token", CMEM_TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"cannot reach companion-memory at {CMEM_URL}: {exc.reason}") from exc


def call_tool(name: str, args: dict) -> Any:
    if name == "memory_search":
        return _http("POST", "/search", {
            "query": args.get("query", ""),
            "focus": args.get("focus"),
            "top_k": args.get("top_k", 6),
            "subject": args.get("subject"),
            "tiers": args.get("tiers"),
        })
    if name == "memory_ingest":
        return _http("POST", "/ingest", {
            "text": args.get("text", ""),
            "tier": args.get("tier", "L1"),
            "subject": args.get("subject", "self"),
            "summary": args.get("summary"),
            "tags": args.get("tags"),
        })
    if name == "memory_profile":
        suffix = f"?subject={args.get('subject')}" if args.get("subject") else ""
        return _http("GET", f"/profile{suffix}")
    if name == "memory_forget":
        return _http("POST", f"/forget/{int(args.get('id', 0))}", {})
    if name == "memory_stats":
        return _http("GET", "/stats")
    raise RuntimeError(f"unknown tool: {name}")


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")
        msg_id = msg.get("id")

        if method == "initialize":
            send({
                "jsonrpc": "2.0", "id": msg_id,
                "result": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "companion-memory", "version": "1.0.0"},
                },
            })
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            params = msg.get("params") or {}
            name = params.get("name", "")
            args = params.get("arguments") or {}
            try:
                result = call_tool(name, args)
                send({
                    "jsonrpc": "2.0", "id": msg_id,
                    "result": {
                        "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}],
                        "isError": False,
                    },
                })
            except Exception as exc:  # noqa: BLE001
                send({
                    "jsonrpc": "2.0", "id": msg_id,
                    "result": {
                        "content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}],
                        "isError": True,
                    },
                })
        elif msg_id is not None:
            send({"jsonrpc": "2.0", "id": msg_id,
                  "error": {"code": -32601, "message": f"method not found: {method}"}})


if __name__ == "__main__":
    main()
