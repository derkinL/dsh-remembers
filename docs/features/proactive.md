# 功能：主动消息（唤醒 / 节奏 / 动作池）

「她自己在合适的时候醒过来」——不是定时发消息，而是到点往会话里塞一条**提示**，让模型自己决定做什么、说不说。

## 调度器（Python 线程，不依赖 cron）

| 任务 | 默认节奏 | 做什么 |
|---|---|---|
| 唤醒 | 8–23 点，间隔 30–180 分钟随机 | 从动作池抽 1–3 条给她，允许静默 |
| B 站 | 每天 ≤3 次，间隔 60–240 分钟 | 独立节奏，不与唤醒叠加 |
| 贴吧 | 每天 ≤4 次，间隔 120–480 分钟 | 同上，风控更严所以间隔更长 |
| 日记 | 每天 23:00 | 提醒她写两句 |
| 自我认知 | 每天 22:00 | 提醒她回头看看自己 |

状态存 `service/data/scheduler-state.json`，重启不丢。`CMEM_SCHEDULER=0` 可整体关闭。

## 注入到哪

调度器往 `CMEM_INJECT_PATH` 指向的 JSONL 写一条 `synthetic` 消息（QQ 通道读它）。**没有 QQ 通道时这一步只写日志、不产生效果**——这是主动消息最大的外部依赖。

插件侧另有 `pre-step` 注入：状态块里带「现在几点 / 她醒着能做什么 / 动作池」，Web 会话也能看到「她今天干了什么」，但不会自己开口。

## 配置（`service/data/proactive.json`，设置页可改）

```json
{
  "enabled": true, "startHour": 8, "endHour": 23,
  "minGapMinutes": 30, "maxGapMinutes": 180,
  "silentRatio": 40, "talkEnabled": true, "wakeActionCount": 3,
  "wakeChats": { "private:123456": true, "group:987654": false },
  "silentActions": ["上贴吧逛逛…", "刷会儿 B 站…"],
  "talkActions": ["问问老大今天怎么样"],
  "biliBrowseEnabled": true, "biliBrowsePerDay": 3,
  "tiebaBrowseEnabled": false, "tiebaBrowsePerDay": 4,
  "selfEvolveHour": 22, "selfEvolvePerDay": 1,
  "memeRate": 0.2, "kouRate": 0.3, "emojiRate": 0.2
}
```

## 文件树

```
service/scheduler.py          # 全部 tick：唤醒 / B站 / 贴吧 / 日记 / 自我认知 + 注入 JSONL
service/server.py             # GET|POST /proactive、POST /proactive/action、/state 里的状态与动作
index.mjs                     # 状态块注入（几点/醒着能做什么/动作池）、add_my_action 工具
client.js                     # 「主动消息」面板：总开关、时间窗、间隔、静默比例、动作池编辑、B站/贴吧节奏
```

## 已知边界

- **没有 QQ 通道 = 不会真的开口**（结构如此，不是 bug）。见 [QQ 通道](qq.md)。
- 唤醒是「给模型一段提示」，不是直接发消息；模型可以选择只记一句、什么都不做（静默）。
- 动作池里写死吧名/平台名会被原样带进提示词；贴吧动作现在会在启动时自动补一条（用「常逛的吧」）。
