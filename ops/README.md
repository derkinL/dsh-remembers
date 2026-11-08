# ops —— 作者自己的 VPS 脚本（与安装无关）

这里的东西**不是 dsh-remembers 的一部分**，是作者那套双实例部署用的运维脚本和第三方补丁。装这个插件不需要它们；别人拿去也跑不起来（路径、端口、QQ 号都是写死的）。

| 文件 | 作用 | 为什么放这里 |
|---|---|---|
| `deploy-both.sh` | 两套实例一起部署 + 重启 + 校验（`/home/ubuntu/...`、端口 3080/3081） | 只对作者的两套 VPS 有效 |
| `proactive-inject.sh` | 上一代「主动消息」注入脚本（cron 版） | 已被 `service/scheduler.py` 取代 |
| `patches-onebot/` | 对第三方 `dsh-onebot-qq` 的两个补丁（分句不断在引号里 / 不许自动开新会话）+ 说明 | 改的是别人的文件，升级就丢，需要单独存 |

## patches-onebot 怎么用

见 [`patches-onebot/README.md`](patches-onebot/README.md)。核心是：找到 `node_modules/dsh-onebot-qq/lib/`，备份后覆盖 `outbound.js` / `registry.js`，`node --check` 再重启 DSH。

> 如果你不需要「QQ 分句更自然」和「不自动分裂会话」，**整个 `ops/` 可以删掉**，不影响插件。
