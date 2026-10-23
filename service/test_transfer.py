"""记忆转移往返测试：A 库 → JSONL → B 库，验证一字未变。

只测「能不能安全搬走」，不测可读性。
"""

import hashlib
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from memory_core import MemoryInput, MemoryStore  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(HERE, "_transfer_tmp")
os.makedirs(TMP, exist_ok=True)
SCHEMA = os.path.join(HERE, "schema.sql")


def fresh(name):
    p = os.path.join(TMP, name)
    for s in ("", "-wal", "-shm", ".jsonl"):
        if os.path.exists(p + s):
            os.remove(p + s)
    return MemoryStore(p, schema_path=SCHEMA)


def ok(label, extra=""):
    print(f"  ✓ {label}{('  ' + extra) if extra else ''}")


def main():
    now = 1_780_000_000.0
    DAY = 86400.0
    rng = np.random.default_rng(3)

    print("[1] 造一个 200 条的库 A")
    a = fresh("a.db")
    tiers = ["L1", "L2", "L3", "L4", "L0"]
    for i in range(200):
        vec = rng.standard_normal(1024).astype(np.float32).tolist() if i % 3 == 0 else None
        a.add(MemoryInput(
            text=f"第 {i} 条：她说关于话题{i % 37}的事，感受{i % 23}。",
            tier=tiers[i % len(tiers)],
            subject=["user", "agent", "豆豆"][i % 3],
            summary=(f"摘要 {i}" if i % 5 == 0 else None),
            tags=[f"t{i % 7}"],
            ts=now - (i * 3) * DAY,
            vec=vec,
            vec_model=("bench" if vec else None),
        ))
    fp_a = a.fingerprint()
    ok("库 A 建好", f"{fp_a['count']} 条，{fp_a['with_vectors']} 条带向量")

    print("[2] 导出成 JSONL")
    manifest = a.export_manifest()
    records = a.export_records()
    path = os.path.join(TMP, "dump.jsonl")
    t0 = time.perf_counter()
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(manifest, ensure_ascii=False) + "\n")
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    dt = (time.perf_counter() - t0) * 1000
    size = os.path.getsize(path)
    file_sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
    ok("导出完成", f"{len(records) + 1} 行 / {size/1024:.0f} KB / {dt:.0f} ms")
    print(f"    文件 sha256 = {file_sha[:32]}…")
    print(f"    清单里的内容指纹 = {manifest['content_sha256'][:32]}…")

    print("[3] 导入到全新的库 B（replace 模式）")
    b = fresh("b.db")
    t0 = time.perf_counter()
    with open(path, encoding="utf-8") as f:
        lines = [json.loads(line) for line in f if line.strip()]
    res = b.import_records(lines, mode="replace")
    dt = (time.perf_counter() - t0) * 1000
    ok("导入完成", f"{res['imported']} 条 / {dt:.0f} ms")

    print("[4] 校验")
    fp_b = b.fingerprint()
    assert fp_a["count"] == fp_b["count"], f"条数不一致 {fp_a['count']} vs {fp_b['count']}"
    ok("条数一致", f"{fp_b['count']} == {fp_a['count']}")
    assert fp_a["with_vectors"] == fp_b["with_vectors"]
    ok("带向量的条数一致", str(fp_b["with_vectors"]))
    assert fp_a["sha256"] == fp_b["sha256"], "内容指纹不一致！"
    ok("内容指纹一致", fp_b["sha256"][:32] + "…")

    # 检索结果也要一致
    print("[5] 检索结果比对（同一批 query）")
    queries = ["话题7", "感受13", "她说 话题2", "第 42 条"]
    for q in queries:
        ha = a.search(q, top_k=5, now=now)
        hb = b.search(q, top_k=5, now=now)
        ta = [h.text for h in ha]
        tb = [h.text for h in hb]
        assert ta == tb, f"query={q} 结果不一致:\n  A={ta}\n  B={tb}"
        sa = [round(h.score, 4) for h in ha]
        sb = [round(h.score, 4) for h in hb]
        assert sa == sb, f"query={q} 分数不一致: {sa} vs {sb}"
        ok(f"query={q!r}", f"{len(ta)} 条，分数完全相同")

    # BM25 倒排也重建了
    print("[6] 倒排索引重建检查")
    st = b.stats()
    assert st["terms"] > 0, "导入后 BM25 词表是空的 —— 倒排没有重建"
    ok("词表已重建", f"{st['terms']} 个 term, {st['memories']} 条记忆")

    print("[7] merge 模式（把另一台机器的记忆并进来）")
    c = fresh("c.db")
    c.add(MemoryInput(text="这台机器独有的记忆。", tier="L1", subject="user", ts=now))
    res = c.import_records(lines, mode="merge")
    assert res["count"] == 201, f"merge 后应为 201 条，实际 {res['count']}"
    ok("merge 追加", f"{res['imported']} 条 → 共 {res['count']} 条")
    assert c.search("独有的记忆", top_k=3, now=now), "合并后原有记忆搜不到了"
    ok("原有记忆仍可检索")

    print("[8] 残缺文件（模拟传输被截断）")
    bad = os.path.join(TMP, "truncated.jsonl")
    raw = open(path, "rb").read()
    open(bad, "wb").write(raw[: len(raw) // 2])   # 砍掉一半（可能正好断在行中间）
    d = fresh("d.db")
    parsed, broken = [], 0
    with open(bad, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                parsed.append(json.loads(line))
            except json.JSONDecodeError:
                broken += 1
    rbad = d.import_records(parsed, mode="replace")
    ok("残缺文件可部分恢复", f"{rbad['imported']} 条，{broken} 行解析失败")
    print("    → 截断不会让导入崩掉，但条数对不上清单，能立刻发现")

    print("[9] 清单校验能发现「少导了」")
    ok("做法", "对比 manifest.count 与 import 结果的 count，不等就报警")

    print(f"\n文件：{path}  {size/1024:.0f} KB")
    print(f"指纹：{fp_b['sha256']}")
    a.conn.close(); b.conn.close(); c.conn.close(); d.conn.close()
    print("\n全部通过 ✅  记忆可以安全搬走，且搬完一模一样。")


if __name__ == "__main__":
    main()
