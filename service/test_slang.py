# -*- coding: utf-8 -*-
"""slang（学说话）的新门槛测试。

规矩是 2026-10-27 定的：
  1. 只收 2-8 字、全是汉字/字母/数字的短词（句子不收）
  2. 说够 6 次、且知道意思，才算「学会」
  3. 够 6 次但不懂意思 → 进 pending，等她去问
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import memory_core as mc  # noqa: E402

SCHEMA = os.path.join(HERE, "schema.sql")
TMP = tempfile.mkdtemp(prefix="slang_test_")

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
    p = os.path.join(TMP, name)
    for s in ("", "-wal", "-shm"):
        if os.path.exists(p + s):
            os.remove(p + s)
    # schema.sql 里没有 meaning 等列的老版本也能跑 —— 走迁移补上
    return mc.MemoryStore(p, schema_path=SCHEMA)


print("=" * 64)
print("[1] 收录门槛：长度 2-8、只允许汉字字母数字")
print("=" * 64)
s = fresh("len.db")
CASE_TAKE = ["在吗", "绝了", "哈哈哈", "抽象", "大肥鱼"]
CASE_DROP = ["a", "", "上上下下左右左右BABA", "你爹现在在调试你呀呀",  # 9 字以上
             "382422192", "#sl", "好感度增加20%", "在吗，问你个事", "hello world"]
for w in CASE_TAKE:
    s.slang_add(w, 1, "", "", "chat")
for w in CASE_DROP:
    s.slang_add(w, 1, "", "", "chat")
got = {r["phrase"] for r in s.slang_list(limit=100)}
for w in CASE_TAKE:
    check(f"收了 {w!r}", w in got)
for w in CASE_DROP:
    check(f"拒了 {w!r}", w not in got, f"实际在库里: {w in got}")
s.close()

print()
print("=" * 64)
print("[2] 计数：同一个词说多次，count 往上加")
print("=" * 64)
s = fresh("count.db")
for _ in range(6):
    s.slang_add("在吗", 1, "", "", "chat")
rows = {r["phrase"]: r["count"] for r in s.slang_list(limit=100)}
check("在吗 被数了 6 次", rows.get("在吗") == 6, f"实际 {rows.get('在吗')}")
s.close()

print()
print("=" * 64)
print("[3] 转正门槛：≥6 次 + 有 meaning 才算学会")
print("=" * 64)
s = fresh("gate.db")
for _ in range(6):
    s.slang_add("在吗", 1, "", "", "chat")            # 6 次，没意思
s.slang_add("抽象", 1, "网络用语，形容离谱", "", "taught")  # 教的，有意思
s.slang_add("绝了", 1, "", "", "chat")                # 1 次

learned = s.slang_list(limit=10, only_repeated=True, min_count=6, require_meaning=True)
names = [r["phrase"] for r in learned]
check("『抽象』进 learned（taught + 有意义）", "抽象" in names, str(names))
check("『在吗』不进 learned（没意思）", "在吗" not in names, str(names))
check("『绝了』不进 learned（不到 6 次）", "绝了" not in names, str(names))

pending = s.slang_pending(6, 5)
pn = [r["phrase"] for r in pending]
check("『在吗』进 pending（够次数、缺意思）", "在吗" in pn, str(pn))
check("『抽象』不进 pending（已经知道意思）", "抽象" not in pn, str(pn))
check("pending 带 count", all("count" in r for r in pending))
s.close()

print()
print("=" * 64)
print("[4] 意义写入：slang_set_meaning 能补上意思")
print("=" * 64)
s = fresh("meaning.db")
for _ in range(6):
    s.slang_add("在吗", 1, "", "", "chat")
check("补意思前，pending 里有『在吗』", "在吗" in [r["phrase"] for r in s.slang_pending(6, 5)])
s.slang_set_meaning("在吗", "他上线时习惯先问这句")
check("补意思后，pending 里没了", "在吗" not in [r["phrase"] for r in s.slang_pending(6, 5)])
learned = s.slang_list(limit=10, only_repeated=True, min_count=6, require_meaning=True)
check("补意思后，进 learned", "在吗" in [r["phrase"] for r in learned])
r = [x for x in s.slang_list(limit=10) if x["phrase"] == "在吗"][0]
check("meaning 存对了", r["meaning"] == "他上线时习惯先问这句", r["meaning"])
s.close()

print()
print("=" * 64)
print(f"通过 {n_pass} / {n_pass + n_fail}")
print("=" * 64)
if n_fail:
    print("有失败项")
    sys.exit(1)
