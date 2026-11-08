#!/bin/bash
# 两套一起部署：主套（web 3080 / 记忆服务 8081）+ 副套（qq2 3081 / 记忆服务 8082）
# 用法：在本地跑 scp 之后，或直接在服务器上让脚本自己从本地仓库同步。
# 这里只做「服务器上已有的文件 → 两套 + 重启 + 校验」，避免再漏一套。
set -u

SRC=${1:-/home/ubuntu/dsh-agentchat/_deploy/dsh-remembers}      # 共享源码目录（service/tools/static）
MAIN=/home/ubuntu/.dsh/profiles/web/node_modules/dsh-remembers
SEC=/home/ubuntu/dsh2/profiles/qq2/node_modules/dsh-remembers
N=/home/ubuntu/.local/node/bin/node
STAMP=$(date +%Y%m%d%H%M%S)

echo "=== 1) 备份两套 ==="
cp -a "$MAIN/client.js" "$MAIN/client.js.bak-$STAMP"
cp -a "$MAIN/index.mjs" "$MAIN/index.mjs.bak-$STAMP"
cp -a "$SEC/client.js" "$SEC/client.js.bak-$STAMP"
cp -a "$SEC/index.mjs" "$SEC/index.mjs.bak-$STAMP"
echo "  *.bak-$STAMP"

echo
echo "=== 2) 语法检查 ==="
$N --check "$MAIN/client.js" && echo "  主套 client ok"
$N --check "$MAIN/index.mjs" && echo "  主套 index ok"
$N --check "$SEC/client.js" && echo "  副套 client ok"
$N --check "$SEC/index.mjs" && echo "  副套 index ok"
"$SRC/venv/bin/python" -m py_compile "$SRC/service/server.py" && echo "  server ok"
"$SRC/venv/bin/python" -m py_compile "$SRC/service/scheduler.py" && echo "  scheduler ok"

echo
echo "=== 3) 重启四件套 ==="
sudo -n systemctl restart dsh-remembers dsh-remembers2 dsh-web dsh-web2 && echo restarted
sleep 9
systemctl is-active dsh-remembers dsh-remembers2 dsh-web dsh-web2

echo
echo "=== 4) 两套接口 ==="
echo -n "  主套 8081: "; curl -s -m 20 http://127.0.0.1:8081/tieba/status | head -c 120; echo
echo -n "  副套 8082: "; curl -s -m 20 http://127.0.0.1:8082/tieba/status | head -c 120; echo

echo
echo "=== 5) md5 一致性 ==="
md5sum "$MAIN/client.js" "$SEC/client.js" "$MAIN/index.mjs" "$SEC/index.mjs"

echo
echo "=== 6) 两套 bundle 都带上贴吧卡 ==="
for pair in "dsh-web:3080" "dsh-web2:3081"; do
  unit=${pair%%:*}; port=${pair##*:}
  T=$(journalctl -u "$unit" --no-pager -n 300 | grep -oE "http://127\.0\.0\.1:$port/\?token=[A-Za-z0-9_-]+" | tail -1 | sed 's/.*token=//')
  [ -z "$T" ] && { echo "  $unit: 没找到 token"; continue; }
  J="/tmp/dep-$port.txt"; rm -f "$J"
  curl -s -m 10 -L -c "$J" -b "$J" -o /tmp/dep.html "http://127.0.0.1:$port/?token=$T"
  U=$(grep -oE 'href="plugins/[^"]*dsh-remembers[^"]*"' /tmp/dep.html | head -1 | sed 's/^href="//; s/"$//' | sed 's/&amp;/\&/g')
  curl -s -m 40 -b "$J" -o /tmp/dep.js "http://127.0.0.1:$port/$U"
  echo "  $unit: 贴吧卡=$(grep -c '逛人类的吧' /tmp/dep.js) 开关CSS=$(grep -c 'dshm-ui input\[type=' /tmp/dep.js) bytes=$(stat -c%s /tmp/dep.js)"
done
