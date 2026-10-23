#!/usr/bin/env bash
# 一键装备份定时任务（幂等，重复跑只更新不叠加）
#
#   ./install-cron.sh                  # 自动检测 Docker / 裸跑
#   ./install-cron.sh --docker         # 强制 Docker 模式
#   sudo ./install-cron.sh --native    # 强制裸跑模式（要 root，因为要写运行用户的 crontab）
#   ./install-cron.sh --remove         # 卸掉
#   SCHEDULE="30 3 * * *" KEEP=30 ./install-cron.sh
#
# 装之前会先真跑一次备份，跑不通就不写 cron——避免装了个永远失败的定时任务。
set -euo pipefail

cd "$(dirname "$0")"
SERVICE_DIR="$(pwd)"
ROOT_DIR="$(cd .. && pwd)"

MARK="# dsh-remembers-backup"
SCHEDULE="${SCHEDULE:-10 4 * * *}"
KEEP="${KEEP:-14}"
LOG="/var/log/dsh-remembers-backup.log"

MODE=""
REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --docker) MODE="docker"; shift ;;
    --native) MODE="native"; shift ;;
    --remove) REMOVE=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

info() { printf '\033[36m[cron]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v crontab >/dev/null 2>&1 || die "没有 crontab。装 cron：
  Debian/Ubuntu: apt install -y cron && systemctl enable --now cron
  Alpine:        apk add busybox-initscripts"

# ---------------------------------------------------------------------------
# 模式检测：容器在跑就是 Docker，venv 在就是裸跑
# ---------------------------------------------------------------------------
if [ -z "$MODE" ]; then
  if command -v docker >/dev/null 2>&1 \
     && docker compose ps --format '{{.Name}}' 2>/dev/null | grep -qx 'companion-memory'; then
    MODE="docker"
  elif [ -x "$ROOT_DIR/venv/bin/python" ]; then
    MODE="native"
  else
    die "没检测到运行中的服务。
  Docker 模式要求容器名是 companion-memory；
  裸跑模式要求 $ROOT_DIR/venv/bin/python 存在（先跑 ./deploy-native.sh）。
  也可以显式指定：--docker 或 --native"
  fi
fi
info "模式：$MODE"

# ---------------------------------------------------------------------------
# 各模式的命令差异
# ---------------------------------------------------------------------------
RUN_USER="$(id -un)"
case "$MODE" in
  docker)
    BACKUP_CMD="docker compose exec -T companion-memory python backup.py backup --keep $KEEP"
    LIST_CMD="docker compose exec companion-memory python backup.py list"
    CRON_WRITE="crontab"
    CRON_READ="crontab -l"
    ;;
  native)
    VENV_PY="$ROOT_DIR/venv/bin/python"
    [ -x "$VENV_PY" ] || die "找不到 $VENV_PY —— 先跑 ./deploy-native.sh"
    DATA_DIR="$SERVICE_DIR/data"
    [ -d "$DATA_DIR" ] || die "找不到数据目录 $DATA_DIR —— 先跑 ./deploy-native.sh"

    # 运行用户从 systemd unit 里读，这样和正在跑的服务一定一致
    UNIT="/etc/systemd/system/dsh-remembers.service"
    if [ -z "${CMEM_USER:-}" ] && [ -f "$UNIT" ]; then
      CMEM_USER=$(awk -F= '/^User=/ {print $2; exit}' "$UNIT" | tr -d '[:space:]' || true)
    fi
    RUN_USER="${CMEM_USER:-cmem}"

    [ "$(id -u)" -eq 0 ] || die "裸跑模式要写运行用户 $RUN_USER 的 crontab，请 sudo 跑：
  sudo ./install-cron.sh --native"

    # backup.py 的 DATA_DIR 默认是 /data（那是容器里的路径），裸跑必须显式给它。
    # 不给的话它会去 /data 找库，找不到就直接失败。
    BACKUP_CMD="cd $SERVICE_DIR && CMEM_DATA_DIR=$DATA_DIR $VENV_PY backup.py backup --keep $KEEP"
    LIST_CMD="CMEM_DATA_DIR=$DATA_DIR $VENV_PY $SERVICE_DIR/backup.py list"
    CRON_WRITE="crontab -u $RUN_USER"
    CRON_READ="crontab -u $RUN_USER -l"
    ;;
  *)
    die "未知模式：$MODE"
    ;;
esac

EFFECTIVE_CRON_USER="$RUN_USER"
[ "$MODE" = "docker" ] && EFFECTIVE_CRON_USER="$(id -un)"
info "定时任务将以用户「$EFFECTIVE_CRON_USER」的身份运行"

CURRENT="$($CRON_READ 2>/dev/null || true)"

# ---------------------------------------------------------------------------
# 卸载
# ---------------------------------------------------------------------------
if [ "$REMOVE" = "1" ]; then
  if [ -z "$CURRENT" ]; then
    info "没有 crontab 条目，无需卸载"
    exit 0
  fi
  printf '%s\n' "$CURRENT" | grep -v -F "$MARK" | $CRON_WRITE -
  info "已移除备份定时任务（$MODE 模式）"
  exit 0
fi

# ---------------------------------------------------------------------------
# 先验证备份真的能跑
# ---------------------------------------------------------------------------
info "先手动跑一次备份（验证服务和脚本都正常）"
if ! eval "$BACKUP_CMD" >/dev/null; then
  cat >&2 <<EOF
[error] 备份失败，没写 cron。先排查看这里：
  Docker: docker compose logs --tail 50
  裸跑:   journalctl -u dsh-remembers -n 50
  手动试: $BACKUP_CMD
EOF
  exit 1
fi
info "备份跑通了"

# ---------------------------------------------------------------------------
# 幂等写入
# ---------------------------------------------------------------------------
LINE="${SCHEDULE} ${BACKUP_CMD} >> ${LOG} 2>&1 ${MARK}"

FILTERED="$(printf '%s\n' "$CURRENT" | grep -v -F "$MARK" || true)"
{
  [ -n "$FILTERED" ] && printf '%s\n' "$FILTERED"
  printf '%s\n' "$LINE"
} | $CRON_WRITE -

info "已写入定时任务："
$CRON_READ | grep -F "$MARK" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# 日志文件
# ---------------------------------------------------------------------------
if [ ! -e "$LOG" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    touch "$LOG" && chown "$EFFECTIVE_CRON_USER" "$LOG" 2>/dev/null \
      || warn "建不了 $LOG，cron 的输出会进 syslog"
  else
    (sudo touch "$LOG" && sudo chown "$EFFECTIVE_CRON_USER" "$LOG") 2>/dev/null \
      || warn "建不了 $LOG（非 root）。cron 会写到用户邮箱或 syslog，或者把 LOG 改成你能写的位置。"
  fi
fi

echo
info "验证方法：过一天再看"
echo "    $LIST_CMD"
echo "    或 tail -20 ${LOG}"
