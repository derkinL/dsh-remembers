# 功能：QQ 通道

她真正「开口说话」靠它。**本仓库不含 QQ 通道实现**，只包含对它的配置、注入文件约定和两个补丁说明。

## 谁是谁

```
QQ ──NapCat/OneBot──▶ dsh-onebot-qq（第三方插件，反向 WS）
                          │  会话 id：onebot-private-<qq> / onebot-group-<gid>
                          │  合成消息：media/onebot/qq-inject.jsonl
                          ▼
                    DSH 会话  ──▶  dsh-remembers（记忆/人格）
```

- 主动唤醒、日记提醒、自我认知提醒都由 `scheduler.py` 往 `CMEM_INJECT_PATH`（默认 `~/.dsh/media/onebot/qq-inject.jsonl`）追加一条 `synthetic` 消息；onebot 插件读到后开一轮会话。
- 插件侧按会话 id 解析 `user_id / scope`，写记忆时带上「谁说的 / 在哪个群」，召回时只取「本会话 + global」。

## 设置页「QQ 通道」管什么

| 区块 | 内容 |
|---|---|
| 桥接状态 | 连接模式、端口、token（读 profile 的 `cordis.patch.yml`） |
| 会话列表 | 私聊 / 群聊、最近活跃、是否允许主动唤醒 |
| 权限 | 谁能私聊她、群里谁算管理员、白名单 |
| 会话操作 | 开新会话（仅 `/new`）、查看最近历史 |

## 文件树

```
client.js                     # 「QQ 通道」面板（桥接/会话/权限/唤醒开关）
service/server.py             # /qq/config /qq/sessions /qq/session-history /qq/chat-map
│                             # /qq/bind /qq/new-session /qq/wake
service/scheduler.py          # _wake_chats()、_inject()：往 qq-inject.jsonl 写合成消息
ops/patches-onebot/           # 对第三方 dsh-onebot-qq 的两个本地补丁（分句 / 不许自动开新会话）
```

## 已知边界

- **没装 `dsh-onebot-qq` 时**：设置页的 QQ 面板读不到 profile 配置，唤醒只写日志、不会开口。
- profile 配置路径按 `CMEM_DSH_PATCH` > `DSH_HOME/profiles/<DSH_PROFILE>` > `web` > `qq2` 顺序推断；任意布局都能用环境变量显式指定。
- `/qq/cmd`（直接下发 CLI 命令）没有调用方，属于遗留接口。\n- 主人 QQ：`CMEM_OWNER_QQ` > onebot 的 `adminUsers` > `wakeChats` 里第一个私聊；都拿不到就不主动开口（不会发给陌生人）。
- 补丁是**改第三方文件**，插件一升级就被覆盖，需重打（`ops/patches-onebot/README.md`）。
