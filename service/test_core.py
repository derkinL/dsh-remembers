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


def test_persona(store) -> None:
    """人格两半：能存能取；AI 那半碰不到宪法；超长被拒。

    这是「二合一」最该守住的三条 —— 分区要是漏在服务端，界面上的只读框
    就只是装饰。
    """
    print("\n--- 人格设定：宪法区 / 自我认知区 ---")

    assert store.get_persona()["constitution"] == "", "新库的人格应该是空的"
    assert store.get_persona()["self_model"] == "", "新库的自我认知应该是空的"

    store.set_persona(constitution="你叫阿澜，26 岁。你叫对方「姐」。")
    got = store.get_persona()
    assert got["constitution"].startswith("你叫阿澜"), "宪法应写进去"
    assert got["self_model"] == "", "没传的那半不该被顺手清空"
    print(f"  宪法区 {len(got['constitution'])} 字符 ...ok")

    # AI 侧入口：只能写自我认知
    store.set_self_model("我发现自己讲道理爱打比方，一抒情就假。")
    got = store.get_persona()
    assert "讲道理爱打比方" in got["self_model"], "自我认知应写进去"
    assert got["constitution"].startswith("你叫阿澜"), "set_self_model 不许碰宪法区"
    print(f"  自我认知区 {len(got['self_model'])} 字符，宪法未被改动 ...ok")

    # 超长拒绝，且失败时不能把旧内容写坏
    try:
        store.set_self_model("长" * (mc.MemoryStore.SELF_MODEL_MAX + 1))
        raise AssertionError("超长应当被拒绝")
    except ValueError:
        pass
    assert "讲道理爱打比方" in store.get_persona()["self_model"], "被拒的写入不该破坏原内容"
    print(f"  超长被拒且原内容完好（上限 {mc.MemoryStore.SELF_MODEL_MAX}）...ok")

    # 只传一半：另一半连同它的时间戳都不该动
    before = store.get_persona()
    store.set_persona(self_model="改了一句自我认知。")
    after = store.get_persona()
    assert after["constitution"] == before["constitution"], "只改自我认知时宪法应原样"
    assert after["updated_at"] == before["updated_at"], "宪法没改，它的时间戳也不该动"
    assert after["self_updated_at"] >= before["self_updated_at"], "自我认知的时间戳应更新"
    print("  单边写入不影响另一半的时间戳 ...ok")


class _FakeLLM:
    """替身：不联网，固定返回一段 episode 文本。"""

    def __init__(self, reply):
        self.reply = reply
        self.enabled = True
        self.last_error = None
        self.calls = 0

    def chat(self, system, user, max_tokens=1200):
        self.calls += 1
        return self.reply

    def chat_json(self, *a, **k):
        return None


class _DeadLLM(_FakeLLM):
    def __init__(self):
        super().__init__(None)
        self.last_error = "HTTP 401: bad key"


def test_episode(store) -> None:
    """episode：一段对话压成一条 L3；失败不抛、不写脏数据。"""
    from extractor import ExtractConfig, Extractor

    print("\n--- episode 摘要 ---")
    turns = [
        {"user": "今天又在弄那个记忆插件", "assistant": "弄到哪一步了？"},
        {"user": "人格那块终于跑通了，就是困", "assistant": "先睡，明天再验。"},
    ]

    # 1) LLM 调用失败 → degraded，不抛、不落库
    dead = Extractor(_DeadLLM(), store, ExtractConfig(), embedder=None)
    before = store.stats()["memories"]
    res = dead.summarize_episode(turns, window_hint="2026-10-24 00:10")
    assert res["ok"] is False and res["degraded"] == "llm-failed", res
    assert store.stats()["memories"] == before, "失败的 episode 不该落库"
    print(f"  LLM 失败 → degraded={res['degraded']}，库没变 ...ok")

    # 2) 完全没 LLM
    none_llm = Extractor(None, store, ExtractConfig(), embedder=None)
    res = none_llm.summarize_episode(turns)
    assert res["ok"] is False and res["degraded"] == "llm-disabled", res
    print("  没 LLM → degraded=llm-disabled ...ok")

    # 3) 正常：落一条 L3，带 episode 标签
    fake = _FakeLLM("## 2026-10-24 凌晨\n\n- 她在弄记忆插件，人格那块跑通了。\n- 人很困，说好明天再验。")
    ex = Extractor(fake, store, ExtractConfig(), embedder=None)
    res = ex.summarize_episode(turns, window_hint="2026-10-24 00:10 ~ 00:40")
    assert res["ok"] is True, res
    assert res["turns"] == 2
    row = store.conn.execute("SELECT tier, tags, text FROM memory WHERE id=?", (res["id"],)).fetchone()
    assert row["tier"] == "L3", f"episode 必须是 L3，实际 {row['tier']}"
    assert "episode" in (row["tags"] or ""), row["tags"]
    assert "人格那块跑通了" in row["text"]
    print(f"  落库成功 → id={res['id']} tier=L3 {res['chars']} 字符 ...ok")

    # 4) 能被检索到（以后回想得起来）
    hits = store.search("记忆插件 人格 困", top_k=3, now=NOW)
    assert any(h.id == res["id"] for h in hits), "刚写的 episode 应该能被检索到"
    print("  可被检索 ...ok")

    # 5) 空输入 → skipped，不浪费 LLM 调用
    calls_before = fake.calls
    assert ex.summarize_episode([])["skipped"] == "empty"
    assert fake.calls == calls_before, "空输入不该调 LLM"
    print("  空输入不调 LLM ...ok")


def main():
    store = build()
    print("stats:", store.stats())

    test_persona(store)
    test_episode(store)

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
