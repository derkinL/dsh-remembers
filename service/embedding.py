"""外部 embedding 客户端（OpenAI 兼容 /embeddings）。

设计原则：embedding 是「锦上添花」，不是生命线。
外部 API 挂掉、超时、限流时返回 None，调用方跳过向量、BM25 照常工作。
绝不让一次网络故障把整条记忆写入或检索拖死。
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import urllib.error
import urllib.request
from typing import Sequence


class Embedder:
    def __init__(
        self,
        base_url: str = "",
        api_key: str = "",
        model: str = "",
        timeout: float = 20.0,
        batch_size: int = 16,
        cache_size: int = 4096,
    ):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.model = model or ""
        self.timeout = timeout
        self.batch_size = max(1, batch_size)
        self._cache: dict[str, list[float]] = {}
        self._cache_size = cache_size
        self._lock = threading.Lock()
        self.last_error: str | None = None
        self.calls = 0
        self.failures = 0

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.model)

    # -- 对外 ---------------------------------------------------------------

    def embed(self, texts: Sequence[str]) -> list[list[float] | None]:
        """返回与输入等长的列表；失败的条目是 None。"""
        if not self.enabled or not texts:
            return [None] * len(texts)

        out: list[list[float] | None] = [None] * len(texts)
        pending: list[tuple[int, str]] = []
        for i, text in enumerate(texts):
            key = self._key(text)
            with self._lock:
                hit = self._cache.get(key)
            if hit is not None:
                out[i] = hit
            else:
                pending.append((i, text))

        for start in range(0, len(pending), self.batch_size):
            chunk = pending[start:start + self.batch_size]
            try:
                vecs = self._request([t for _, t in chunk])
            except Exception as exc:  # noqa: BLE001 - 任何异常都降级
                self.failures += 1
                self.last_error = f"{type(exc).__name__}: {exc}"
                continue
            for (idx, text), vec in zip(chunk, vecs):
                if vec is None:
                    continue
                out[idx] = vec
                self._remember(self._key(text), vec)
        return out

    def embed_one(self, text: str) -> list[float] | None:
        return self.embed([text])[0]

    def health(self) -> dict:
        return {
            "enabled": self.enabled,
            "model": self.model or None,
            "calls": self.calls,
            "failures": self.failures,
            "last_error": self.last_error,
            "cached": len(self._cache),
        }

    # -- 内部 ---------------------------------------------------------------

    def _key(self, text: str) -> str:
        return hashlib.sha256(f"{self.model}\x00{text}".encode("utf-8")).hexdigest()

    def _remember(self, key: str, vec: list[float]) -> None:
        with self._lock:
            if len(self._cache) >= self._cache_size:
                # 简单 FIFO 淘汰，够用；不做 LRU 是为了省依赖
                for old in list(self._cache)[: self._cache_size // 4]:
                    self._cache.pop(old, None)
            self._cache[key] = vec

    def _request(self, texts: list[str]) -> list[list[float] | None]:
        url = f"{self.base_url}/embeddings"
        payload = json.dumps({"model": self.model, "input": texts}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=payload, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        if self.api_key:
            req.add_header("Authorization", f"Bearer {self.api_key}")
        self.calls += 1
        started = time.time()
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        _ = started
        data = body.get("data") or []
        if not isinstance(data, list) or len(data) != len(texts):
            raise ValueError(f"unexpected embeddings payload: keys={list(body)} n={len(data)}")
        vecs: list[list[float] | None] = [None] * len(texts)
        for item in data:
            idx = int(item.get("index", 0))
            emb = item.get("embedding")
            if isinstance(emb, list) and emb and 0 <= idx < len(vecs):
                vecs[idx] = [float(x) for x in emb]
        return vecs
