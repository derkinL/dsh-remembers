#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自检：前端用到的配置字段 vs 后端接受的白名单，找出会被静默丢弃的。

扫的范围：
  /proactive  POST  ← 主动消息页签 + B站页签的一堆开关
  /qq/config  POST  ← QQ 通道页签
  /bili/toggle POST ← B站总开关 + frameGrid
"""
import os
import re
import sys

SVC = "/home/ubuntu/dsh-agentchat/_deploy/dsh-remembers/service"
CL = "/home/ubuntu/.dsh/profiles/web/node_modules/dsh-remembers/client.js"

server = open(SVC + "/server.py", encoding="utf-8").read()
client = open(CL, encoding="utf-8").read()

print("=" * 74)
print("自检：前端字段 vs 后端白名单")
print("=" * 74)

# ---------- 1. /proactive 前端用到的字段 ----------
# 前端两种写法：
#   num("字段", ...) / toggle("字段", ...) / numInput("字段", ...)
#   setCfg({ ...cfg, 字段: ... }) / setBiliProactive({ ...biliProactive, [字段]: ... })
fe_proactive = set()
for m in re.finditer(r'(?:num|toggle|numInput)\(\s*"([a-zA-Z][a-zA-Z0-9_]*)"', client):
    fe_proactive.add(m.group(1))
# setProactive / setBiliProactive / setCfg 里的字段
for m in re.finditer(r'setCfg\(\{\s*\.\.\.cfg,\s*([a-zA-Z][a-zA-Z0-9_]*):', client):
    fe_proactive.add(m.group(1))
for m in re.finditer(r'\[([a-zA-Z][a-zA-Z0-9_]*)\]:\s*!', client):
    fe_proactive.add(m.group(1))

# ---------- 2. 后端 _set_proactive 白名单 ----------
i = server.find("def _set_proactive")
j = server.find("\n    def ", i + 10)
seg = server[i:j]

be_proactive = set()
# for key in (...): 形式的元组
for m in re.finditer(r'for key in \(([^)]+)\)', seg):
    for name in re.findall(r'"([a-zA-Z][a-zA-Z0-9_]*)"', m.group(1)):
        be_proactive.add(name)
# if "xxx" in body: 形式的单字段
for m in re.finditer(r'if "([a-zA-Z][a-zA-Z0-9_]*)" in body', seg):
    be_proactive.add(m.group(1))

print(f"\n【/proactive】后端白名单 {len(be_proactive)} 个字段")
print("  " + ", ".join(sorted(be_proactive)))

# 只保留看起来像 proactive 配置的（排除纯 UI 状态变量）
NOISE = {
    "key", "value", "path", "text", "enabled", "mode", "suggest",
}
fe_proactive -= NOISE

missing = sorted(fe_proactive - be_proactive)
if missing:
    print(f"\n  ⚠️ 前端用了但后端不接受（会被静默丢弃）: {len(missing)} 个")
    for k in missing:
        print(f"     - {k}")
else:
    print("\n  ✅ 前端字段全部在后端白名单里")

# ---------- 3. QQ 通道 /qq/config ----------
print()
i2 = server.find("QQ_SCHEMA")
j2 = server.find("\n    ]", i2)
qq_schema = server[i2:j2 + 6]
be_qq = set(re.findall(r'"key":\s*"([a-zA-Z][a-zA-Z0-9_]*)"', qq_schema))
print(f"【/qq/config】schema 里有 {len(be_qq)} 个字段")

# ---------- 4. /bili/toggle ----------
print()
i3 = server.find("def _bili_toggle")
j3 = server.find("\n    def ", i3 + 10)
bili_tg = server[i3:j3]
be_toggle = set()
for m in re.finditer(r'if "([a-zA-Z][a-zA-Z0-9_]*)" in body', bili_tg):
    be_toggle.add(m.group(1))
for m in re.finditer(r'if key in \(([^)]+)\)', bili_tg):
    for name in re.findall(r'"([a-zA-Z][a-zA-Z0-9_]*)"', m.group(1)):
        be_toggle.add(name)
print(f"【/bili/toggle】接受 {len(be_toggle)} 个字段: {', '.join(sorted(be_toggle))}")

# 前端调 /bili/toggle 传的
fe_toggle = set()
for m in re.finditer(r'call\("/bili/toggle",\s*\{[^}]*JSON\.stringify\(\{\s*([a-zA-Z][a-zA-Z0-9_]*):', client, re.S):
    fe_toggle.add(m.group(1))
missing2 = sorted(fe_toggle - be_toggle)
if missing2:
    print(f"  ⚠️ 前端传了但后端不接受: {missing2}")
else:
    print(f"  ✅ 前端传的（{', '.join(sorted(fe_toggle)) or '无'}）都在白名单里")

# ---------- 5. 抽查：/proactive 里前端那几个新字段在不在 ----------
print()
print("【重点抽查】这次踩过坑的字段：")
for k in ("biliBrowsePerDay", "biliBrowseLimit", "biliMinGapMinutes", "biliMaxGapMinutes",
          "biliBrowseEnabled", "biliShareToOwner", "frameGrid", "autoShareEnabled"):
    where = []
    if k in be_proactive:
        where.append("/proactive")
    if k in be_toggle:
        where.append("/bili/toggle")
    if k in be_qq:
        where.append("/qq/config")
    print(f"  {k:<22} {'✅ ' + ', '.join(where) if where else '❌ 哪个接口都不认'}")
