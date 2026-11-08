# 功能：B 站（刷视频 / 看视频 / 发评论）

**这是可选功能，而且只对作者那套环境开箱可用**：它借的是外部 `bili-cli`（`dsh-bili-whale` 带的 CLI），路径写死在 `service/server.py` 里。

## 能力

- `bili_feed`：刷首页/推荐，返回标题 + 链接（可带「她自己的想法」写进活动）。
- `bili_watch`：看一个视频（`bili_run debrief` 抽字幕 + 九宫格帧，帧数可调 9/16/30/60）。
- `bili_comment`：发评论（要开写权限）。
- `bili_run`：直接跑白名单里的 CLI 子命令。

## 依赖（关键）

```
<CMEM_BILI_DIR>/tools/bili.mjs              ← 外部 CLI，不在本仓库
<CMEM_NODE_BIN>                             ← node（默认自动找）
~/.bili-ai/credentials.json                 ← 登录凭据
~/.dsh/bili-whale.config.json               ← 她的 B 站口味/UID/白名单
```

两个路径都能用环境变量指定，不再需要改源码：

```env
CMEM_BILI_DIR=/opt/bili-cli
CMEM_NODE_BIN=/usr/bin/node
```

没设时按老布局推断（`~/bili-cli` + `/home/ubuntu/.local/node/bin/node` → `/usr/local/bin/node` → `which node`）。

## 文件树

```
index.mjs                     # bili_feed / bili_comment / bili_run / bili_watch
client.js                     # 「B 站」面板：登录(二维码)、启用、工具白名单、帧数、UID、口味
service/server.py             # /bili/status|qr|qr/poll|login|tools|run|feed|comment|debrief
│                             # /bili/cfg|owner|toggle|thought；_run_bili() 调外部 CLI
service/scheduler.py          # 刷 B 站节奏（每天 ≤3 次，间隔 60–240 分钟）
service/data/bili.json        # enabled / tools 白名单 / frameGrid 等
```

## 已知边界

- 装好也没法直接用：需要另装 `bili-cli`，用 `CMEM_BILI_DIR` 指过去。
- 登录二维码走 `/bili/qr` + `/bili/qr/poll`，凭据落 `~/.bili-ai/`。
- 评论是写操作，受风控限制；同一出口 IP 多实例会互相触发熔断。
- 配好 `bili-cli` 之前，`bili_*` 工具全部返回 `{"ok": false}`，不影响其他功能。
