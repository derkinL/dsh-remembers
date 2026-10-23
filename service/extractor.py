"""LLM 逐条判定：抽取事实 → 和已有记忆对比 → ADD / UPDATE / DELETE / NONE。

思路来自 mem0（67.7k★）的 DEFAULT_UPDATE_MEMORY_PROMPT：不是无脑存，
而是拿新事实和库里已有的记忆逐条比对，决定加、改、删、还是什么都不做。

两个 LLM 调用：
  1. 抽取：从这一轮对话里抽出值得长期记住的事实
  2. 判定：每条事实 vs 最相似的 5 条已有记忆 → 选操作

LLM 不可用时整条链路让路：返回 degraded，调用方退回到"直接存原话"。
"""

from __future__ import annotations

import json
from dataclasses import dataclass

EXTRACT_SYSTEM = """你从一段对话里抽取值得长期记住的事实。

只抽这三种：
- L1 原子事实：一句话能说清、长期有效（例：她对香菜过敏）
- L2 人物画像：稳定的偏好、雷区、人物关系（例：她怕黑；豆豆是她的猫）
- L3 事件：发生了某件值得记住的事（例：三月那次她加班到凌晨两点哭了很久）

不要抽：
- 寒暄、确认、客套
- 一次性状态（今天有点忙）
- 助手自己的话里没有新信息的部分

严格输出 JSON 数组，不要任何其他文字：
[{"text": "一句话", "tier": "L1|L2|L3", "subject": "self|人物名", "importance": 0.0}]

importance 表示「这件事对长期关系有多重要」，0.0-1.0。
没有值得记的就输出 []。"""

DECIDE_SYSTEM = """你在管理一个记忆库。下面是「新事实」和「这些事实最相似的已有记忆」。

对每条新事实，从四种操作里选一个：
- ADD：新信息，库里没有
- UPDATE：替代某条已有记忆（给 target_id 和合并后的完整 text）
- DELETE：与已有记忆矛盾且旧的应作废（给 target_id）
- NONE：已经存在、只是换个说法，或没有长期价值

规则：
1. 矛盾时优先 UPDATE —— 保留时间演进，别把历史删掉
2. 只有明确作废（"我不再怕黑了"）才 DELETE
3. 同一件事换个说法 → NONE
4. 更具体的新信息 → UPDATE 成更完整的版本

严格输出 JSON 数组：
[{"fact_index": 0, "op": "ADD|UPDATE|DELETE|NONE", "target_id": 123, "text": "合并后的完整文本", "reason": "一句话理由"}]"""


@dataclass
class ExtractConfig:
    enabled: bool = False
    max_facts: int = 6
    neighbor_k: int = 5
    max_context_chars: int = 3000


class Extractor:
    def __init__(self, llm, store, config: ExtractConfig | None = None):
        self.llm = llm
        self.store = store
        self.config = config or ExtractConfig()

    @property
    def enabled(self) -> bool:
        return bool(self.config.enabled and self.llm is not None and getattr(self.llm, "enabled", False))

    # -- 对外 ---------------------------------------------------------------

    def process_turn(self, user_text: str, assistant_text: str = "", subject: str = "self") -> dict:
        """处理一轮对话，返回统计。任何失败都不抛，只记在返回里。"""
        if not self.enabled:
            return {"ok": False, "degraded": "llm-disabled"}

        user_text = (user_text or "").strip()
        if len(user_text) < 2:
            return {"ok": True, "facts": 0, "applied": {}, "note": "user text too short"}

        facts = self._extract(user_text, assistant_text)
        if facts is None:
            return {"ok": False, "degraded": "extract-failed",
                    "error": getattr(self.llm, "last_error", None)}
        if not facts:
            return {"ok": True, "facts": 0, "applied": {"add": 0, "update": 0, "delete": 0, "none": 0}}

        applied = {"add": 0, "update": 0, "delete": 0, "none": 0}
        details = []

        for idx, fact in enumerate(facts):
            text = str(fact.get("text") or "").strip()
            if not text:
                continue
            neighbors = self.store.candidates(text, top_k=self.config.neighbor_k, subject=subject)
            decision = self._decide(fact, idx, neighbors)
            if decision is None:
                # 判定失败时保守处理：直接 ADD，不乱改已有记忆
                decision = {"op": "ADD", "reason": "decide-failed-fallback-add"}

            op = str(decision.get("op") or "ADD").upper()
            if op == "ADD":
                self.store.add(self._to_input(fact, text, subject))
                applied["add"] += 1
            elif op == "UPDATE":
                target = self._target(decision, neighbors)
                if target is None:
                    self.store.add(self._to_input(fact, text, subject))
                    applied["add"] += 1
                    op = "ADD(no-target)"
                else:
                    new_text = str(decision.get("text") or text).strip() or text
                    self.store.update_text(target.id, new_text)
                    applied["update"] += 1
            elif op == "DELETE":
                target = self._target(decision, neighbors)
                if target is None:
                    applied["none"] += 1
                    op = "NONE(no-target)"
                else:
                    self.store.forget(target.id)
                    applied["delete"] += 1
                    # 删掉之后把新事实作为"更正"存一条，不丢信息
                    self.store.add(self._to_input(fact, text, subject))
                    applied["add"] += 1
            else:
                applied["none"] += 1
                op = "NONE"

            details.append({"fact": text[:60], "op": op, "reason": decision.get("reason")})

        return {"ok": True, "facts": len(facts), "applied": applied, "details": details}

    # -- 内部 ---------------------------------------------------------------

    def _extract(self, user_text: str, assistant_text: str):
        convo = f"用户：{user_text[:self.config.max_context_chars]}"
        if assistant_text:
            convo += f"\n她：{assistant_text[:self.config.max_context_chars]}"
        result = self.llm.chat_json(EXTRACT_SYSTEM, convo, max_tokens=900)
        if result is None:
            return None
        if not isinstance(result, list):
            result = result.get("facts") if isinstance(result, dict) else None
            if not isinstance(result, list):
                return None
        cleaned = []
        for item in result[: self.config.max_facts]:
            if isinstance(item, dict) and str(item.get("text") or "").strip():
                cleaned.append(item)
        return cleaned

    def _decide(self, fact: dict, index: int, neighbors):
        if not neighbors:
            return {"op": "ADD", "reason": "no similar memory"}
        existing = [
            {"id": h.id, "tier": h.tier, "text": h.text, "ts": int(h.ts), "score": round(h.score, 3)}
            for h in neighbors
        ]
        payload = json.dumps({
            "new_facts": [{"fact_index": index, "text": fact.get("text"),
                           "tier": fact.get("tier"), "importance": fact.get("importance")}],
            "existing_memories": existing,
        }, ensure_ascii=False)
        result = self.llm.chat_json(DECIDE_SYSTEM, payload, max_tokens=700)
        if isinstance(result, list) and result:
            first = result[0]
            if isinstance(first, dict) and first.get("op"):
                return first
        if isinstance(result, dict) and result.get("op"):
            return result
        return None

    def _target(self, decision: dict, neighbors):
        tid = decision.get("target_id")
        try:
            tid = int(tid)
        except (TypeError, ValueError):
            return None
        for h in neighbors:
            if h.id == tid:
                return h
        return None

    def _to_input(self, fact: dict, text: str, subject: str):
        from memory_core import MemoryInput  # 延迟导入，避免循环
        tier = str(fact.get("tier") or "L1").upper()
        if tier not in {"L0", "L1", "L2", "L3", "L4"}:
            tier = "L1"
        return MemoryInput(
            text=text,
            tier=tier,
            subject=str(fact.get("subject") or subject),
            tags=["extracted"],
        )
