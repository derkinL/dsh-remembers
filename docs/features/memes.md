# 功能：表情包

她自己发表情，也认得出你发的图。

## 能力

- **找图**：`find_meme` 按情绪（happy/angry/sad/shy/confused/daily）+ 关键词搜，返回完整路径。
- **学图**：`learn_meme` 收录一张新图（自动识别分类/描述/关键词）。
- **计数**：`mark_meme_used`（显式记一次）；**发图自动记**——她从会话里调 `qq_send_image` 且路径在 memes/ 下时，插件自动 `POST /memes/used`，所以 `used_count` 现在反映真实发送量；`/memes/scan` 扫你发来的图并计入「见过」。
- **图库**：多 pack、上传、重命名、设封面、删除；界面按 pack 平铺卡片。
- **频率**：0 / 0.2 / 0.5 / 1.0 四档，写进人格段（「每 N 句配一张」），每轮提醒。
- **文字颜 / emoji**：跟表情包同级的另外两个频率开关。

## 文件树

```
index.mjs                     # find_meme / learn_meme / mark_meme_used 三个工具
client.js                     # 「表情包」面板：频率、文字颜/emoji、pack 列表、上传/编辑/删除
service/server.py             # /memes /memes/packs* /memes/upload /memes/delete /memes/scan
│                             # /memes/used /memes/seen /memes/file/<name>
service/memory_core.py        # meme / meme_seen 表；按情绪+关键词检索、used_count
service/schema.sql            # meme, meme_seen
config.mjs                    # memeDir（默认 ~/.dsh/media/onebot/memes）
```

## 数据

`meme`：`file`（唯一）、`emotion`、`caption`、`keywords`、`used_count`、`pack`。
`meme_seen`：用户发过的图 → 计数，够次数可以被「学」进图库。

图片本身不入库，只在磁盘上；数据库存相对文件名，取图走 `/memes/file/<name>`。

## 实测（2026-11-08，两套线上库 / 18 个会话）\n\n```\nfind_meme      28 次\nqq_send_image  21 次   ← 真正发出去的图\nmark_meme_used  6 次   ← 旧口径只数这个，所以 used_count 严重低估\nlearn_meme      7 次\n```\n\n结论：表情包是**真在用**的模块（只是以前统计错了）。\n\n## 已知边界

- 表情包目录默认 `~/.dsh/media/onebot/memes`（QQ 通道的媒体目录）。不用 QQ 的人要在插件 config 里改 `memeDir`，或者把图放进去。
- 分类/描述识别要 LLM；没配 key 时只按文件名和手工编辑的元数据检索。
- `meme_seen` 的写入依赖插件把用户消息里的图片路径送上来；纯 Web 里没配 QQ 时基本为空。
