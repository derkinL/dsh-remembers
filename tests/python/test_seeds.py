"""默认语料导入的回归测试（1.2.0）。

踩过的坑：`expr_import_seeds()` 的 INSERT 把 `raw` 写进了 `last_hit`，
而 `/learn/stats` 会 `float(last_hit)` —— 一条语料就能让整页计数 500：
    could not convert string to float: '龙族只有前三部'

这里锁三件事：
  1. 导入后 `last_hit` 全是数字（MAX(last_hit) 能 float）
  2. 幂等：同一个 builtAt 导第二次返回 0，不重复插
  3. 导入的条目 source='seed' / status='active'（不占 40 条学习上限）
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "service"))
sys.path.insert(0, SERVICE_DIR)

import memory_core as mc  # noqa: E402

SCHEMA = os.path.join(SERVICE_DIR, "schema.sql")
TMP = os.path.join(HERE, "_seeds_tmp")
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


ITEMS = [
    {"raw": "包浆了", "meaning": "用得太久磨出包浆，形容老梗", "usage": "这梗都包浆了",
     "tail": False, "hits": 9, "vibe": "搞笑"},
    {"raw": "前排", "meaning": "抢在热评前面", "usage": "前排，凉了", "tail": True,
     "hits": 3, "vibe": "互动"},
]
ITEMS[0]["__builtAt"] = "test-2026-11-08"

print("=" * 60)
print("[1] 导入：条数 / source / status / last_hit 是数字")
print("=" * 60)
store = fresh("seed.db")
got = store.expr_import_seeds(ITEMS)
check("导入了 2 条", got == 2, f"实际 {got}")

rows = store.conn.execute(
    "SELECT raw, source, status, likes, typeof(last_hit) AS t FROM expressions ORDER BY id"
).fetchall()
check("raw 都对", [r["raw"] for r in rows] == ["包浆了", "前排"], str([r["raw"] for r in rows]))
check("source=seed", all(r["source"] == "seed" for r in rows))
check("status=active", all(r["status"] == "active" for r in rows))
check("likes 跟着 hits 走", [r["likes"] for r in rows] == [9, 3], str([r["likes"] for r in rows]))
check("last_hit 是数字类型", all(r["t"] in ("integer", "real") for r in rows), str([r["t"] for r in rows]))

# /learn/stats 的核心查询：MAX(last_hit) 必须能 float
try:
    raw_max = store.conn.execute("SELECT MAX(last_hit) FROM expressions").fetchone()[0]
    float(raw_max or 0)
    check("MAX(last_hit) 能转 float（/learn/stats 不再 500）", True)
except (TypeError, ValueError) as exc:
    check("MAX(last_hit) 能转 float（/learn/stats 不再 500）", False, str(exc))

print()
print("=" * 60)
print("[2] 幂等：同一个 builtAt 不重复导入")
print("=" * 60)
again = store.expr_import_seeds(ITEMS)
check("第二次返回 0", again == 0, f"实际 {again}")
total = store.conn.execute("SELECT COUNT(*) FROM expressions").fetchone()[0]
check("库里还是 2 条", total == 2, f"实际 {total}")
store.close()

print()
print("=" * 60)
print("[3] 老库修复：文本 last_hit 打开时归零")
print("=" * 60)
store = fresh("legacy.db")
store.conn.execute(
    "INSERT INTO expressions(scope, situation, style, raw, source, count, ts, last_hit) "
    "VALUES ('seed','搞笑','前排','前排','seed',1,0,'龙族只有前三部')"
)
store.conn.commit()
store.close()

store = fresh("legacy.db")   # 重开一次，走 _ensure_expr_columns 的修复
bad = store.conn.execute(
    "SELECT COUNT(*) FROM expressions WHERE typeof(last_hit) NOT IN ('integer','real')"
).fetchone()[0]
check("脏 last_hit 已被归零", bad == 0, f"还剩 {bad}")
maxv = store.conn.execute("SELECT MAX(last_hit) FROM expressions").fetchone()[0]
check("MAX(last_hit) 可转 float", isinstance(float(maxv or 0), float))
store.close()

print()
print("=" * 60)
print(f"通过 {n_pass} / {n_pass + n_fail}")
print("=" * 60)
if n_fail:
    print("有失败项")
    sys.exit(1)
