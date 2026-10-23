"""在线备份 / 恢复 / 列表。

SQLite 在 WAL 模式下直接 cp 文件可能拿到不一致的快照，所以用 sqlite3 的
backup API 做在线备份——不影响正在读写的服务进程。

用法（在容器里跑）：
    python backup.py backup                 # 备份到 /data/backups/
    python backup.py backup --keep 7        # 只保留最近 7 份
    python backup.py list
    python backup.py restore <文件名>        # 会先把当前库另存为 pre-restore-*
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
import time

DATA_DIR = os.environ.get("CMEM_DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "memories.db")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")


def _human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024.0
    return f"{n:.1f}TB"


def cmd_backup(keep: int) -> int:
    if not os.path.exists(DB_PATH):
        print(f"没有数据库：{DB_PATH}")
        return 1
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = os.path.join(BACKUP_DIR, f"memories-{stamp}.db")

    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(out)
    try:
        src.backup(dst)          # 在线一致性备份
    finally:
        dst.close()
        src.close()

    size = os.path.getsize(out)
    print(f"已备份 → {out} ({_human(size)})")

    # 完整性自检
    check = sqlite3.connect(out)
    try:
        row = check.execute("PRAGMA integrity_check").fetchone()
        n = check.execute("SELECT COUNT(*) FROM memory").fetchone()[0]
    finally:
        check.close()
    if row[0] != "ok":
        print(f"⚠️ 备份完整性检查失败：{row[0]}")
        return 1
    print(f"完整性 OK，记忆 {n} 条")

    if keep > 0:
        files = sorted(
            (f for f in os.listdir(BACKUP_DIR) if f.startswith("memories-") and f.endswith(".db")),
            reverse=True,
        )
        for old in files[keep:]:
            os.remove(os.path.join(BACKUP_DIR, old))
            print(f"已清理旧备份 {old}")
    return 0


def cmd_list() -> int:
    if not os.path.isdir(BACKUP_DIR):
        print("还没有备份")
        return 0
    files = sorted(f for f in os.listdir(BACKUP_DIR) if f.endswith(".db"))
    if not files:
        print("还没有备份")
        return 0
    for f in files:
        p = os.path.join(BACKUP_DIR, f)
        print(f"{f}  {_human(os.path.getsize(p))}  {time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime(p)))}")
    return 0


def cmd_restore(name: str) -> int:
    src_path = os.path.join(BACKUP_DIR, os.path.basename(name))
    if not os.path.exists(src_path):
        print(f"找不到备份：{src_path}")
        return 1
    if os.path.exists(DB_PATH):
        stamp = time.strftime("%Y%m%d-%H%M%S")
        safety = os.path.join(BACKUP_DIR, f"pre-restore-{stamp}.db")
        os.makedirs(BACKUP_DIR, exist_ok=True)
        shutil.copy2(DB_PATH, safety)
        print(f"当前库已另存：{safety}")
    shutil.copy2(src_path, DB_PATH)
    for suffix in ("-wal", "-shm"):
        p = DB_PATH + suffix
        if os.path.exists(p):
            os.remove(p)
    print(f"已恢复：{src_path} → {DB_PATH}")
    print("重启服务生效：docker compose restart")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="companion-memory 备份工具")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backup", help="在线备份")
    b.add_argument("--keep", type=int, default=14, help="保留最近 N 份，0 = 不清理")
    sub.add_parser("list", help="列出备份")
    r = sub.add_parser("restore", help="从备份恢复")
    r.add_argument("name", help="备份文件名")

    args = ap.parse_args()
    if args.cmd == "backup":
        return cmd_backup(args.keep)
    if args.cmd == "list":
        return cmd_list()
    if args.cmd == "restore":
        return cmd_restore(args.name)
    return 1


if __name__ == "__main__":
    sys.exit(main())
