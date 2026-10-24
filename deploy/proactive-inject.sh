#!/bin/bash
# proactive-inject.sh — 每分钟 cron 调用；两套各自读自己的配置、各自的间隔、各自唤醒
# 配置存服务端 /proactive（设置页可改），状态文件按实例分后缀

set -uo pipefail

STATE_DIR=/home/ubuntu
log_activity() {
  local port="$1" kind="$2" detail="$3"
  curl -s -m 3 -X POST "http://127.0.0.1:${port}/activity" \
    -H 'Content-Type: application/json' \
    -d "{\"kind\":\"${kind}\",\"detail\":\"${detail}\"}" > /dev/null 2>&1 || true
}

play_game() {
  local port="$1"
  local st score plays newscore newplays
  st=$(curl -s -m 5 "http://127.0.0.1:${port}/state" 2>/dev/null) || return 0
  score=$(echo "$st" | python3 -c "import sys,json; print(json.load(sys.stdin).get('game_score',0))" 2>/dev/null || echo 0)
  plays=$(echo "$st" | python3 -c "import sys,json; print(json.load(sys.stdin).get('game_plays',0))" 2>/dev/null || echo 0)
  newscore=$((score + RANDOM % 10 + 1))
  newplays=$((plays + 1))
  curl -s -m 5 -X POST "http://127.0.0.1:${port}/state" \
    -H 'Content-Type: application/json' \
    -d "{\"game_score\":${newscore},\"game_plays\":${newplays}}" > /dev/null 2>&1 || true
  log_activity "$port" "game" "玩《像素鲸鱼吃豆子》，现在 ${newscore} 分"
}

# 动作列表从服务端读（按 port，两套各读各的）
pick_action() {
  local mode="$1" port="${2:-8081}"
  local out picked
  out=$(curl -s -m 5 "http://127.0.0.1:${port}/proactive" 2>/dev/null) || out=""
  picked=$(printf '%s' "$out" | MODE="$mode" python3 - <<'PY'
import json, os, random, sys
mode = os.environ.get("MODE", "silent")
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
items = d.get("silentActions" if mode == "silent" else "talkActions") or []
if isinstance(items, list) and items:
    print(random.choice(items))
PY
)
  if [ -n "$picked" ]; then
    printf '%s\n' "$picked"
    return 0
  fi
  if [ "$mode" = "silent" ]; then
    printf '%s\n' "什么都不想做，就坐着发呆，或者玩玩自己的小游戏"
  else
    printf '%s\n' "想跟老大说句话（问他吃了没、在干嘛）"
  fi
}

json_get() {
  # json_get <json> <key> <default>
  local json="$1" key="$2" def="$3"
  printf '%s' "$json" | KEY="$key" DEF="$def" python3 - <<'PY'
import json, os, sys
key, default = os.environ.get("KEY"), os.environ.get("DEF")
try:
    d = json.load(sys.stdin)
    v = d.get(key, default)
except Exception:
    v = default
print(v)
PY
}

# 唤醒一套（自己读配置、自己判断时间/间隔/对话数）
run_instance() {
  local port="$1" file="$2" uid="$3" self="$4" nick="$5" suffix="$6"

  local LAST_FILE="${STATE_DIR}/proactive-last-${suffix}"
  local INT_FILE="${STATE_DIR}/proactive-interval-${suffix}"

  local CFG
  CFG=$(curl -s -m 5 "http://127.0.0.1:${port}/proactive" 2>/dev/null) || CFG=""
  if [ -z "$CFG" ]; then
    return 0
  fi

  local ENABLED START END MIN_GAP MAX_GAP SILENT_RATIO TALK MIN_CHAT
  ENABLED=$(json_get "$CFG" enabled True)
  if [ "$ENABLED" != "True" ]; then
    return 0
  fi
  START=$(json_get "$CFG" startHour 8)
  END=$(json_get "$CFG" endHour 23)
  MIN_GAP=$(json_get "$CFG" minGapMinutes 30)
  MAX_GAP=$(json_get "$CFG" maxGapMinutes 180)
  SILENT_RATIO=$(json_get "$CFG" silentRatio 40)
  TALK=$(json_get "$CFG" talkEnabled True)
  MIN_CHAT=$(json_get "$CFG" minChatBeforeWake 5)

  if [ "$MIN_GAP" -lt 5 ] 2>/dev/null; then MIN_GAP=5; fi
  if [ "$MAX_GAP" -lt "$MIN_GAP" ] 2>/dev/null; then MAX_GAP="$MIN_GAP"; fi

  local HOUR
  HOUR=$(date +%H); HOUR=$((10#$HOUR))
  if [ "$HOUR" -lt "$START" ] || [ "$HOUR" -ge "$END" ]; then
    return 0
  fi

  local NOW LAST INTERVAL
  NOW=$(date +%s)
  LAST=$(cat "$LAST_FILE" 2>/dev/null || echo 0)
  INTERVAL=$(cat "$INT_FILE" 2>/dev/null || echo 0)
  if [ "$INTERVAL" -le 0 ] 2>/dev/null; then
    INTERVAL=$((MIN_GAP + RANDOM % (MAX_GAP - MIN_GAP + 1)))
    echo "$INTERVAL" > "$INT_FILE"
    logger -t proactive-inject "[$suffix] new random interval: ${INTERVAL} min"
  fi
  if [ $((NOW - LAST)) -lt "$INTERVAL" ]; then
    return 0
  fi

  # 对话门控：这次间隔内聊够了吗
  local CHAT_N
  CHAT_N=$(curl -s -m 5 "http://127.0.0.1:${port}/state" 2>/dev/null | KEY=chat_since_wake python3 -c "import json,os,sys; print(json.load(sys.stdin).get(os.environ['KEY'],0))" 2>/dev/null || echo 0)
  if [ "${CHAT_N:-0}" -lt "${MIN_CHAT:-5}" ] 2>/dev/null; then
    logger -t proactive-inject "[$suffix] gate_chat: chat=${CHAT_N} < ${MIN_CHAT} -> skip"
    return 0
  fi

  # 到点：唤醒
  echo "$NOW" > "$LAST_FILE"
  rm -f "$INT_FILE"

  local silent action msg mid
  mid=$(( (NOW % 1000000000) + (RANDOM % 1000) ))
  if [ "$TALK" != "True" ] || [ $((RANDOM % 100)) -lt "$SILENT_RATIO" ]; then
    silent="true"
    action=$(pick_action silent "$port")
    msg="（你自己待着，现在是 ${HOUR} 点。抽到：${action}。想做就做，这只是你自己的时间，不用回消息。）"
  else
    silent="false"
    action=$(pick_action talk "$port")
    msg="（系统提醒：你醒着，现在是 ${HOUR} 点。抽到：${action}。看看老大在不在，想找他就发一句；不想也行。）"
  fi

  printf '{"post_type":"message","message_type":"private","sub_type":"friend","message_id":%s,"user_id":%s,"message":"%s","raw_message":"%s","time":%s,"self_id":%s,"silent":%s,"sender":{"user_id":%s,"nickname":"%s"}}\n' \
    "$mid" "$uid" "$msg" "$msg" "$NOW" "$self" "$silent" "$uid" "$nick" >> "$file"

  log_activity "$port" "proactive" "被叫醒（${HOUR}点，$([ "$silent" = "true" ] && echo 静默 || echo 可发言)）：${action}"
  curl -s -m 3 -X POST "http://127.0.0.1:${port}/state" -H 'Content-Type: application/json' -d '{"reset_chat":true}' > /dev/null 2>&1 || true
  logger -t proactive-inject "[$suffix] injected (hour=$HOUR silent=$silent)"
}

# 玩游戏（两套一起）：每天每套最多 3 局，30% 概率
TODAY=$(date +%Y%m%d)
PLAYS_FILE="${STATE_DIR}/game-plays-${TODAY}"
PLAYS=$(cat "$PLAYS_FILE" 2>/dev/null || echo 0)
if [ "$PLAYS" -lt 3 ] && [ $((RANDOM % 100)) -lt 30 ]; then
  play_game 8081
  play_game 8082
  echo $((PLAYS + 1)) > "$PLAYS_FILE"
  logger -t proactive-inject "game: played $((PLAYS+1))/3 today"
fi
find "$STATE_DIR" -maxdepth 1 -name 'game-plays-*' -mtime +2 -delete 2>/dev/null || true

# 两套各自跑（互不影响）
run_instance 8081 /home/ubuntu/.dsh/media/onebot/qq-inject.jsonl 3169341724 474749820 "体美劳" main
run_instance 8082 /home/ubuntu/dsh2/media/onebot2/qq-inject.jsonl 2739653921 2739653921 "老大" second
