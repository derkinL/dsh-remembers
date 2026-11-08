"""她自己说过的话（self_line）与口音样本的回归测试（1.2.1）。

背景：口音档案原来靠「网友原句转正」，而转正要求 hits>=3、抽取每条只出现一次
→ active 永远是 0、doc 永远是空（线上实测）。1.2.1 改成从**她自己的发言**里量，
这里锁住：self_line 写入/计数/排序，以及 expr_voice_samples 的「学到的优先、语料兜底」。
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "service"))
sys.path.insert(0, SERVICE_DIR)

import memory_core as mc  # noqa: E402

SCHEMA = os.path.join(SERVICE_DIR, "schema.sql")
TMP = os.path.join(HERE, "_selfline_tmp")
shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP, exist_ok=True)

n_pass = 0
n_fail = 0


def check(label, cond, detail=""):
    global n_pass, n_fail
    if cond:
        n_pass += 1
        print(f"  ✓ {label}")
    else:
        n_fail += 1
        print(f"  ✗ {label}  {detail}")


def fresh(name):
    return mc.MemoryStore(os.path.join(TMP, name), schema_path=SCHEMA)


print("=" * 60)
print("[1] self_line：写入 / 计数 / 过滤空串")
print("=" * 60)
store = fresh("self.db")
check("写 3 句", all(store.self_line_add(t, session="s1") for t in ["嗯，我在", "今天有点困", "先这样吧"]))
check("空串不写", store.self_line_add("   ") == 0)
check("30 天计数 = 3", store.self_line_count(30) == 3, store.self_line_count(30))
lines = store.self_lines(10)
check("取回 3 条", len(lines) == 3, len(lines))
check("按时间倒序（最新在前）", lines[0]["text"] == "先这样吧", lines[0]["text"])

print()
print("=" * 60)
print("[2] expr_voice_samples：学到的优先，语料兜底")
print("=" * 60)
store.expr_add("bili", "接梗", "前排，凉了", raw="前排，凉了", source="bili", likes=12)
store.expr_add("bili", "接梗", "这很难评", raw="这很难评", source="bili", likes=30)
store.expr_import_seeds([{"raw": "233", "meaning": "笑", "hits": 99, "vibe": "搞笑",
                          "tail": False, "likes": 4884, "__builtAt": "t1"}])
samples = store.expr_voice_samples(6)
raws = [s["raw"] for s in samples]
check("学到的排在最前", raws[:2] and raws[0] in ("这很难评", "前排，凉了"), raws)
check("语料也能补进来", "233" in raws, raws)
check("默认语料带 source=seed", any(s["source"] == "seed" for s in samples))

print()
print("=" * 60)
print("[3] 空库不炸：没有样本时返回空列表")
print("=" * 60)
empty = fresh("empty.db")
check("expr_voice_samples 返回 []", empty.expr_voice_samples(5) == [])
check("self_lines 返回 []", empty.self_lines(5) == [])
check("self_line_count = 0", empty.self_line_count(30) == 0)
empty.close()
store.close()

print()
print("=" * 60)
print(f"通过 {n_pass} / {n_pass + n_fail}")
print("=" * 60)
if n_fail:
    print("有失败项")
    sys.exit(1)
