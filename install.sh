#!/usr/bin/env bash
# dsh-remembers 一键安装（Linux / macOS / WSL）
#
#   ./install.sh                     # 装插件 + 建 venv + 起服务（端口 8080）
#   ./install.sh --no-service        # 只装插件（服务已经跑着）
#   ./install.sh --no-plugin         # 只准备服务
#   ./install.sh --port 8081         # 换端口（写进 service/.env）
#   DSH_PROFILE=desktop ./install.sh # 装到别的 profile
#
# 不做的事：不装 Docker、不改防火墙、不动已有记忆数据。
set -euo pipefail

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DIR="$KIT_DIR/service"
VENV_DIR="$KIT_DIR/venv"
DSH_PROFILE="${DSH_PROFILE:-web}"
PORT="${CMEM_PORT:-8080}"
DO_PLUGIN=1
DO_SERVICE=1

for arg in "$@"; do
  case "$arg" in
    --no-service) DO_SERVICE=0 ;;
    --no-plugin) DO_PLUGIN=0 ;;
    --port) shift; PORT="${1:-8080}" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

info() { printf '\033[36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. 插件（Node 侧）
# ---------------------------------------------------------------------------
if [ "$DO_PLUGIN" = "1" ]; then
  command -v node >/dev/null 2>&1 || die "没有 node。先装 Node.js >= 22.19"
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
  if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
    warn "Node $(node -v)，插件要求 >=22.19，可能起不来"
  fi
  node "$KIT_DIR/install.mjs" --profile "$DSH_PROFILE"
else
  info "跳过插件安装（--no-plugin）"
fi

# ---------------------------------------------------------------------------
# 2. 服务（Python 侧）
# ---------------------------------------------------------------------------
if [ "$DO_SERVICE" = "1" ]; then
  PY=""
  for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then
      ver=$("$cand" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)
      case "$ver" in
        3.1[0-9]|3.[2-9][0-9]) PY="$cand"; break ;;
      esac
    fi
  done
  [ -n "$PY" ] || die "没找到 Python >= 3.10"
  info "Python: $($PY --version 2>&1)"

  if [ ! -x "$VENV_DIR/bin/python" ]; then
    info "创建 venv: $VENV_DIR"
    "$PY" -m venv "$VENV_DIR"
  fi
  info "安装依赖（只有 numpy）"
  "$VENV_DIR/bin/pip" install -q --disable-pip-version-check -r "$SERVICE_DIR/requirements.txt"

  ENV_FILE="$SERVICE_DIR/.env"
  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<EOF
# dsh-remembers 服务配置（KEY=VALUE，服务启动时读）
CMEM_HOST=127.0.0.1
CMEM_PORT=$PORT
CMEM_DATA_DIR=$SERVICE_DIR/data
CMEM_EXTRACT=1

# 对话模型（抽取记忆、写日记、挑语料都要它）
CMEM_LLM_BASE=https://api.deepseek.com/v1
CMEM_LLM_MODEL=deepseek-chat
CMEM_LLM_KEY=

# 向量模型（可选；不填就退化成纯 BM25 关键词检索）
CMEM_EMBED_BASE=
CMEM_EMBED_MODEL=
CMEM_EMBED_KEY=
EOF
    chmod 600 "$ENV_FILE"
    info "已生成 $ENV_FILE（填 CMEM_LLM_KEY 才有抽取）"
  else
    info "沿用已有 $ENV_FILE"
  fi

  ENDPOINT="http://127.0.0.1:$PORT"
  if curl -fsS "$ENDPOINT/health" >/dev/null 2>&1; then
    info "服务已在 $ENDPOINT 运行"
  else
    info "启动服务（日志: $SERVICE_DIR/data/server.log）"
    mkdir -p "$SERVICE_DIR/data"
    ( cd "$SERVICE_DIR" && nohup "$VENV_DIR/bin/python" server.py >> "$SERVICE_DIR/data/server.log" 2>&1 & )
    for _ in $(seq 1 30); do
      sleep 1
      if curl -fsS "$ENDPOINT/health" >/dev/null 2>&1; then break; fi
    done
    if curl -fsS "$ENDPOINT/health" >/dev/null 2>&1; then
      info "服务已就绪: $ENDPOINT"
    else
      warn "服务还没通，看 $SERVICE_DIR/data/server.log"
    fi
  fi

  if command -v systemctl >/dev/null 2>&1; then
    info "要开机自启 + 崩溃重启，跑一次：sudo bash service/deploy/deploy-native.sh"
  fi
else
  info "跳过服务安装（--no-service）"
fi

cat <<EOF

────────────────────────────────────────
装完了。

  1. 填 key：$SERVICE_DIR/.env  →  CMEM_LLM_KEY=sk-xxx（改完重启服务）
  2. 重启 DSH：dsh --profile $DSH_PROFILE
  3. 打开左边栏「插件 → 她的记忆」；「记忆服务」卡片里能改模型、看健康状态
  4. 可选：B 站 / 贴吧 / QQ 通道需要额外组件，见 docs/features/
────────────────────────────────────────
EOF
