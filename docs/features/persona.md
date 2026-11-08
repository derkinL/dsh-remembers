# 功能：人格设定（每轮必带）

人格是「她是谁」，走 `systemPrompt` 的独立段（`remembers:persona`，order=5），**每轮都在**，不像记忆那样按相关性出现。

## 由哪几块拼出来

| 块 | 存在哪 | 谁改 |
|---|---|---|
| 身份卡（名字/自称/怎么叫 owner/脾气/说话方式/底线/自由发挥） | `persona.identity`（JSON） | 设置页「人格设定」 |
| 她的形象 | `persona.self_image` | 设置页 |
| 老大画像（**手编**那份） | `persona.user_profile` | 设置页 |
| 自我认知 | `persona.self_model` | AI 通过 `persona_update`；可回滚 |
| 口音档案 | `voice.json`（从她自己说过的话统计而来） | 每 3 天自动重写，可手动 |
| 当前状态 | `state` 表（心情/亲密度/在干嘛） | 运行时累积 |

渲染顺序（`renderPersona()` in `index.mjs`）：铁律 → 说话样子 → 我是谁 → 平常会做的事 → 口音 → 表情包/文字颜/emoji 频率 → 形象 → 主人画像 → 松紧度。

## 缓存策略

- 段文本按会话类型（私聊主人 / 群聊 / 私聊别人）三选一，**同一会话内稳定**。
- 数据 20 秒节流刷新（`personaRefreshMs`），失败保留上一份好的，宁可旧一点也不能这轮没有人格。
- 群聊不带主人私密画像：换成「现在说话的是谁」的说明块，逐轮注入。

## 文件树

```
index.mjs                     # buildPersonaText / renderPersona / injectProfile / persona_update 工具
client.js                     # 「人格设定」面板：身份卡、形象、画像、自我认知、版本回滚
service/server.py             # GET|POST /persona、POST /persona/self、/persona/versions、/persona/rollback、/persona/style
service/memory_core.py        # persona 表读写 + 版本快照
service/schema.sql            # persona (constitution, self_model, identity, self_image, user_profile)
cordis.patch.yml              # 自带的 custom 预设（人格预设行 + 预设模板）
tests/node/test_client.mjs    # 人格页能渲染、有返回按钮
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/persona` | 一次拿齐：宪法、自我认知、身份卡、形象、主人画像 |
| POST | `/persona` | 设置页保存（宪法 + 自我认知都能写） |
| POST | `/persona/self` | 只写自我认知（AI 侧唯一入口） |
| GET | `/persona/versions` | 自我认知历史版本 |
| POST | `/persona/rollback` | 回滚到某一版 |
| POST | `/persona/style` | 说话松紧 / 自称等开关 |

## 已知边界

- **身份卡不给 AI 写**：`persona_update` 只打 `/persona/self`；身份/形象/主人画像只有设置页能动。\n- 宪法区（`persona.constitution`）1.2.1 起已从人格段和界面撤掉，字段留着只为兼容老库。
- 两半都空 = 整段不注入（装完要先去设置页填，否则看起来像没生效）。
- `cordis.patch.yml` 会往 profile 里插一个 id=`custom` 的 agent preset；如果你已有同名预设，先合并再装（见 [安装说明](../deploy/windows.md)）。
