#!/usr/bin/env bash
# 一键装备份定时任务（幂等，重复跑只更新不叠加）
#
#   ./install-cron.sh                 # 每天 04:10，保留 14 份
#   SCHEDULE="30 3 * * *" ./install-cron.sh
#   KEEP=30 ./install-cron.sh
#   ./install-cron.sh --remove        # 卸掉
#
# 装之前会先真跑一次备份，跑不通就不写 cron——避免装了个永远失败的定时任务。
set -euo pipefail

cd "$(dirname "$0")"

MARK="# dsh-remembers-backup"
SCHEDULE="${SCHEDULE:-10 4 * * *}"
KEEP="${KEEP:-14}"
LOG="/var/log/dsh-remembers-backup.log"

info() { printf '\033[36m[cron]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v crontab >/dev/null 2>&1 || die "没有 crontab。装 cron：
  Debian/Ubuntu: apt install -y cron && systemctl enable --now cron
  Alpine:        apk add busybox-initscripts"

CURRENT="$(crontab -l 2>/dev/null || true)"

# ---- 卸载 ----------------------------------------------------------------
if [ "${1:-}" = "--remove" ]; then
  printf '%s\n' "$CURRENT" | grep -v -F "$MARK" | crontab -
  info "已移除备份定时任务"
  exit 0
fi

# ---- 先验证备份真的能跑 ---------------------------------------------------
info "先手动跑一次备份（验证服务和脚本都正常）"
if ! docker compose exec -T companion-memory python backup.py backup --keep "$KEEP"; then
  die "备份失败，没写 cron。先排查：docker compose logs --tail 50"
fi

# ---- 幂等写入 ------------------------------------------------------------
LINE="${SCHEDULE} cd $(pwd) && docker compose exec -T companion-memory python backup.py backup --keep ${KEEP} >> ${LOG} 2>&1 ${MARK}"

FILTERED="$(printf '%s\n' "$CURRENT" | grep -v -F "$MARK" || true)"
{
  [ -n "$FILTERED" ] && printf '%s\n' "$FILTERED"
  printf '%s\n' "$LINE"
} | crontab -

info "已写入定时任务："
crontab -l | grep -F "$MARK" | sed 's/^/    /'

# ---- 日志文件（非 root 时可能写不了，给个提示而不是失败） -------------------
if [ ! -e "$LOG" ]; then
  (sudo touch "$LOG" && sudo chown "$(id -u):$(id -g)" "$LOG") 2>/dev/null \
    || warn "建不了 $LOG（非 root）。cron 会写到用户邮箱或 syslog，或者把 LOG 改成你能写的位置。"
fi

echo
info "验证方法：过一天再看"
echo "    docker compose exec companion-memory python backup.py list"
echo "    或 tail -20 ${LOG}"
