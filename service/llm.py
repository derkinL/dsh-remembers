"""外部 LLM 客户端（OpenAI 兼容 /chat/completions）。

只用于两件事：抽取事实、判定 ADD/UPDATE/DELETE。和 embedding 一样，
失败即降级——LLM 挂了不影响检索，也不影响对话。
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request


class LLM:
    def __init__(
        self,
        base_url: str = "",
        api_key: str = "",
        model: str = "",
        timeout: float = 60.0,
        temperature: float = 0.0,
    ):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.model = model or ""
        self.timeout = timeout
        self.temperature = temperature
        self._lock = threading.Lock()
        self.last_error: str | None = None
        self.calls = 0
        self.failures = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.model)

    def chat(self, system: str, user: str, max_tokens: int = 1200) -> str | None:
        """返回文本；任何失败都返回 None，调用方自己决定降级。"""
        if not self.enabled:
            return None
        payload = json.dumps({
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(f"{self.base_url}/chat/completions", data=payload, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        if self.api_key:
            req.add_header("Authorization", f"Bearer {self.api_key}")

        with self._lock:
            self.calls += 1
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            with self._lock:
                self.failures += 1
                self.last_error = f"HTTP {exc.code}: {detail}"
            return None
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self.failures += 1
                self.last_error = f"{type(exc).__name__}: {exc}"
            return None

        usage = body.get("usage") or {}
        with self._lock:
            self.prompt_tokens += int(usage.get("prompt_tokens") or 0)
            self.completion_tokens += int(usage.get("completion_tokens") or 0)

        choices = body.get("choices") or []
        if not choices:
            return None
        message = choices[0].get("message") or {}
        content = message.get("content")
        return content.strip() if isinstance(content, str) and content.strip() else None

    def chat_json(self, system: str, user: str, max_tokens: int = 1200):
        """要求返回 JSON，失败或解析不出来都返回 None。"""
        text = self.chat(system, user, max_tokens=max_tokens)
        if not text:
            return None
        return _extract_json(text)

    def health(self) -> dict:
        return {
            "enabled": self.enabled,
            "model": self.model or None,
            "calls": self.calls,
            "failures": self.failures,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "last_error": self.last_error,
        }


def _extract_json(text: str):
    """从可能带 ```json 围栏或前后废话的输出里挖出 JSON。"""
    s = text.strip()
    if s.startswith("```"):
        first_newline = s.find("\n")
        if first_newline != -1:
            s = s[first_newline + 1:]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    s = s.strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    for opener, closer in (("[", "]"), ("{", "}")):
        start = s.find(opener)
        end = s.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(s[start:end + 1])
            except json.JSONDecodeError:
                continue
    return None
