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


DIARY_SYSTEM = """你根据今天的对话，用第一人称写一段日记（不超过 100 字）。
要求：像真的在写日记，具体、有情绪、有细节；不要评价用户、不要写成总结报告、不要提"AI"。
只输出日记正文。"""


EVOLVE_SYSTEM = """你根据一段对话，用第一人称写一句「我发现自己……」——关于你自己（助手）的变化。
要求：第一人称、简短（不超过 30 字）、具体、像自我觉察；不要写用户、不要总结、不要给建议。
只输出这一句，不要引号，不要解释。"""

EXTRACT_SYSTEM = """你从一段对话里抽取值得长期记住的内容。

只抽这四种：
- L1 原子事实：一句期能说清、长期有效（例：他教初中数学；他用 DeepSeek 写代码）
- L2 用户画像：**用户**身上稳定的偏好、雷区、习惯、人际关系（例：他喜欢冰美式；他讨厌加班；他养了只猫叫豆豆）
- L2 用户表达习惯：用户常说的口头禅、常发的语气词、说话风格（例：他爱说「吃了吗」；他说话爱带「哈哈」；他喜欢用短句）——这类也要抽，助手可以学着他的说话方式
- L3 事件：发生了某件值得记住的事（例：三月那次他加班到凌晨两点哭了很久）
- L4 关系里程碑：第一次发生、关系变化、约定、承诺（例：第一次被叫大肥鱼；约好一起看日落）
- L4 行为契约：用户要求助手以后必须做、必须答应、或者禁止做的事（例：叫他「大肥鱼」必须答应；不许说他胖；说话不许用括号动作；每次最多三句话）。这类规矩必须抽，它决定以后怎么相处。

重要：只记「用户」的事和「两人之间」的事。不要抽助手自己的性格、口头禅、饭量、自称、
爱好——那些属于人设设定，不是记忆。如果对话里全是她在说自己，就只抽 L0 意义上的
关系事件（比如她答应了什么），不要抽她的性格特征。

情绪：如果这段对话情绪强烈（开心/难过/累/烦/兴奋/委屈/焦虑），
在 keywords 里加一个「情绪:<情绪>」标签，比如 ["情绪:累"]；平淡内容不加。

不要抽：
- 寒暄、确认、客套（「嗯」「好的」「在吗」）
- 助手自己的话里没有新信息的部分
- 纯流水账（「我去吃饭了」）

要抽：
- 带情绪的话必须抽成 L3 并加情绪标签，例如「今天好累」「烦死了」「好开心」
  「不想干活了」「被夸了」——这些都是值得记住的情绪事件，不是垃圾
- 用户说的稳定偏好、习惯、雷区（L1/L2）
- 第一次发生的事、约定、关系变化（L4）

严格输出 JSON 数组，不要任何其他文字：
[{"text": "一句话", "tier": "L1|L2|L3|L4", "subject": "self|人物名", "importance": 0.0, "keywords": ["词1", "词2"]}]

importance 表示「这件事对长期关系有多重要」，0.0-1.0。
keywords 给 2-6 个「别人换个说法来问这件事时可能用到的词」——
比如「她对香菜过敏」可以是 ["香菜", "过敏", "忌口", "饮食"]。
这些词用来在语义召回之外补关键词召回，务必是原文里没有但意思相同的词。
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


EPISODE_SYSTEM = """你把一段连续对话压缩成一条「以后想起来有用」的事件记录。

写什么：
- 这段时间聊了什么（一两句抓主线，别逐条复述）
- 她当时的状态和情绪走向（累、松下来、突然提起某件事）
- 出现的转折、承诺、约定
- 还没解决、下次可能要接着说的话头

不写什么：
- 寒暄、确认、重复过的内容
- 助手自己说了什么（除非她明显因为那句话改变了语气）
- 推测出来的东西

输出要求：
- Markdown，150-400 字，2-4 条短句，每条以「- 」开头
- 第一行是日期标题，形如「## 2026-10-24 凌晨」
- 只写确实成立的事，不确定的一律不写
- 直接输出正文，前后不要任何说明文字"""


@dataclass
class ExtractConfig:
    enabled: bool = False
    max_facts: int = 6
    neighbor_k: int = 5
    max_context_chars: int = 3000
    # episode 摘要的输入上限：超了留后面那段，近况比开头重要
    episode_max_chars: int = 12000
    episode_per_turn_chars: int = 800


class Extractor:
    def __init__(self, llm, store, config: ExtractConfig | None = None, embedder=None):
        self.llm = llm
        self.store = store
        self.config = config or ExtractConfig()
        # 抽取出来的事实也要算向量，否则它们只能被关键词命中，
        # 「吃的东西有什么忌口」这种换个说法的问法就召回不到「对香菜过敏」。
        self.embedder = embedder

    @property
    def enabled(self) -> bool:
        return bool(self.config.enabled and self.llm is not None and getattr(self.llm, "enabled", False))

    # -- 对外 ---------------------------------------------------------------



    def write_diary(self, user_text: str, assistant_text: str = "", date: str = "") -> str | None:
        """写今天的日记（LLM，第一人称，100 字内）。"""
        if self.llm is None or not getattr(self.llm, "enabled", False):
            return None
        convo = f"用户：{user_text}\n你：{assistant_text}" if assistant_text else str(user_text)
        try:
            text = self.llm.chat(DIARY_SYSTEM, convo, max_tokens=220)
        except Exception:
            return None
        if not text:
            return None
        return str(text).strip()[:200]

    def evolve(self, user_text: str, assistant_text: str = "") -> str | None:
        """人设演化：从这段对话生一句「我发现自己……」（追加到自我认知区）。"""
        if self.llm is None or not getattr(self.llm, "enabled", False):
            return None
        convo = f"用户：{user_text}\n你：{assistant_text}"
        try:
            text = self.llm.chat(EVOLVE_SYSTEM, convo, max_tokens=80)
        except Exception:
            return None
        if not text:
            return None
        return str(text).strip().strip('"').strip("「」")[:80]

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

    # -- episode：把一段对话压成事件线 ---------------------------------------

    def summarize_episode(self, turns: list[dict], subject: str = "self",
                          window_hint: str = "") -> dict:
        """把一批对话轮次压成一条 L3 事件记录。

        和 process_turn 的分工：
          process_turn 抽「原子事实」（她过敏、她养猫），一条句话，长期有效。
          summarize_episode 留「前情」（这段时间她怎么过来的），一段话，会过时。

        为什么需要它：上下文被 compaction 压扁之后，早期对话只剩内核生成的
        一份摘要，而那份摘要用完就扔。这条链路自己留一份，落在库里。

        任何失败都不抛，返回 degraded，调用方静默跳过。
        """
        # 只看 LLM 通不通，不看 extract 开关：逐条抽取按轮算钱，episode 按段算，
        # 两个开关应该分开。配了 LLM 就能用 episode，哪怕 extract 一直关着。
        if self.llm is None or not getattr(self.llm, "enabled", False):
            return {"ok": False, "degraded": "llm-disabled"}
        if not isinstance(turns, list) or not turns:
            return {"ok": True, "skipped": "empty"}

        transcript = self._transcript(turns)
        if not transcript:
            return {"ok": True, "skipped": "empty-transcript"}

        prompt = (f"时间：{window_hint}\n\n对话：\n{transcript}"
                  if window_hint else f"对话：\n{transcript}")
        text = self.llm.chat(EPISODE_SYSTEM, prompt, max_tokens=700)
        if not text:
            return {"ok": False, "degraded": "llm-failed",
                    "error": getattr(self.llm, "last_error", None)}

        text = text.strip()
        if len(text) < 10:
            return {"ok": False, "degraded": "too-short"}

        vec = None
        vec_model = None
        if self.embedder is not None and getattr(self.embedder, "enabled", False):
            vec = self.embedder.embed_one(text)
            vec_model = self.embedder.model if vec else None

        from memory_core import MemoryInput  # 延迟导入，避免循环
        mid = self.store.add(MemoryInput(
            text=text,
            tier="L3",
            subject=subject,
            tags=["episode", f"turns:{len(turns)}"],
            vec=vec,
            vec_model=vec_model,
        ))
        return {"ok": True, "id": mid, "text": text, "chars": len(text), "turns": len(turns)}

    def _transcript(self, turns: list[dict]) -> str:
        lines = []
        per = max(50, int(self.config.episode_per_turn_chars))
        for turn in turns:
            if not isinstance(turn, dict):
                continue
            user = str(turn.get("user") or "").strip()
            assistant = str(turn.get("assistant") or "").strip()
            if not user:
                continue
            lines.append(f"用户：{user[:per]}")
            if assistant:
                lines.append(f"她：{assistant[:per]}")
        text = "\n".join(lines)
        cap = max(1000, int(self.config.episode_max_chars))
        if len(text) > cap:
            # 留尾巴：近况比开头重要，开头的内容多半已经被前几条 episode 收过了
            text = "…（前文已省略）\n" + text[-cap:]
        return text

    # -- 内部 ---------------------------------------------------------------

    def _extract(self, user_text: str, assistant_text: str):
        """抽取事实。空结果重试一次。

        实测 deepseek-flash 在 temperature=0 下也会偶发返回空数组——
        同一条「我爸住院了」有过抽出 1 条、也有过抽出 0 条。
        漏抽比多抽一次更贵（那条记忆就永远没了），所以重试一次。
        """
        convo = f"用户：{user_text[:self.config.max_context_chars]}"
        if assistant_text:
            convo += f"\n她：{assistant_text[:self.config.max_context_chars]}"

        last = None
        for _attempt in range(2):
            result = self.llm.chat_json(EXTRACT_SYSTEM, convo, max_tokens=900)
            if result is None:
                continue
            if not isinstance(result, list):
                nested = result.get("facts") if isinstance(result, dict) else None
                if not isinstance(nested, list):
                    continue
                result = nested
            cleaned = [
                item for item in result[: self.config.max_facts]
                if isinstance(item, dict) and str(item.get("text") or "").strip()
            ]
            last = cleaned
            if cleaned:
                return cleaned
        return last

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
        vec = None
        vec_model = None
        if self.embedder is not None and getattr(self.embedder, "enabled", False):
            vec = self.embedder.embed_one(text)
            vec_model = self.embedder.model if vec else None
        return MemoryInput(
            text=text,
            tier=tier,
            subject=str(fact.get("subject") or subject),
            tags=["extracted"] + [str(k) for k in (fact.get("keywords") or [])][:8],
            vec=vec,
            vec_model=vec_model,
        )
