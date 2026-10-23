"""惊讶度门控：只把「出乎意料」的东西写进 L0。

依据：大脑按预测编码工作，只把 prediction error 写进长期记忆。
平淡的、符合预期的话（"嗯"、"好的"、"哈哈"）不该占长期记忆。

两种打分方式，优先用前者，自动降级：

  1. embedding 余弦距离——当前输入 vs 上一条用户输入（或话题中心）
     surprisal = 1 - cos(current, context)
     准，但要一次 embedding。

  2. 字符 bigram Jaccard 距离——纯文本，零依赖
     surprisal = 1 - |A∩B| / |A∪B|
     embedding 没配时用这个，比"什么都存"好得多。

在此之上叠三个廉价信号（都不需要网络）：
  · 情绪词/强度词  → 加分（"哭""怕""恨""撑不住"）
  · 长度突变        → 加分（长期三五个字突然说了一大段）
  · 问句/祈使       → 小幅加分（"你还记得吗"通常带着要回忆的东西）
"""

from __future__ import annotations

import re

# 情绪强度词：出现就说明这句话承载的东西比日常寒暄重
EMOTION_WORDS = (
    "哭", "怕", "怕死", "恨", "累", "撑不住", "扛不住", "崩溃", "难受", "疼",
    "失眠", "焦虑", "抑郁", "孤独", "委屈", "后悔", "对不起", "谢谢",
    "开心", "高兴", "喜欢", "爱你", "想你", "想念", "舍不得", "对不起",
    "去世", "走了", "离婚", "分手", "吵架", "吵架", "生病", "住院",
    "答应", "承诺", "约定", "永远", "最后一", "再也不",
)

# 纯寒暄：出现且整句很短时，判定为低惊讶
SMALL_TALK = (
    "嗯", "哦", "好的", "好", "行", "可以", "收到", "哈哈", "在吗", "在",
    "早安", "晚安", "早", "拜拜", "再见", "谢谢", "ok", "OK", "嗯嗯",
)


def _bigrams(text: str) -> set[str]:
    s = re.sub(r"\s+", "", text or "")
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def lexical_surprisal(current: str, context: str) -> float:
    """字符 bigram 的 Jaccard 距离，取值 [0,1]。零依赖。"""
    a, b = _bigrams(current), _bigrams(context)
    if not a:
        return 0.0
    if not b:
        return 1.0
    inter = len(a & b)
    union = len(a | b)
    return 0.0 if union == 0 else 1.0 - inter / union


def _emotion_hits(text: str) -> int:
    return sum(1 for w in EMOTION_WORDS if w in text)


def _is_small_talk(text: str) -> bool:
    s = (text or "").strip()
    return len(s) <= 4 and any(s == w or s.startswith(w) for w in SMALL_TALK)


class SurprisalGate:
    """决定这一轮值不值得写进 L0。

    参数都可以通过环境变量覆盖，见 server.py。
    """

    def __init__(
        self,
        embedder=None,
        threshold: float = 0.35,
        emotion_bonus: float = 0.25,
        length_bonus: float = 0.15,
        small_talk_penalty: float = 0.30,
    ):
        self.embedder = embedder
        self.threshold = threshold
        self.emotion_bonus = emotion_bonus
        self.length_bonus = length_bonus
        self.small_talk_penalty = small_talk_penalty

    def score(self, current: str, context: str = "") -> dict:
        """返回 {score, base, emotion, length, small_talk, threshold, store}。

        context 可以是多行（用 \n 分隔最近几条），取「和任一条最相似」的那个
        距离——只要和最近说过的话高度重叠，就不算惊讶。
        """
        current = (current or "").strip()
        context = (context or "").strip()

        if not current:
            return {"score": 0.0, "base": 0.0, "emotion": 0.0, "length": 0.0,
                    "small_talk": 0.0, "threshold": self.threshold, "store": False,
                    "reason": "empty"}

        # ---- 寒暄硬否决 ----
        # 不能只靠扣分：字符距离对短句永远接近 1.0（"嗯" 和任何长句都没有
        # 共同 bigram），扣 0.3 照样过阈值。寒暄直接判死。
        if _is_small_talk(current):
            return {"score": 0.0, "base": 0.0, "emotion": 0.0, "length": 0.0,
                    "small_talk": self.small_talk_penalty, "threshold": self.threshold,
                    "store": False, "reason": "small_talk"}

        chunks = [c.strip() for c in context.split("\n") if c.strip()]

        # ---- 基础距离：和最近几条里最相似的那条比 ----
        base = None
        method = "lexical"
        if self.embedder is not None and getattr(self.embedder, "enabled", False) and chunks:
            texts = [current] + chunks
            vecs = self.embedder.embed(texts)
            if vecs and vecs[0] is not None:
                sims = [(_cos(vecs[0], v) if v is not None else 0.0) for v in vecs[1:]]
                if sims:
                    base = 1.0 - max(sims)
                    method = "embedding"
        if base is None:
            base = min(lexical_surprisal(current, c) for c in chunks) if chunks else 1.0

        # ---- 叠加信号 ----
        emotion = 0.0
        hits = _emotion_hits(current)
        if hits:
            emotion = min(self.emotion_bonus, 0.12 * hits)

        length = 0.0
        if chunks:
            longest_ctx = max(len(c) for c in chunks)
            if len(current) >= 30 and len(current) >= 3 * max(1, longest_ctx):
                length = self.length_bonus

        score = max(0.0, min(1.0, base + emotion + length))
        return {
            "score": round(score, 4),
            "base": round(base, 4),
            "emotion": round(emotion, 4),
            "length": round(length, 4),
            "small_talk": 0.0,
            "threshold": self.threshold,
            "store": score >= self.threshold,
            "method": method,
        }


def _cos(a, b) -> float:
    import math
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
