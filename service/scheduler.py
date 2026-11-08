"""内置调度：把原来 cron 的「主动唤醒 + B 站浏览」搬进服务端。

原来靠 proactive-inject.sh + cron 做：
  1. 主动唤醒（到间隔就注入一条提示，让模型自己醒）
  2. B 站浏览（独立节奏）

现在放到服务端进程里跑（独立线程），Windows/Linux 通用。
状态存 JSON 文件（跨平台），不依赖 cron/systemd。

设计原则：
  - 线程崩了不影响 HTTP 服务（顶层 try/except）
  - 状态持久化（重启不丢）
  - 没有 QQ 注入路径时降级为「只记日志，不注入」
  - 环境变量 CMEM_SCHEDULER=0 可关闭

游戏/日记/演化仍在 server.py 的 HTTP 接口里（/game/play、/diary/write、/evolve），
由 cron 或外部触发；这个调度器只管唤醒和 B 站。
"""

from __future__ import annotations

import json
import os
import random
import threading
import time
import datetime


def _log(msg: str) -> None:
    print(f"[scheduler] {msg}", flush=True)


class Scheduler:
    """服务端内置调度器。"""

    def __init__(self, store, data_dir: str):
        self.store = store
        self.data_dir = data_dir
        self.state_file = os.path.join(data_dir, "scheduler-state.json")
        self.enabled = os.environ.get("CMEM_SCHEDULER", "1") not in ("0", "false", "False")
        self.inject_path = os.environ.get("CMEM_INJECT_PATH", "")

    # ---------- 状态 ----------
    def _load_state(self) -> dict:
        try:
            with open(self.state_file, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _save_state(self, st: dict) -> None:
        try:
            tmp = self.state_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(st, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.state_file)
        except Exception as e:
            _log(f"save state failed: {e}")

    # ---------- 启动 ----------
    def start(self) -> bool:
        if not self.enabled:
            _log("disabled (CMEM_SCHEDULER=0)")
            return False
        t = threading.Thread(target=self._loop, name="dsh-scheduler", daemon=True)
        t.start()
        _log(f"started (thread={t.name})")
        return True

    def _loop(self) -> None:
        time.sleep(10)
        while True:
            try:
                self._tick()
            except Exception as e:
                _log(f"tick error: {e}")
            time.sleep(30)

    def _tick(self) -> None:
        now = time.time()
        st = self._load_state()
        changed = False

        today = datetime.date.today().isoformat()
        if st.get("date") != today:
            st["date"] = today
            st["bili_count"] = 0
            st["evolve_count"] = 0
            st["tieba_count"] = 0
            changed = True

        if self._tick_wake(st, now):
            changed = True
        if self._tick_bili(st, now):
            changed = True
        if self._tick_tieba(st, now):
            changed = True

        if self._tick_diary(st, now):
            changed = True
        if self._tick_evolve(st, now):
            changed = True

        if changed:
            self._save_state(st)

    # ---------- 读配置 ----------
    def _proactive_cfg(self) -> dict:
        """读 proactive.json（前端"主动消息"页配置的那个文件）。

        之前用 self.store._load_proactive()，但 memory_core 里根本没这个方法，
        hasattr 返回 False → 永远返回 {} → 所有配置（时间窗/间隔/静默/预设）全部失效，
        一直用硬编码默认值。2026-10-26 修。
        """
        import json as _json
        import os as _os
        try:
            # CMEM_DATA_DIR 优先（systemd 环境变量），否则用实例的 data_dir
            data_dir = _os.environ.get("CMEM_DATA_DIR") or self.data_dir
            p = _os.path.join(data_dir, "proactive.json")
            with open(p, encoding="utf-8") as f:
                cfg = _json.load(f)
            return cfg if isinstance(cfg, dict) else {}
        except Exception as e:
            _log(f"proactive_cfg: read failed ({e})")
            return {}

    # ---------- 1. 唤醒 ----------
    def _wake_chats(self) -> list:
        """要主动唤醒的聊天列表：[(kind, id), ...]。

        存在 config.json 的 wakeChats 里（`private:<QQ>` / `group:<群号>` → bool）。
        没有任何配置时默认只有主人私聊 —— 跟以前一样；配置存在时严格照它来，
        全关就真的不唤（不能回退到主人，否则关不掉）。
        """
        cfg = {}
        try:
            with open(os.path.join(self.data_dir, "config.json"), encoding="utf-8") as f:
                cfg = json.load(f) or {}
        except Exception:
            cfg = {}
        wc = cfg.get("wakeChats")
        if isinstance(wc, dict):
            out = []
            for key, on in wc.items():
                if not on:
                    continue
                kind, _, tid = str(key).partition(":")
                if kind in ("private", "group") and tid.isdigit():
                    out.append((kind, tid))
            return out
        return [("private", str(self._owner_qq()))]

    def _tick_wake(self, st: dict, now: float) -> bool:
        cfg = self._proactive_cfg()
        if not cfg.get("enabled", True):
            return False

        start = int(cfg.get("startHour", 8))
        end = int(cfg.get("endHour", 23))
        hour = datetime.datetime.now().hour
        if hour < start or hour >= end:
            return False

        min_gap = max(5, int(cfg.get("minGapMinutes", 30)))
        max_gap = max(min_gap, int(cfg.get("maxGapMinutes", 180)))

        last = float(st.get("last_wake", 0))
        interval = float(st.get("wake_interval", 0))
        if interval <= 0:
            interval = (min_gap + random.randint(0, max_gap - min_gap)) * 60
            st["wake_interval"] = interval
            _log(f"wake: next interval {int(interval // 60)} min")
            return True
        if now - last < interval:
            return False

        min_chat = int(cfg.get("minChatBeforeWake", 5))
        try:
            chat_n = int(self.store.get_state().get("chat_since_wake", 0) or 0)
        except Exception:
            chat_n = 0
        if chat_n < min_chat:
            _log(f"wake: gate_chat chat={chat_n} < {min_chat}, skip")
            return False

        st["last_wake"] = now
        st["wake_interval"] = 0

        targets = self._wake_chats()
        if not targets:
            # 全都关掉时不每 tick 刷日志：这一轮算用掉了，下个间隔再看
            _log("wake: 没有开启主动唤醒的聊天，跳过这一轮")
            return False

        silent_ratio = int(cfg.get("silentRatio", 40))
        talk_enabled = bool(cfg.get("talkEnabled", True))
        silent = (not talk_enabled) or random.randint(1, 100) <= silent_ratio
        count = int(cfg.get("wakeActionCount", 3) or 1)
        actions = self._pick_actions("silent" if silent else "talk", count)
        action = actions[0] if actions else "随便待会儿"
        if len(actions) > 1:
            menu = "\n".join(f"{i+1}. {a}" for i, a in enumerate(actions))
            pick = f"抽到这几件事，想做几件做几件，也可以一件都不做：\n{menu}"
        else:
            pick = f"抽到：{action}"
        if silent:
            msg = f"（你自己待着，现在是 {hour} 点。{pick}。这只是你自己的时间，不用回消息。）"
        else:
            msg = f"（系统提醒：你醒着，现在是 {hour} 点。{pick}。看看老大在不在，想找他就发一句；不想也行。）"

        for _kind, _tid in targets:
            self._inject(msg, silent=silent, target=(_kind, _tid))
        self._log_activity("proactive", f"被叫醒（{hour}点，{'静默' if silent else '可发言'}）：{action}")
        try:
            try:
                self.store.conn.execute('UPDATE state SET chat_since_wake = 0')
                self.store.conn.commit()
            except Exception:
                pass
        except Exception:
            pass
        _log(f"wake: injected (hour={hour} silent={silent} action={action})")
        return True

    def _pick_actions(self, mode: str, n: int = 1) -> list:
        """从配置里抽 n 条动作。

        过滤掉「刷 B 站」这类动作：B 站有自己独立的节奏（_tick_bili），
        受 biliBrowsePerDay 限制。唤醒动作里再抽一次就会重复刷 ——
        今天 08:00 和 08:01 隔一分钟刷了两回，一天刷到 8 次远超上限 3 次，
        API 读取量翻倍，直接撞上 B站的 IP 级 412。
        """
        """抽 n 条动作给她选（不重复）。"""
        try:
            cfg = self._proactive_cfg()
            pool = cfg.get("silentActions" if mode == "silent" else "talkActions") or []
            if not pool:
                pool = cfg.get("silentActions") or ["随便待会儿"]
            # 动作可以是字符串（= 启用），也可以是 {text, enabled} 对象
            texts = []
            for a in pool:
                if isinstance(a, dict):
                    if a.get("enabled", True):
                        txt = str(a.get("text") or "").strip()
                        # 「刷B站」类动作排除掉：B站有独立节奏（_tick_bili，受
                        # biliBrowsePerDay 限制）。这里再抽一次就会重复刷 ——
                        # 今天 08:00 和 08:01 隔一分钟刷两回，一天刷到 8 次，
                        # API 读取翻倍，直接撞上 B站的 IP 级 412。
                        if txt and "bili_feed" not in txt:
                            texts.append(txt)
                elif isinstance(a, str) and a.strip() and "bili_feed" not in a:
                    texts.append(a)
            if not texts:
                return ["随便待会儿"]
            k = max(1, min(int(n or 1), len(texts)))
            if k == 1:
                return [random.choice(texts)]
            return random.sample(texts, k)
        except Exception:
            return ["随便待会儿"]

    # ---------- 2. B 站 ----------
    def _tick_bili(self, st: dict, now: float) -> bool:
        cfg = self._proactive_cfg()
        if not cfg.get("biliBrowseEnabled", True):
            return False

        hour = datetime.datetime.now().hour
        if hour < 8 or hour >= 23:
            return False

        per_day = int(cfg.get("biliBrowsePerDay", 3))
        count = int(st.get("bili_count", 0))
        if per_day <= 0 or count >= per_day:
            return False

        min_gap = max(5, int(cfg.get("biliMinGapMinutes", 60)))
        max_gap = max(min_gap, int(cfg.get("biliMaxGapMinutes", 240)))

        last = float(st.get("bili_last", 0))
        interval = float(st.get("bili_interval", 0))
        if interval <= 0:
            interval = (min_gap + random.randint(0, max_gap - min_gap)) * 60
            st["bili_interval"] = interval
            # 2026-11-06 修：原来只写 bili_interval，bili_last 还是初值 0，
            # 于是下一次检查 now-0 是天文数字、必然 > interval，8 点一到立刻刷一次
            # （看起来像「固定在 8 点刷」）。这里把 last 定成 now，
            # 让第一次也必须等满一个随机间隔。
            if not last:
                st["bili_last"] = now
            _log(f"bili: next nudge in {int(interval // 60)} min")
            return True
        if now - last < interval:
            return False

        st["bili_last"] = now
        st["bili_interval"] = 0
        st["bili_count"] = count + 1
        # 2026-11-06：这条以前是「抽到：刷 B 站 + 五条指令」——整段祈使句塞进唤醒消息，
        # 她会把它当任务清单逐条执行（刷 → 写 thought → 分享 → 评论 → @主人），
        # 所以每次都报告、每次都 @主人。
        # 参照 ssamurias/dsh-fish 的做法：叫醒只给处境，做法常驻在人格的【平常会做的事】里。
        # 这里只留一句内心状态，刷不刷、看不看、说不说，全由她自己决定。
        msg = f"（现在 {hour} 点。你自己待着，这会儿有点想上 B 站逛逛。）"
        self._inject(msg, silent=False)
        _log(f"bili: nudged model ({count + 1}/{per_day} today)")
        return True

    def _tieba_cfg(self) -> dict:
        try:
            with open(os.path.join(self.data_dir, "tieba.json"), encoding="utf-8") as f:
                c = json.load(f)
                return c if isinstance(c, dict) else {}
        except Exception:
            return {}

    def _tick_tieba(self, st: dict, now: float) -> bool:
        """贴吧独立节奏：到点就注入一句「想去贴吧看看」，逛不逛她自己定。"""
        cfg = self._tieba_cfg()
        if not cfg.get("enabled") or not cfg.get("browseEnabled"):
            return False

        hour = datetime.datetime.now().hour
        if hour < 8 or hour >= 23:
            return False

        per_day = int(cfg.get("perDay", 4) or 4)
        count = int(st.get("tieba_count", 0))
        if per_day <= 0 or count >= per_day:
            return False

        min_gap = max(5, int(cfg.get("minGapMinutes", 120) or 120))
        max_gap = max(min_gap, int(cfg.get("maxGapMinutes", 480) or 480))

        last = float(st.get("tieba_last", 0))
        interval = float(st.get("tieba_interval", 0))
        if interval <= 0:
            interval = (min_gap + random.randint(0, max_gap - min_gap)) * 60
            st["tieba_interval"] = interval
            if not last:
                st["tieba_last"] = now
            _log(f"tieba: next nudge in {int(interval // 60)} min")
            return True
        if now - last < interval:
            return False

        st["tieba_last"] = now
        st["tieba_interval"] = 0
        st["tieba_count"] = count + 1

        bars = cfg.get("bars") or []
        bar = random.choice(bars) if bars else ""
        where = f"{bar}吧" if bar else "贴吧"
        tail = "看到有意思的可以发给老大。" if cfg.get("shareEnabled", True) else "自己看看就行，别打扰他。"
        # 只给处境，不给步骤：会做什么写在「主动消息 → 她醒着能做什么」的动作池里，
        # 工具怎么用写在工具描述里。提示里再讲一遍就变成任务式指令了。
        msg = f"（现在 {hour} 点。你自己待着，这会儿有点想去{where}逛逛。{tail}）"
        self._inject(msg, silent=False)
        _log(f"tieba: nudged model ({count + 1}/{per_day} today, bar={bar or '-'})")
        return True

    # ---------- 3. 日记（23 点）----------
    def _tick_diary(self, st: dict, now: float) -> bool:
        today = datetime.date.today().isoformat()
        if st.get("diary_date") == today:
            return False
        dt = datetime.datetime.now()
        if dt.hour < 23:
            return False
        st["diary_date"] = today
        # 读当天素材，让她写日记时有东西可写
        extra = ""
        try:
            start = datetime.datetime.combine(datetime.date.today(), datetime.time.min).timestamp()
            rows = self.store.conn.execute(
                "SELECT kind, detail FROM activity_log WHERE ts >= ? ORDER BY ts", (start,)
            ).fetchall()
            kinds = {}
            for k, d in rows:
                kinds.setdefault(k, []).append(str(d or "")[:24])
            parts = []
            if kinds.get("bili"):
                parts.append(f"刷了 {len(kinds['bili'])} 次 B 站：" + "、".join(kinds["bili"][-3:]))
            if kinds.get("chat"):
                parts.append(f"跟老大聊了 {len(kinds['chat'])} 次")
            if kinds.get("proactive"):
                parts.append(f"被叫醒 {len(kinds['proactive'])} 次")
            if kinds.get("game"):
                parts.append(f"玩了 {len(kinds['game'])} 次游戏")
            if kinds.get("habit"):
                parts.append(f"有 {len(kinds['habit'])} 次习惯动作")
            # 顺便带上今天刷到的视频标题
            try:
                browsed = self.store.conn.execute(
                    "SELECT title FROM browsed WHERE ts >= ? ORDER BY ts DESC LIMIT 5", (start,)
                ).fetchall()
                if browsed:
                    parts.append("刷到的视频：" + "、".join(str(x[0])[:20] for x in browsed))
            except Exception:
                pass
            if parts:
                extra = "\n今天你：\n· " + "\n· ".join(parts) + "\n"
        except Exception:
            pass
        msg = f"（该写日记了，今天是 {dt.month} 月 {dt.day} 日。{extra}记两句今天的事吧，写给你自己看。）"
        self._inject(msg, silent=True)
        _log("diary: nudged model to write")
        return True

    # ---------- 4. 自我认知演化（22 点）----------
    # 台账里每一项怎么念给她听
    _FACT_LINES = {
        "turns":     lambda f: "一共聊了 %d 轮，你存下了 %d 句原话" % (f.get("turns", 0), f.get("l0_recent", 0)),
        "memory":    lambda f: "整理成 %d 条事件、%d 条约定、%d 条画像" % (f.get("l3", 0), f.get("l4", 0), f.get("l2", 0)),
        "expr":      lambda f: "从聊天里学到 %d 条说话方式" % f.get("expr", 0),
        "slang":     lambda f: "学会 %d 个词" % f.get("slang", 0),
        "browse":    lambda f: "刷了 %d 条 B 站" % f.get("browsed", 0),
        "tieba":     lambda f: "逛了 %d 次贴吧" % f.get("tieba", 0),
        "notes":     lambda f: "写了 %d 条便签" % f.get("notes", 0),
        "diary":     lambda f: "写了 %d 篇日记" % f.get("diary", 0),
        "tasks":     lambda f: "跟老大互相派的活，完成了 %d 件" % f.get("tasks_done", 0),
        "praise":    lambda f: "老大夸过你 %d 次" % f.get("praise", 0),
        "corrected": lambda f: "纠正过你 %d 次" % f.get("corrected", 0),
    }

    def _build_evolve_msg(self, cfg: dict) -> str:
        """拼那条「给自己记一笔」的提醒。带真实数字，不是空口反思。"""
        dt = datetime.datetime.now()
        want = cfg.get("selfFacts")
        if not isinstance(want, list) or not want:
            want = ["turns", "memory", "expr", "slang", "browse", "praise", "corrected"]

        facts = {}
        try:
            if hasattr(self.store, "self_facts"):
                facts = self.store.self_facts(days=60) or {}
        except Exception as e:
            _log(f"evolve: 台账算不出来（{e}），这次只给空提醒")

        lines = []
        for key in want:
            fn = self._FACT_LINES.get(str(key))
            if not fn:
                continue
            try:
                lines.append("- " + fn(facts))
            except Exception:
                continue

        existing = ""
        try:
            existing = str((self.store.get_persona() or {}).get("self_model") or "").strip()
        except Exception:
            pass
        n_exist = len([x for x in existing.split("\n") if x.strip()])
        try:
            max_lines = int(cfg.get("selfMaxLines", 10))
        except (TypeError, ValueError):
            max_lines = 10

        parts = ["（%d 月 %d 日，坐下想想自己。" % (dt.month, dt.day)]
        if lines:
            parts.append("这阵子的真实数据（不是你猜的）：")
            parts.extend(lines)
        parts.append("")
        if existing:
            parts.append("你现在对自己的认知是这样（%d 条，最多 %d 条）：" % (n_exist, max_lines))
            parts.append(existing)
            parts.append("")
            parts.append("想补一条、想推翻旧的、想说一个变化，都可以 —— 用 persona_update 写。"
                         "不写也行，明天还有。")
        else:
            parts.append("你还没写过自我认知。想写就用 persona_update。")
        parts.append("）")
        return "\n".join(parts)

    def _tick_evolve(self, st: dict, now: float) -> bool:
        cfg = self._proactive_cfg()
        if not cfg.get("selfEvolveEnabled", True):
            return False

        try:
            hour = int(cfg.get("selfEvolveHour", 22))
        except (TypeError, ValueError):
            hour = 22
        hour = max(0, min(23, hour))

        today = datetime.date.today().isoformat()
        try:
            per_day = int(cfg.get("selfEvolvePerDay", 1))
        except (TypeError, ValueError):
            per_day = 1
        per_day = max(1, min(3, per_day))

        done = int(st.get("evolve_count", 0)) if st.get("evolve_date") == today else 0
        if done >= per_day:
            return False

        dt = datetime.datetime.now()
        if done == 0:
            # 第一轮：过了配置的钟点才提醒
            if dt.hour < hour:
                return False
        else:
            # 后续轮：跟上一轮至少隔 3 小时，别连着催
            last = float(st.get("evolve_last", 0))
            if now - last < 3 * 3600:
                return False

        st["evolve_date"] = today
        st["evolve_count"] = done + 1
        st["evolve_last"] = now
        msg = self._build_evolve_msg(cfg)
        self._inject(msg, silent=True)
        _log("evolve: nudged (%d/%d), msg %d chars" % (done + 1, per_day, len(msg)))
        return True

    # ---------- 工具 ----------
    def _owner_qq(self) -> int:
        """主人的 QQ 号。

        必须是真实号：原来 _inject() 里写死 user_id: 0，唤醒跑完、话也生成了，
        但 onebot 回复时发给「QQ 号 0」，QQ 直接拒：
            final send failed: OneBot action failed (retcode 1400): user_id: must be >= 1
        结果所有服务内唤醒的回复一条都没发出去。
        """
        cfg_home = os.environ.get("HOME", "/home/ubuntu")
        if cfg_home.rstrip("/") == "/home/ubuntu":
            cfg = "/home/ubuntu/.dsh/profiles/web/cordis.patch.yml"
        else:
            cfg = os.path.join(cfg_home, "profiles/qq2/cordis.patch.yml")
        try:
            import yaml
            for item in (yaml.safe_load(open(cfg, encoding="utf-8")) or []):
                if isinstance(item, dict) and item.get("id") == "dsh-onebot":
                    for u in ((item.get("config") or {}).get("adminUsers") or []):
                        s = str(u).strip()
                        if s.isdigit() and len(s) >= 5:
                            return int(s)
        except Exception:
            pass
        env = os.environ.get("CMEM_OWNER_QQ", "").strip()
        if env.isdigit() and len(env) >= 5:
            return int(env)
        return 3169341724

    def _inject(self, msg: str, silent: bool = False, target=None) -> None:
        """往 qq-inject.jsonl 写一条合成消息。

        target=(kind, id)：kind 是 private/group。不传就发给主人私聊（老行为）。
        群里唤醒时 user_id 仍是主人号，让 onebot 知道这条是「谁的那一轮」。
        """
        path = self.inject_path
        if not path:
            _log("inject: no CMEM_INJECT_PATH, skip (no QQ channel)")
            return
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            # 用真实 QQ 号！0 会让回复发不出去（retcode 1400）
            kind, tid = (target if target else ("private", str(self._owner_qq())))
            owner = self._owner_qq()
            uid = int(tid)
            ev = {
                "post_type": "message",
                "message_type": "group" if kind == "group" else "private",
                "sub_type": "normal" if kind == "group" else "friend",
                "message_id": int(time.time() * 1000) % 1000000000,
                "user_id": (owner if kind == "group" else uid),
                "message": msg,
                "raw_message": msg,
                "time": int(time.time()),
                "self_id": 0,
                "silent": silent,
                # synthetic：这条是系统自己醒的，不是老大发的。onebot 会据此把
                # source.kind 标成 system:nudge，dsh-remembers 就不会当成用户原话。
                "synthetic": True,
                # 昵称留空：写「系统」会被 _touch_profile 存进 profiles.name，
                # 把老大真实的画像名字覆盖掉（2026-10-27 线上实测踩过）。
                "sender": {"user_id": (owner if kind == "group" else uid), "nickname": ""},
            }
            if kind == "group":
                ev["group_id"] = uid
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        except Exception as e:
            _log(f"inject failed: {e}")

    def _log_activity(self, kind: str, detail: str, thought: str = "") -> None:
        try:
            self.store.log_activity(kind, detail, thought)
        except Exception:
            pass

    # ---------- 调试 ----------
    def run_once(self) -> dict:
        before = self._load_state()
        self._tick()
        after = self._load_state()
        diff = {k: v for k, v in after.items() if before.get(k) != v}
        return {"ok": True, "changed": diff}
