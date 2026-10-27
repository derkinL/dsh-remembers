#!/bin/bash
# dsh-remembers 全部测试入口。
# 用法：bash run_all_tests.sh
#
# 覆盖：
#   服务端  Python —— 解析 / 核心 / 门控 / 迁移 / 口头禅门槛
#   插件    JS     —— 主机半边注册面 + 浏览器半边设置段

ROOT=/home/ubuntu/dsh-agentchat/_deploy/dsh-remembers
SVC=$ROOT/service
VENV=$ROOT/venv/bin/python
NODE=/home/ubuntu/.local/node/bin/node
PLUGIN=/home/ubuntu/.dsh/profiles/web/node_modules/dsh-remembers

export PYTHONIOENCODING=utf-8
export PYTHONDONTWRITEBYTECODE=1

total_pass=0
total_fail=0
failed_suites=""

run_py() {
  local name=$1
  cd "$SVC" || return 1
  if "$VENV" "$name" > "/tmp/t_${name}.log" 2>&1 ; then
    echo "  ✅ $name"
    total_pass=$((total_pass + 1))
  else
    echo "  ❌ $name  (日志: /tmp/t_${name}.log)"
    tail -5 "/tmp/t_${name}.log" | sed 's/^/       /'
    total_fail=$((total_fail + 1))
    failed_suites="$failed_suites $name"
  fi
}

run_js() {
  local name=$1
  cd "$PLUGIN" || return 1
  if "$NODE" "test/$name" > "/tmp/t_${name}.log" 2>&1 ; then
    echo "  ✅ $name"
    total_pass=$((total_pass + 1))
  else
    echo "  ❌ $name  (日志: /tmp/t_${name}.log)"
    tail -5 "/tmp/t_${name}.log" | sed 's/^/       /'
    total_fail=$((total_fail + 1))
    failed_suites="$failed_suites $name"
  fi
}

echo "================================================================"
echo "服务端（Python）"
echo "================================================================"
run_py test_json_parse.py
run_py test_core.py
run_py test_gating.py
run_py test_transfer.py
run_py test_slang.py

echo
echo "================================================================"
echo "插件（JS）"
echo "================================================================"
if [ -d "$PLUGIN/test" ]; then
  run_js test_plugin.mjs
  run_js test_client.mjs
else
  echo "  （插件目录没有 test/，跳过）"
fi

echo
echo "================================================================"
printf "合计：通过 %d，失败 %d\n" "$total_pass" "$total_fail"
if [ "$total_fail" -gt 0 ]; then
  echo "失败：$failed_suites"
  exit 1
fi
echo "全绿 ✅"
