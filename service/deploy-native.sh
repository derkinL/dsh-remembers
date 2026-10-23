#!/usr/bin/env bash
# companion-memory 裸跑部署（Ubuntu / Debian，不用 Docker）
#
# ⚠️ 未实测：这份脚本是在 Windows 上写的，没在真实 Ubuntu 上跑过一遍（本地没有
#    systemd 可用）。逻辑照 docs/NATIVE-DEPLOY.md 手写的步骤来，但第一次跑请盯着
#    每一步输出，尤其「等待健康检查」那一段。Docker 才是走过验证的路径。
#
# 做什么：检查环境 → 建 venv 装 numpy → 建系统用户 → 建数据目录 → 写 systemd unit → 启动 → 等健康
# 不做什么：不装 Docker、不装 python、不动防火墙规则
#
# 用法：
#   sudo ./deploy-native.sh                  # 默认以 cmem 用户运行，端口取 .env
#   sudo ./deploy-native.sh --user app       # 换个运行用户
#   sudo ./deploy-native.sh --port 8081      # 换端口（同时写进 .env）
#
# 幂等：重复跑只会更新 unit 和依赖，不会动 data/ 里的记忆，也不会覆盖已填的 .env。
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SERVICE_DIR/.." && pwd)"
VENV_DIR="$ROOT_DIR/venv"
DATA_DIR="$SERVICE_DIR/data"
UNIT_NAME="dsh-remembers"
UNIT_PATH="/etc/systemd/system/${UNIT_NAME}.service"
RUN_USER="cmem"
PORT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --user) RUN_USER="${2:-cmem}"; shift 2 ;;
    --port) PORT="${2:-8080}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

info() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. 权限与环境
# ---------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "要写 /etc/systemd 和建系统用户，请用 sudo 跑：sudo $0"

command -v systemctl >/dev/null 2>&1 || die "没有 systemd。这台机器不适合裸跑，改用 Docker（./deploy.sh）"
command -v curl >/dev/null 2>&1 || die "没有 curl：apt install -y curl"

command -v python3 >/dev/null 2>&1 || die "没有 python3。apt install -y python3 python3-venv"
PY_VER=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' \
  || die "python3 是 $PY_VER，需要 ≥3.10"
python3 -c 'import venv' 2>/dev/null || die "缺 venv 模块：apt install -y python3-venv"

MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_MB" -gt 0 ] && [ "$MEM_MB" -lt 400 ]; then
  warn "内存只有 ${MEM_MB}MB，numpy 可能吃力；建议 ≥512MB，或改用纯 BM25（不填 embedding）"
fi

# ---------------------------------------------------------------------------
# 2. 运行用户（记忆是隐私，不用 root 跑）
# ---------------------------------------------------------------------------
if id -u "$RUN_USER" >/dev/null 2>&1; then
  info "运行用户已存在：$RUN_USER"
else
  useradd -r -s /usr/sbin/nologin -d "$ROOT_DIR" "$RUN_USER" \
    || die "建用户 $RUN_USER 失败"
  info "已创建系统用户：$RUN_USER"
fi

# ---------------------------------------------------------------------------
# 3. venv 与依赖
# ---------------------------------------------------------------------------
if [ ! -x "$VENV_DIR/bin/python" ]; then
  info "创建 venv：$VENV_DIR"
  python3 -m venv "$VENV_DIR" || die "创建 venv 失败"
fi

info "安装依赖（只有 numpy）"
"$VENV_DIR/bin/pip" install --quiet --disable-pip-version-check -r "$SERVICE_DIR/requirements.txt" \
  || die "装依赖失败。没外网的话先配镜像，或手动 pip install numpy"
"$VENV_DIR/bin/python" -c 'import numpy' || die "numpy 装上了但 import 不了，检查 venv"

# ---------------------------------------------------------------------------
# 4. 配置 .env
# ---------------------------------------------------------------------------
cd "$SERVICE_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
  info "已从 .env.example 生成 .env（权限 600，里面是密钥）"
fi
chmod 600 .env

if [ -n "$PORT" ]; then
  if grep -qE '^CMEM_PORT=' .env; then
    sed -i "s#^CMEM_PORT=.*#CMEM_PORT=${PORT}#" .env
  else
    printf '\nCMEM_PORT=%s\n' "$PORT" >> .env
  fi
  info "端口已写入 .env：$PORT"
fi

EMBED_BASE=$(grep -E '^CMEM_EMBED_BASE=' .env | cut -d= -f2- || true)
[ -n "${EMBED_BASE}" ] || warn "未配置 CMEM_EMBED_BASE —— 将以纯 BM25 运行（无语义召回，换个说法会记不住）"
LLM_BASE=$(grep -E '^CMEM_LLM_BASE=' .env | cut -d= -f2- || true)
[ -n "${LLM_BASE}" ] || warn "未配置 CMEM_LLM_BASE —— episode 摘要会一直 degraded，前情提要这条线不通"

# ---------------------------------------------------------------------------
# 5. 数据目录
# ---------------------------------------------------------------------------
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
info "数据目录：$DATA_DIR （备份 = 拷这个目录）"

# ---------------------------------------------------------------------------
# 6. systemd unit
# ---------------------------------------------------------------------------
info "写 systemd unit：$UNIT_PATH"
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=companion-memory (dsh-remembers 记忆服务)
Documentation=file://$ROOT_DIR/docs/NATIVE-DEPLOY.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$SERVICE_DIR

# .env 在这里注入。server.py 自己不读 .env，只认环境变量和 data/config.json。
EnvironmentFile=$SERVICE_DIR/.env
Environment=CMEM_DATA_DIR=$DATA_DIR
Environment=CMEM_HOST=127.0.0.1
Environment=PYTHONDONTWRITEBYTECODE=1

ExecStart=$VENV_DIR/bin/python $SERVICE_DIR/server.py
Restart=on-failure
RestartSec=3

# 加固：只让 data 目录可写，其余全只读
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || warn "enable 失败（不影响本次启动，重启后可能不自启）"
systemctl restart "$UNIT_NAME"

# ---------------------------------------------------------------------------
# 7. 等健康
# ---------------------------------------------------------------------------
PORT_NOW=$(grep -E '^CMEM_PORT=' .env | cut -d= -f2- | tr -d '[:space:]' || true)
PORT_NOW="${PORT_NOW:-8080}"

info "等待健康检查（http://127.0.0.1:$PORT_NOW/health）"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT_NOW/health" >/dev/null 2>&1; then
    echo
    curl -s "http://127.0.0.1:$PORT_NOW/health" | python3 -m json.tool 2>/dev/null \
      || curl -s "http://127.0.0.1:$PORT_NOW/health"
    echo
    info "部署完成"
    info "状态：systemctl status $UNIT_NAME"
    info "日志：journalctl -u $UNIT_NAME -f"
    info "备份：sudo -u $RUN_USER $VENV_DIR/bin/python $SERVICE_DIR/backup.py backup"
    info "定时备份：sudo ./install-cron.sh --native"
    exit 0
  fi
  sleep 1
done

warn "30 秒内没等到健康响应，看日志："
journalctl -u "$UNIT_NAME" -n 40 --no-pager || true
exit 1
