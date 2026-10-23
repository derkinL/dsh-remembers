#!/usr/bin/env bash
# 离线打包：在能构建的机器上跑，产出一个可以 scp 到内网/无外网 VPS 的镜像包
#
#   ./offline-pack.sh
#   scp dsh-remembers-service.tar.gz user@vps:/opt/dsh-remembers/
#   ssh user@vps 'cd /opt/dsh-remembers/service && ./deploy.sh --offline companion-memory-image.tar.gz'
set -euo pipefail
cd "$(dirname "$0")"

TAR="dsh-remembers-service.tar"

echo "[pack] 构建镜像"
docker compose build

echo "[pack] 导出 $TAR"
docker save dsh-remembers-service:1.0.0 -o "$TAR"

echo "[pack] 压缩"
gzip -f "$TAR"

SIZE=$(du -h "${TAR}.gz" | cut -f1)
echo "[pack] 完成：${TAR}.gz (${SIZE})"
echo "[pack] 连同这些一起传：docker-compose.yml .env.example deploy.sh backup.py"
