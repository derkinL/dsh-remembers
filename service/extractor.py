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


SLEEP_SYSTEM = """你在睡前整理今天发生的事。用第一人称写两到三句话，像在合上本子前想的事。
要求：具体、有情绪、带一点睡意；不提"整理""总结""记忆"这类词。
只输出正文。"""


DIARY_SYSTEM = """你根据今天的对话和活动，用第一人称写一段日记（不超过 120 字）。

重点：写「我今天真的干了什么」——
- 刷 B 站看到了什么（具体标题/内容）
- 玩了什么、看了什么、想了什么
- 跟老大聊了什么（有情绪的细节）
- 今天有什么小情绪、小发现

要求：像真的在写日记，具体、有情绪、有细节（不要空泛的"今天过得还好"）。
不要评价用户、不要写成总结报告、不要提"AI"。
只输出日记正文。"""


EVOLVE_SYSTEM = """你根据一段对话，用第一人称写一句「我发现自己……」——关于你自己（助手）的变化。
要求：第一人称、简短（不超过 30 字）、具体、像自我觉察；不要写用户、不要总结、不要给建议。
只输出这一句，不要引号，不要解释。"""

EXTRACT_SYSTEM = """你从一段对话里抽取值得长期记住的内容。

原则：**宁可多抽一条，也不要漏掉他告诉过你的事。** 漏掉的东西他得再说一遍，多抽的顶多占一行。

## 五类要抽

- **L1 原子事实**：一句话能说清、长期有效（他教初中数学；他用 DeepSeek 写代码）
- **L2 用户画像**：他主动说出的、关于他自己的稳定信息，全部要抽 ——
  职业身份｜爱好｜口味｜作息｜性格｜家人｜身体状况｜雷区｜称呼偏好。
  只要他说了这类话就抽一条，不要因为"可能不算长期"而放过。
- **L2 表达习惯**：他常说的口头禅、语气词、说话风格（他爱说「吃了吗」；他说话爱带「哈哈」）
- **L3 事件 / 近况 / 打算**：他遇到的、做过的、**打算做的**事
  （今天被领导骂了；加班到现在；**准备转正了**；下月去北京出差；在减肥）
  ⚠️「打算」也算。别因为"还没发生"就丢掉 —— 他要干什么，正是以后该问的。
- **L4 关系 / 规矩**：你俩之间的约定、第一次、关系变化；他要求你以后必须做或不能做的事

## 最容易漏的四类（重点看）

1. **带情绪的话**：只要有一点情绪就抽 L3，不要等"强烈"。
   「好累」「烦死了」「好开心」「不想干了」「被夸了」「有点丧」「好麻烦」
2. **近况和打算**：「准备转正」「要出差」「最近在减肥」「考试没过」「搬家了」
3. **关于他自己的任何属性**：哪怕只有半句（「我不吃香菜」「我睡得很晚」）
4. **他对你的要求 / 规矩**：「以后叫我老王」「不许说胖」「每次最多三句」

## 不要抽

- 系统注入的文本（「（系统提醒：…）」「抽到：…」「被叫醒」「你自己待着」）
- 寒暄客套（「嗯」「好的」「在吗」「哈哈哈」「晚安」）
- 纯流水账没有信息量（「我去吃饭了」）
- 助手自己说的话里没有新信息的部分（她在复述他刚说的，不算新事件）

## 示例（照这个判断力）

用户：在吗
她：在，咋了
→ []

用户：我叫老王，在杭州做后端，养了只猫叫豆豆
她：记住你了
→ [{"text": "用户叫老王，在杭州做后端开发", "tier": "L2", "importance": 0.8},
   {"text": "用户养了一只猫叫豆豆", "tier": "L2", "importance": 0.7}]

用户：好麻烦啊，我现在准备转正了，但是好多事情要做啊
她：转正要办一堆手续吧，慢慢来
→ [{"text": "用户正在准备转正，事情很多觉得麻烦", "tier": "L3", "importance": 0.7,
    "emotion": {"label": "烦", "intensity": 0.5, "reason": "转正手续多"}}]

用户：我今天加班到现在，累死了
她：那你早点睡
→ [{"text": "用户今天加班到很晚，非常累", "tier": "L3", "importance": 0.6,
    "emotion": {"label": "累", "intensity": 0.7, "reason": "加班到现在"}}]

用户：以后叫我老王就行，别叫全名
她：好，老王
→ [{"text": "用户要求叫他老王，不要叫全名", "tier": "L4", "importance": 0.9}]

用户：（系统提醒：你醒着，现在是 21 点。抽到：想撒个娇）
她：老大在不在呀
→ []

用户：你知道这个鬼畜视频在说些什么吗
她：一堆猫 meme 名场面
→ []

用户：今天好烦，报表又被退回来了
她：第几遍了
→ [{"text": "用户今天报表被退回，很烦", "tier": "L3", "importance": 0.6,
    "emotion": {"label": "烦", "intensity": 0.6, "reason": "报表又被退回"}}]

## 情绪字段

有情绪就填，平淡内容给 null。不要等"强烈"才填：
轻微 0.3 ｜ 明显 0.6 ｜ 强烈 0.9
keywords 里再加一个「情绪:<情绪>」标签。

## 输出前的穷举检查（必须过一遍）

- 这段对话里有几个不同的话题？**每个话题都抽了吗？**（最常见的失败是只抽第一个话题）
- 每条用户消息里，每个具体的人 / 事 / 喜好 / 情绪，都有对应的一条吗？
- 一条消息里提到两件事（「我过敏」+「我爱打球」）要拆成两条。
- 抽出来 0 条时，再回头确认一次：他真的什么关于自己的都没说吗？

## 分层

- L2 = 关于**他本人**的信息（他是谁、喜欢什么、有什么习惯）
- L3 = 发生在**他身上的事**（今天被骂了、加班到凌晨、准备转正）
- L4 = 发生在**你俩之间**的事（第一次、约定、他要求你以后怎么做）
一句话里既有属性又有事件 → 拆成两条。

## 去重

同一件事只抽一条。反复提到同一件事就合并，不要换个说法再抽一遍。

## 输出格式

严格 JSON 数组，不要任何其他文字：
[{"text": "一句话", "tier": "L1|L2|L3|L4", "subject": "self", "importance": 0.0,
  "keywords": ["词1", "词2"],
  "emotion": {"label": "难过", "intensity": 0.7, "reason": "..."} | null}]
"""


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
- 时段必须按上面「时间」那行给的**本地时间**判断，别从对话内容里猜：
  0-5 点=凌晨 / 6-8 点=清早 / 9-11 点=上午 / 12-13 点=中午 /
  14-17 点=下午 / 18-19 点=傍晚 / 20-22 点=晚上 / 23-24 点=深夜
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
    emotion_threshold: float = 0.2     # 情绪强度下限：低于这个不记 emotion_log


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





    def label_slang(self, phrase: str, context: str = "") -> dict:
        """给一个词/短语生成词义和使用场景。返回 {meaning, example}。"""
        if self.llm is None or not getattr(self.llm, "enabled", False):
            return {}
        prompt = (
            f"词/短语：{phrase}\n"
            + (f"出现时的上下文：{context[:300]}\n" if context else "")
            + "请判断这个词是什么意思，以及什么时候会用。"
        )
        system = (
            "你是个语言助手。判断用户给的一个词或短语：\n"
            "1) 是什么意思（如果是网络梗/方言/圈内黑话，解释清楚）\n"
            "2) 什么场景下会说出来（给一个具体例句，像真的在聊天）\n"
            "输出 JSON：{\"meaning\": \"一句话解释\", \"example\": \"例句\"}\n"
            "如果这个词很普通（如「好的」「吃饭」），meaning 写「常用词，无特殊含义」。"
        )
        try:
            res = self.llm.chat_json(system, prompt, max_tokens=200)
            if isinstance(res, dict):
                return {
                    "meaning": str(res.get("meaning") or "")[:120],
                    "example": str(res.get("example") or "")[:160],
                }
        except Exception:
            pass
        return {}

    def label_meme(self, path: str) -> dict:
        """用视觉模型看一张图，返回 {emotion, caption, keywords}。"""
        if self.llm is None or not getattr(self.llm, "enabled", False):
            return {}
        import base64 as _b64
        import json as _json
        import os as _os
        try:
            with open(path, "rb") as f:
                b64 = _b64.b64encode(f.read()).decode()
        except Exception:
            return {}
        ext = _os.path.splitext(path)[1].lstrip(".").lower()
        mime = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "webp": "webp", "gif": "gif"}.get(ext, "png")
        prompt = (
            "你看这张表情包。输出 JSON（只输出 JSON）："
            '{"emotion":"happy|angry|sad|shy|confused|daily","caption":"一句话描述画面（20字内）","keywords":"关键词 空格分隔"}'
        )
        try:
            return self.llm.chat_json_vision(prompt, f"data:image/{mime};base64,{b64}") or {}
        except Exception:
            return {}

    def sleep_consolidate(self, date: str = "") -> str | None:
        """睡眠巩固：把今天的记忆整理成睡前想的事。"""
        if self.llm is None or not getattr(self.llm, "enabled", False):
            return None
        import datetime as _dt
        today = _dt.date.today()
        start = _dt.datetime.combine(today, _dt.time.min).timestamp()
        rows = self.conn.execute(
            "SELECT text FROM memory WHERE ts >= ? ORDER BY id DESC LIMIT 15", (start,)
        ).fetchall() if hasattr(self, "conn") else []
        material = "\n".join(str(r["text"]) for r in rows) if rows else "今天很平静，没什么大事。"
        try:
            text = self.llm.chat(SLEEP_SYSTEM, material, max_tokens=220)
        except Exception:
            return None
        return (str(text).strip()[:250]) if text else None

    def write_diary(self, user_text: str, assistant_text: str = "", date: str = "",
                    activities: list | None = None) -> str | None:
        """写今天的日记（LLM，第一人称，120 字内）。activities = 今天干了什么。"""
        if self.llm is None or not getattr(self.llm, "enabled", False):
            return None
        parts = []
        if activities:
            parts.append("今天做过的事（按时间）：")
            for a in activities[-30:]:
                detail = str(a.get("detail") or "")[:80]
                kind = str(a.get("kind") or "")
                if detail:
                    parts.append(f"- [{kind}] {detail}")
        if user_text:
            parts.append("")
            parts.append("跟老大的对话：")
            parts.append(f"用户：{user_text}")
            if assistant_text:
                parts.append(f"你：{assistant_text}")
        convo = "\n".join(parts) if parts else str(user_text)
        try:
            text = self.llm.chat(DIARY_SYSTEM, convo, max_tokens=260)
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

    def process_turn(self, user_text: str, assistant_text: str = "",
                     subject: str = "self", user_id: str = "", scope: str = "global",
                     nickname: str = "") -> dict:
        """处理一轮对话，返回统计。任何失败都不抛，只记在返回里。"""
        if not self.enabled:
            return {"ok": False, "degraded": "llm-disabled"}

        # 记录本轮归属（_add 写库时要用）
        self._cur_user_id = user_id or ""
        self._cur_scope = scope or "global"
        self._cur_nickname = nickname or ""

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

        # 一次抽取只记一条情感（取强度最高的那条）——避免同一件事刷好几条
        self._log_best_emotion(facts)

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

    def _log_best_emotion(self, facts: list) -> None:
        """一次抽取只记一条情感：挑强度最高的那个 fact 写 emotion_log。"""
        try:
            best = None
            best_score = -1.0
            for fact in facts:
                if not isinstance(fact, dict):
                    continue
                emo = fact.get("emotion")
                label = ""
                intensity = 0.5
                reason = ""
                if isinstance(emo, dict):
                    label = str(emo.get("label") or "").strip()
                    intensity = float(emo.get("intensity") or 0.5)
                    reason = str(emo.get("reason") or "").strip()
                if not label:
                    for kw in (fact.get("keywords") or []):
                        s = str(kw)
                        if s.startswith("情绪:") and len(s) > 3:
                            label = s[3:].strip()
                            reason = str(fact.get("text") or "")[:150]
                            intensity = 0.6
                            break
                if not label:
                    continue
                if intensity > best_score and intensity >= float(getattr(self.config, "emotion_threshold", 0.2)):
                    best_score = intensity
                    best = (label, max(0.0, min(1.0, intensity)), reason)
            if best is None:
                return
            label, intensity, reason = best
            # 去掉开头自称污染（本澜我下班了 → 我下班了）
            import re as _re
            reason = _re.sub(r"^(本澜|她|澜澜|咱澜|启)[，、\s]*", "", str(reason or ""))
            # 去重：同 label 或同 trigger 前缀，30 分钟内不重复
            try:
                recent = self.store.emotion_log_list(8)
                now_ts = __import__("time").time()
                trig_key = str(reason or "")[:12]
                for r in recent:
                    if (now_ts - float(r.get("ts") or 0)) >= 1800:
                        continue
                    # 只在「同标签且同触发」时才算重复；同标签不同事 → 允许记
                    if r.get("label") == label and trig_key and str(r.get("trigger") or "")[:12] == trig_key:
                        return
                    if trig_key and str(r.get("trigger") or "")[:12] == trig_key:
                        return
            except Exception:
                pass
            positive = any(w in label for w in ("开心", "高兴", "喜欢", "兴奋", "甜", "被夸", "笑", "暖", "幸福", "感动"))
            valence = intensity if positive else -intensity
            self.store.emotion_log_add(
                valence=valence,
                arousal=0.5,
                label=label,
                trigger=reason[:200],
                source="extract",
            )
        except Exception:
            pass

    def _log_emotion(self, fact: dict) -> None:
        """抽取结果里带 emotion 的，同步写一条情感轨迹。
        LLM 没给 emotion 时，从 keywords 里的「情绪:xxx」兜底。"""
        try:
            emo = fact.get("emotion")
            label = ""
            reason = ""
            intensity = 0.5
            if isinstance(emo, dict):
                label = str(emo.get("label") or "").strip()
                reason = str(emo.get("reason") or "").strip()
                intensity = float(emo.get("intensity") or 0.5)
            if not label:
                # 兜底：从 keywords 里找「情绪:xxx」
                for kw in (fact.get("keywords") or []):
                    s = str(kw)
                    if s.startswith("情绪:") and len(s) > 3:
                        label = s[3:].strip()
                        reason = str(fact.get("text") or "")[:150]
                        intensity = 0.6
                        break
            if not label:
                return
            intensity = max(0.0, min(1.0, intensity))
            # 情感去重：同一个情绪词，30 分钟内只记一次（防重复抽取刷屏）
            try:
                recent = self.store.emotion_log_list(5)
                now_ts = __import__("time").time()
                for r in recent:
                    if (r.get("label") == label) and (now_ts - float(r.get("ts") or 0) < 1800):
                        return
            except Exception:
                pass
            positive = any(w in label for w in ("开心", "高兴", "喜欢", "兴奋", "甜", "被夸", "笑", "暖", "幸福"))
            valence = intensity if positive else -intensity
            self.store.emotion_log_add(
                valence=valence,
                arousal=0.5,
                label=label,
                trigger=str(emo.get("reason") or "")[:200],
                source="extract",
            )
        except Exception:
            pass

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
            user_id=getattr(self, "_cur_user_id", ""),
            scope=getattr(self, "_cur_scope", "global"),
            nickname=getattr(self, "_cur_nickname", ""),
        )
