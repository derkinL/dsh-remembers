# 功能：贴吧（读帖 / 回帖）

她自己逛吧：翻首页、点进帖子、偶尔回一句。

## 链路

```
index.mjs  tieba_browse / tieba_read / tieba_sub / tieba_reply / tieba_whoami
   │  HTTP
service/server.py  /tieba/*
   │  subprocess（node）
tools/tieba/tieba-cli.mjs  →  curl（百度认 TLS 指纹，不能用普通 fetch）
   │
贴吧 HTML / JSON 接口  ←→  cookie jar（BDUSS）
```

`tieba_read` 会顺带返回 `styleRefs`：从语料库里按帖子话题挑 4 句「那个吧的人这么说的」，回帖时照着味道说，不照抄。`tieba_reply` 默认关闭，要单独开。

## 登录

设置页「贴吧」粘贴 Cookie（自动挑出 BDUSS）→ `POST /tieba/login`。教程图在 `service/static/tieba-login.png`（页面里 `<details>` 折起来）。

> 扫码登录做过但没通（百度 passport 风控）：`/tieba/qr/start`、`/tieba/qr/poll` 两个接口还在，**前端不调用**，属于未完成路径。

## 文件树

```
index.mjs                     # 5 个 tieba_* 工具
client.js                     # 「贴吧」面板：账号/Cookie、启用、回帖开关、常逛的吧、节奏
service/server.py             # /tieba/status|browse|read|sub|reply|config|login|qr/*
│                             # _tieba_cli() 调 node CLI；_tieba_dir()/Cookie 存取
service/scheduler.py          # 贴吧节奏（每天 ≤4 次，间隔 120–480 分钟）
tools/tieba/
├─ tieba-cli.mjs              # 命令行入口：whoami/browse/read/sub/reply/sign/login/qr
├─ tieba.js                   # 抓取与解析（curl + cookie jar）
├─ tieba-qr.mjs               # 扫码登录（未接入前端）
└─ cooldown.mjs               # 冷却与限速（防风控）
service/data/tieba.json       # enabled / cookie / bars / replyEnabled / 节奏
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/tieba/status` | 登录态、tbs、开关 |
| GET | `/tieba/browse?kw=&pn=` | 翻吧首页（不传 kw 就从「常逛的吧」挑） |
| GET | `/tieba/read?tid=&pn=` | 读帖：标题、楼层、热门楼层、图 |
| GET | `/tieba/sub?tid=&pid=` | 楼中楼 |
| POST | `/tieba/reply` | 回帖（要开 `replyEnabled`） |
| POST | `/tieba/login`、`/tieba/config` | Cookie / 配置 |

## 已知边界

- 必须装 Node（服务端用 `subprocess` 调 CLI）；`install.sh` / `install.ps1` 已把 `tools/` 一起装上。
- 贴吧风控严：默认回帖关闭、节奏保守（≥120 分钟、每天 ≤4 次）。同一出口 IP 多实例会互相拖累。
- 扫码登录没接通；只能用 Cookie。
