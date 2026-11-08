#!/usr/bin/env bash
# dsh-remembers 全部测试入口（Linux / macOS / WSL / Git Bash）
#
#   bash run_all_tests.sh
#
# 覆盖：
#   tests/python  服务端：解析 / 核心检索 / 门控 / 迁移 / 口头禅门槛
#   tests/node    插件：主机半边注册面 + 浏览器半边入口页 + 语气后处理
#
# 都不需要网络，也不需要记忆服务在跑。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT/_tmp/test-logs"
mkdir -p "$LOG_DIR"

PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for cand in "$ROOT/venv/bin/python" python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
  done
fi
[ -n "$PY" ] || { echo "找不到 Python"; exit 1; }
NODE="${NODE:-node}"
command -v "$NODE" >/dev/null 2>&1 || { echo "找不到 node"; exit 1; }

export PYTHONIOENCODING=utf-8
export PYTHONDONTWRITEBYTECODE=1

total_pass=0
total_fail=0
failed=""

run() {
  local label="$1" log="$2"
  shift 2
  if "$@" > "$log" 2>&1; then
    echo "  ✅ $label"
    total_pass=$((total_pass + 1))
  else
    echo "  ❌ $label   (日志: ${log#$ROOT/})"
    tail -8 "$log" | sed 's/^/       /'
    total_fail=$((total_fail + 1))
    failed="$failed $label"
  fi
}

echo "================================================================"
echo "服务端（Python: $PY）"
echo "================================================================"
for t in test_json_parse test_core test_gating test_transfer test_slang test_seeds; do
  run "$t" "$LOG_DIR/$t.log" "$PY" "$ROOT/tests/python/$t.py"
done

echo
echo "================================================================"
echo "插件（Node: $($NODE -v)）"
echo "================================================================"
run "test_plugin" "$LOG_DIR/test_plugin.log" "$NODE" "$ROOT/tests/node/test_plugin.mjs"
run "test_client" "$LOG_DIR/test_client.log" "$NODE" "$ROOT/tests/node/test_client.mjs"
run "tone.test" "$LOG_DIR/tone.log" "$NODE" "$ROOT/tests/node/tone.test.mjs"

echo
echo "================================================================"
printf "合计：通过 %d，失败 %d\n" "$total_pass" "$total_fail"
if [ "$total_fail" -gt 0 ]; then
  echo "失败：$failed"
  exit 1
fi
echo "全绿 ✅"
