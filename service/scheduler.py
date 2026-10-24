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
            changed = True

        if self._tick_wake(st, now):
            changed = True
        if self._tick_bili(st, now):
            changed = True

        if changed:
            self._save_state(st)

    # ---------- 读配置 ----------
    def _proactive_cfg(self) -> dict:
        try:
            return self.store._load_proactive() if hasattr(self.store, "_load_proactive") else {}
        except Exception:
            return {}

    # ---------- 1. 唤醒 ----------
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

        silent_ratio = int(cfg.get("silentRatio", 40))
        talk_enabled = bool(cfg.get("talkEnabled", True))
        silent = (not talk_enabled) or random.randint(1, 100) <= silent_ratio
        action = self._pick_action("silent" if silent else "talk")
        if silent:
            msg = f"（你自己待着，现在是 {hour} 点。抽到：{action}。想做就做，这只是你自己的时间，不用回消息。）"
        else:
            msg = f"（系统提醒：你醒着，现在是 {hour} 点。抽到：{action}。看看老大在不在，想找他就发一句；不想也行。）"

        self._inject(msg, silent=silent)
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

    def _pick_action(self, mode: str) -> str:
        try:
            cfg = self._proactive_cfg()
            pool = cfg.get("silentActions" if mode == "silent" else "talkActions") or []
            if not pool:
                pool = cfg.get("silentActions") or ["随便待会儿"]
            return random.choice(pool)
        except Exception:
            return "随便待会儿"

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
            _log(f"bili: next nudge in {int(interval // 60)} min")
            return True
        if now - last < interval:
            return False

        st["bili_last"] = now
        st["bili_interval"] = 0
        st["bili_count"] = count + 1
        msg = f"（你自己待着，现在是 {hour} 点。想去 B 站逛逛吗？不想去就干别的，没事。）"
        self._inject(msg, silent=False)
        _log(f"bili: nudged model ({count + 1}/{per_day} today)")
        return True

    # ---------- 工具 ----------
    def _inject(self, msg: str, silent: bool = False) -> None:
        path = self.inject_path
        if not path:
            _log("inject: no CMEM_INJECT_PATH, skip (no QQ channel)")
            return
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            ev = {
                "post_type": "message",
                "message_type": "private",
                "sub_type": "friend",
                "message_id": int(time.time() * 1000) % 1000000000,
                "user_id": 0,
                "message": msg,
                "raw_message": msg,
                "time": int(time.time()),
                "self_id": 0,
                "silent": silent,
                "sender": {"user_id": 0, "nickname": "系统"},
            }
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
