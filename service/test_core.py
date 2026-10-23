"""本地自测：不依赖 Docker / 外部 API，验证分词、BM25、衰减、融合、诚实出口。"""

from __future__ import annotations

import os
import tempfile
import time

import numpy as np

import memory_core as mc

NOW = 1_780_000_000.0  # 固定时间，避免测试随日期漂移
DAY = 86400.0


def build():
    tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_tmp")
    os.makedirs(tmp, exist_ok=True)
    db = os.path.join(tmp, "mem.db")
    if os.path.exists(db):
        os.remove(db)
    store = mc.MemoryStore(db, schema_path=os.path.join(os.path.dirname(__file__), "schema.sql"))

    # L4 人格 / 关系设定（永不衰减）
    store.add(mc.MemoryInput(
        tier="L4", subject="user",
        text="你叫她小宝。她不喜欢被叫全名。你们约定每周日晚上聊一次。",
        tags=["relationship"],
        ts=NOW - 400 * DAY,
    ))
    store.add(mc.MemoryInput(
        tier="L4", subject="agent",
        text="你是鲸鱼娘，说话短句，偶尔夹英文词。不许说自己是客服。",
        tags=["identity"],
        ts=NOW - 400 * DAY,
    ))
    # L2 人物画像
    store.add(mc.MemoryInput(
        tier="L2", subject="user",
        text="她在准备考研，跨专业，家里养了只叫豆豆的猫，怕黑。",
        tags=["person"],
        ts=NOW - 120 * DAY,
    ))
    # L3 事件线
    store.add(mc.MemoryInput(
        tier="L3", subject="user",
        text="2026 年 3 月那次她加班到凌晨两点，打电话过来哭了很久，说不想干了。",
        tags=["event"],
        ts=NOW - 30 * DAY,
    ))
    # L1 原子事实
    store.add(mc.MemoryInput(
        tier="L1", subject="user",
        text="她对香菜过敏。",
        tags=["fact"],
        ts=NOW - 5 * DAY,
    ))
    store.add(mc.MemoryInput(
        tier="L1", subject="user",
        text="她最怕的是让爸妈失望。",
        tags=["fact"],
        ts=NOW - 200 * DAY,
    ))
    return store


def show(title, hits):
    print(f"\n--- {title} ---")
    if not hits:
        print("  (空 —— 诚实出口生效)")
        return
    for h in hits:
        c = h.to_dict()["components"]
        print(f"  [{h.tier}] {h.score:.3f}  bm25={c['bm25']:.2f} vec={c['vec']:.2f} "
              f"rec={c['recency']:.2f}  {h.text[:34]}")


def main():
    store = build()
    print("stats:", store.stats())

    # 1) 纯关键词命中
    show("query=加班 (关键词)", store.search("加班", top_k=3, now=NOW))

    # 2) 短句 + focus boost：query 只有「嗯」，真正的话题在 focus 里
    show("query=嗯, focus=她说不想干了 (短句靠 focus 顶上来)",
         store.search("嗯", focus="她说不想干了", top_k=3, now=NOW))

    # 3) 完全无关的 query：必须返回空，而不是给一堆 0.6 的假答案
    show("query=量子纠缠退相干 (库里没有 → 应返回空)",
         store.search("量子纠缠退相干", top_k=3, now=NOW))

    # 4) 向量单独命中：无关键词重合，但余弦很高 → 放行
    a = np.zeros(8, dtype=np.float32); a[0] = 1.0
    b = np.zeros(8, dtype=np.float32); b[0] = 0.97; b[1] = 0.24  # cos≈0.97
    mid = store.add(mc.MemoryInput(
        tier="L3", subject="user",
        text="那天她说想去看海，我们约了七月。",
        tags=["event"], ts=NOW - 3 * DAY, vec=b.tolist(),
    ))
    store.add(mc.MemoryInput(
        tier="L3", subject="user",
        text="她讨厌下雨天通勤。",
        tags=["event"], ts=NOW - 3 * DAY, vec=np.array([0.2, 0.98, 0, 0, 0, 0, 0, 0], dtype=np.float32).tolist(),
    ))
    print(f"\n  (插入 id={mid} 含向量)")
    show("query=想出去玩呀, query_vec≈该条 (向量单独命中)",
         store.search("想出去玩呀", query_vec=a.tolist(), top_k=3, now=NOW))

    # 5) 向量低相似 + 无关键词 → 必须拒绝
    c = np.zeros(8, dtype=np.float32); c[5] = 1.0  # 与所有向量正交
    show("query=随便聊聊, query_vec 正交 (应拒绝)",
         store.search("随便聊聊", query_vec=c.tolist(), top_k=3, now=NOW))

    # 6) 衰减：同一条 L1（30 天半衰期），5 天前 vs 200 天前
    print("\n--- 衰减对比 (L1 半衰期 30 天) ---")
    for h in store.search("最怕 过敏", top_k=4, now=NOW):
        print(f"  recency={h.recency:.3f}  {h.text[:30]}")

    # 7) L4 永远注入
    prof = store.profile()
    print(f"\n--- profile() 返回 {len(prof)} 条（每轮必带）---")
    for p in prof:
        print(f"  [{p.tier}/{p.subject}] {p.text[:40]}")

    # 8) 检索日志
    rows = store.conn.execute(
        "SELECT outcome, COUNT(*) c FROM search_log GROUP BY outcome ORDER BY c DESC"
    ).fetchall()
    print("\n--- search_log 统计 ---")
    for r in rows:
        print(f"  {r['outcome']}: {r['c']}")


if __name__ == "__main__":
    main()
