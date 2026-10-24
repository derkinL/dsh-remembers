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


    def chat_json_vision(self, prompt: str, image_data_url: str, max_tokens: int = 300):
        """带图片的 JSON 调用（OpenAI 兼容 image_url 格式）。"""
        if not self.enabled:
            return None
        payload = {
            "model": self.model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            }],
            "max_tokens": max_tokens,
            "temperature": 0.2,
        }
        import json as _json
        import urllib.request as _ur
        req = _ur.Request(
            self.base_url.rstrip("/") + "/chat/completions",
            data=_json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.api_key},
            method="POST",
        )
        try:
            with _ur.urlopen(req, timeout=60) as r:
                res = _json.loads(r.read())
            text = res["choices"][0]["message"]["content"].strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text
                text = text.rsplit("```", 1)[0]
            return _json.loads(text)
        except Exception:
            return None

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
    """从 LLM 输出里挖出第一个合法的 JSON 值。

    实测 deepseek-flash 会这样返回（temperature=0 也一样）：
        [{"op":"ADD",...}]
        <一段解释>
        ```json
        [{"op":"ADD",...}]
        ```
    所以不能用「找第一个 [ 到最后一个 ]」——那样会把两段拼在一起。
    正确做法是从每个 `[`/`{` 位置尝试 raw_decode，取第一个能完整解析的。
    """
    s = (text or "").strip()
    if not s:
        return None

    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    # 去掉 markdown 围栏后整体再试一次
    if "```" in s:
        start = s.find("```")
        line_end = s.find("\n", start)
        if line_end != -1:
            close = s.find("```", line_end + 1)
            if close != -1:
                try:
                    return json.loads(s[line_end + 1:close].strip())
                except json.JSONDecodeError:
                    pass

    # 逐位置扫描：第一个能完整解析出来的 JSON 值就是答案
    decoder = json.JSONDecoder()
    for i, ch in enumerate(s):
        if ch in "[{":
            try:
                obj, _end = decoder.raw_decode(s, i)
                return obj
            except json.JSONDecodeError:
                continue
    return None
