#!/usr/bin/env bash
# companion-memory 一键部署（Linux VPS）—— **Docker 方式，备选**
#
# 默认路径是裸跑：sudo ./deploy-native.sh（见 ../docs/NATIVE-DEPLOY.md）。
# 这个脚本只在「拉镜像和装依赖都通畅」时才值得用；拉不到 registry-1.docker.io 或
# pypi.org 的环境请直接走裸跑，配镜像源比省下的麻烦多。
#
# 做什么：检查环境 → 生成鉴权 token → 建目录 → 构建镜像 → 启动 → 等健康检查
# 不做什么：不自动装 Docker（权限大、风险高），只检测并给命令；不动防火墙规则
#
# 用法：
#   ./deploy.sh                    # 本地回环，无鉴权
#   ./deploy.sh --public           # 对外暴露，自动生成 token 并要求填写
#   ./deploy.sh --offline img.tar  # 离线：从镜像 tar 导入后启动
set -euo pipefail

cd "$(dirname "$0")"

PUBLIC=0
OFFLINE_TAR=""
for arg in "$@"; do
  case "$arg" in
    --public) PUBLIC=1 ;;
    --offline) ;;  # 处理下一个参数
    *.tar) OFFLINE_TAR="$arg" ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

info() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. 环境检查
# ---------------------------------------------------------------------------
info "检查 Docker"
command -v docker >/dev/null 2>&1 || die "没有 docker。装一个再回来：
  curl -fsSL https://get.docker.com | sh     # 官方
  # 国内可用：curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun"

if ! docker compose version >/dev/null 2>&1; then
  die "docker compose 不可用。请安装 docker-compose-plugin（apt install docker-compose-plugin）"
fi
docker info >/dev/null 2>&1 || die "当前用户连不上 docker daemon。把用户加进 docker 组：sudo usermod -aG docker \$USER && newgrp docker"

AVAIL_KB=$(df -Pk . | awk 'NR==2 {print $4}')
[ "$AVAIL_KB" -ge 512000 ] || warn "磁盘剩余 $((AVAIL_KB/1024)) MB，建议留 1GB 以上（镜像 + 记忆数据）"
MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_MB" -gt 0 ] && [ "$MEM_MB" -lt 400 ]; then
  warn "内存只有 ${MEM_MB}MB，numpy 可能吃力；建议 ≥512MB，或改用纯 BM25（不填 embedding）"
fi

# ---------------------------------------------------------------------------
# 2. .env
# ---------------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  info "已从 .env.example 生成 .env（权限 600）"
fi

# 生成鉴权 token（只在对外暴露时强制）
if [ "$PUBLIC" = "1" ]; then
  if grep -qE '^CMEM_AUTH_TOKEN=.*[^[:space:]]' .env 2>/dev/null; then
    info "已有 CMEM_AUTH_TOKEN，沿用"
  else
    TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
    if grep -qE '^CMEM_AUTH_TOKEN=' .env; then
      sed -i "s#^CMEM_AUTH_TOKEN=.*#CMEM_AUTH_TOKEN=${TOKEN}#" .env
    else
      printf '\nCMEM_AUTH_TOKEN=%s\n' "$TOKEN" >> .env
    fi
    chmod 600 .env
    warn "已生成新 token，DSH 侧要用同一个：${TOKEN}"
  fi
fi

EMBED_BASE=$(grep -E '^CMEM_EMBED_BASE=' .env | cut -d= -f2- || true)
if [ -z "${EMBED_BASE}" ]; then
  warn "未配置 CMEM_EMBED_BASE —— 将以纯 BM25 运行（无语义召回，换种说法会记不住）"
fi

# ---------------------------------------------------------------------------
# 3. 数据目录
# ---------------------------------------------------------------------------
mkdir -p data
chmod 700 data
info "数据目录：$(pwd)/data （备份 = 拷这个目录）"

# ---------------------------------------------------------------------------
# 4. 公网暴露时改端口绑定
# ---------------------------------------------------------------------------
if [ "$PUBLIC" = "1" ]; then
  if grep -q '"127.0.0.1:8080:8080"' docker-compose.yml; then
    sed -i 's#"127.0.0.1:8080:8080"#"0.0.0.0:8080:8080"#' docker-compose.yml
    warn "已把端口改成 0.0.0.0:8080 —— 务必确认已经设了 CMEM_AUTH_TOKEN，并考虑只放行给 DSH 所在 IP"
  fi
fi

# ---------------------------------------------------------------------------
# 5. 构建 / 导入并启动
# ---------------------------------------------------------------------------
if [ -n "$OFFLINE_TAR" ]; then
  [ -f "$OFFLINE_TAR" ] || die "找不到镜像包：$OFFLINE_TAR"
  info "导入离线镜像 $OFFLINE_TAR"
  docker load -i "$OFFLINE_TAR"
else
  info "构建镜像（首次约 1-3 分钟）"
  docker compose build
fi

info "启动"
docker compose up -d

# ---------------------------------------------------------------------------
# 6. 等健康
# ---------------------------------------------------------------------------
info "等待健康检查"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo
    curl -s http://127.0.0.1:8080/health | python3 -m json.tool 2>/dev/null || curl -s http://127.0.0.1:8080/health
    echo
    info "部署完成 ✅"
    info "日志：docker compose logs -f"
    info "备份：docker compose exec companion-memory python backup.py backup"
    exit 0
  fi
  sleep 1
done

warn "30 秒内没等到健康响应，看日志："
docker compose logs --tail 50
exit 1
