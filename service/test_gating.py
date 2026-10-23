"""写入门控测试：惊讶度（真算）+ LLM 逐条判定（mock LLM）。

不依赖网络：惊讶度用纯文本降级路径；判定用假的 LLM 返回固定 JSON。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extractor import ExtractConfig, Extractor  # noqa: E402
from memory_core import MemoryInput, MemoryStore  # noqa: E402
from surprisal import SurprisalGate, lexical_surprisal  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(HERE, "_gating_tmp")
os.makedirs(TMP, exist_ok=True)
SCHEMA = os.path.join(HERE, "schema.sql")
NOW = 1_780_000_000.0


def ok(label, extra=""):
    print(f"  ✓ {label}{('  ' + extra) if extra else ''}")


# ---------------------------------------------------------------------------
print("=" * 64)
print("[1] 惊讶度门控（纯文本降级，不依赖 embedding）")
print("=" * 64)

gate = SurprisalGate(embedder=None, threshold=0.35)

cases = [
    # (当前输入, 上下文, 期望是否入库, 说明)
    ("嗯", "她今天加班到很晚，说想辞职", False, "寒暄硬否决"),
    ("好的", "我们在聊她家里的猫", False, "寒暄硬否决"),
    ("哈哈哈哈", "聊周末去哪玩", False, "寒暄硬否决"),
    ("在吗", "刚聊完她家猫的事", False, "寒暄硬否决"),
    ("她今天被裁员了，在电话里哭了很久", "早安，今天天气不错", True, "重大事件 + 情绪词"),
    ("我其实一直很怕我爸失望", "嗯嗯", True, "情绪词命中"),
    ("今天也要加班，好累啊", "她说最近天天加班，想辞职\n今天也要加班，好累啊", False, "和最近说的话高度重叠"),
    ("豆豆今天又把花瓶打翻了", "我们在聊猫", True, "新事件，话题确实转了"),
]

for text, ctx, expect, why in cases:
    r = gate.score(text, ctx)
    passed = r["store"] == expect
    mark = "✓" if passed else "✗"
    print(f"  {mark} {text[:24]:<26} score={r['score']:.2f} (base={r['base']:.2f} "
          f"emo={r['emotion']:.2f} small={r['small_talk']:.2f})  → "
          f"{'入库' if r['store'] else '丢弃'}   {why}")
    assert passed, f"期望 {'入库' if expect else '丢弃'}，实际 {r['store']}"

ok("七个用例全部符合预期")

print("\n  无上下文时：")
r = gate.score("随便说点什么", "")
print(f"    score={r['score']} store={r['store']}  （首轮没有参照，默认入库）")
assert r["store"] is True
ok("首轮默认入库")

print("\n  字符 bigram 距离的直观值：")
pairs = [
    ("嗯", "她今天加班到很晚"),
    ("豆豆今天又把花瓶打翻了", "我们在聊她家的猫"),
    ("她今天被裁员了，在电话里哭了很久", "早安，今天天气不错"),
]
for a, b in pairs:
    print(f"    lexical_surprisal({a[:14]!r:<20}, {b[:14]!r:<20}) = {lexical_surprisal(a, b):.3f}")

# ---------------------------------------------------------------------------
print()
print("=" * 64)
print("[2] LLM 逐条判定（mock LLM，验证 ADD / UPDATE / DELETE / NONE）")
print("=" * 64)


class MockLLM:
    """按 system prompt 区分是抽取还是判定，返回预设结果。"""

    enabled = True
    last_error = None

    def __init__(self, extract=None, decide=None):
        self._extract = extract
        self._decide = decide

    def chat_json(self, system, user, max_tokens=0):
        if "抽取值得长期记住的事实" in system:
            return self._extract
        if "管理一个记忆库" in system:
            return self._decide(user)
        return None


def fresh(name):
    p = os.path.join(TMP, name)
    for s in ("", "-wal", "-shm"):
        if os.path.exists(p + s):
            os.remove(p + s)
    return MemoryStore(p, schema_path=SCHEMA)


# --- 2a. ADD --------------------------------------------------------------
store = fresh("add.db")
llm = MockLLM(
    extract=[{"text": "她对香菜过敏", "tier": "L1", "subject": "self", "importance": 0.6}],
    decide=lambda user: [{"fact_index": 0, "op": "ADD", "reason": "no similar memory"}],
)
ex = Extractor(llm, store, ExtractConfig(enabled=True))
res = ex.process_turn("我跟你讲，我对香菜过敏", "记下了")
assert res["applied"]["add"] == 1, res
assert store.conn.execute("SELECT COUNT(*) FROM memory").fetchone()[0] == 1
ok("ADD：新事实入库", f"facts={res['facts']} add={res['applied']['add']}")

# --- 2b. UPDATE -----------------------------------------------------------
store = fresh("update.db")
old_id = store.add(MemoryInput(text="她怕黑。", tier="L2", subject="self", ts=NOW))
llm = MockLLM(
    extract=[{"text": "她怕黑，也怕打雷", "tier": "L2", "subject": "self"}],
    decide=lambda user: [{"fact_index": 0, "op": "UPDATE", "target_id": old_id,
                          "text": "她怕黑，也怕打雷。", "reason": "更完整的版本"}],
)
res = Extractor(llm, store, ExtractConfig(enabled=True)).process_turn("我不仅怕黑还怕打雷", "")
assert res["applied"]["update"] == 1, res
rows = store.conn.execute("SELECT id, text FROM memory").fetchall()
assert len(rows) == 1, f"UPDATE 不该新增记录，实际 {len(rows)} 条"
assert rows[0]["id"] == old_id and "打雷" in rows[0]["text"]
ok("UPDATE：原地改，不新增", f"id={old_id} text={rows[0]['text']}")

# --- 2c. DELETE -----------------------------------------------------------
store = fresh("delete.db")
old_id = store.add(MemoryInput(text="她讨厌猫。", tier="L2", subject="self", ts=NOW))
llm = MockLLM(
    extract=[{"text": "她养了一只猫叫豆豆", "tier": "L2", "subject": "self"}],
    decide=lambda user: [{"fact_index": 0, "op": "DELETE", "target_id": old_id,
                          "reason": "和新事实矛盾"}],
)
res = Extractor(llm, store, ExtractConfig(enabled=True)).process_turn("我养了只猫叫豆豆", "")
assert res["applied"]["delete"] == 1, res
rows = store.conn.execute("SELECT text FROM memory").fetchall()
texts = [r["text"] for r in rows]
assert "她讨厌猫。" not in texts, "旧的矛盾记忆应该被删掉"
assert any("豆豆" in t for t in texts), "新事实应该留下来"
ok("DELETE：删掉矛盾旧记忆，新事实入库", f"现有 {len(texts)} 条")

# --- 2d. NONE -------------------------------------------------------------
store = fresh("none.db")
old_id = store.add(MemoryInput(text="她对香菜过敏。", tier="L1", subject="self", ts=NOW))
llm = MockLLM(
    extract=[{"text": "她不吃香菜", "tier": "L1", "subject": "self"}],
    decide=lambda user: [{"fact_index": 0, "op": "NONE", "reason": "已经存在，换个说法"}],
)
res = Extractor(llm, store, ExtractConfig(enabled=True)).process_turn("我不吃香菜", "")
assert res["applied"]["none"] == 1, res
assert store.conn.execute("SELECT COUNT(*) FROM memory").fetchone()[0] == 1, "NONE 不该改动库"
ok("NONE：换个说法不重复存")

# --- 2e. LLM 挂了 ---------------------------------------------------------
store = fresh("degraded.db")


class DeadLLM:
    enabled = True
    last_error = "HTTP 500: boom"

    def chat_json(self, system, user, max_tokens=0):
        return None


res = Extractor(DeadLLM(), store, ExtractConfig(enabled=True)).process_turn("随便说说", "")
assert res["ok"] is False and res.get("degraded") == "extract-failed", res
assert store.conn.execute("SELECT COUNT(*) FROM memory").fetchone()[0] == 0
ok("LLM 失败：不写库、返回 degraded，调用方可以退回直接存原话", res.get("degraded"))

# --- 2f. 没开抽取 ---------------------------------------------------------
res = Extractor(MockLLM(), store, ExtractConfig(enabled=False)).process_turn("随便说说", "")
assert res["ok"] is False and res["degraded"] == "llm-disabled"
ok("未启用抽取：直接返回 degraded，不做无谓调用")

print("\n" + "=" * 64)
print("全部通过 ✅")
print("=" * 64)
print("""
接入方式：
  turn/end 时
    ① POST /surprisal {text, context}   → store=false 就不写 L0
    ② POST /extract   {user_text, assistant_text}  → 抽结构记忆（fire-and-forget）
""")
