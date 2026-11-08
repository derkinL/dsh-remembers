# 兼容性与功能可用性

## 平台

| 平台 | 插件 | 记忆服务 | 自启方式 | 状态 |
|---|---|---|---|---|
| **Windows 10/11** | `install.ps1` | Python 3.10+ | 任务计划 | 已支持（1.2.0 起修好数据目录/端口） |
| **Linux (Debian/Ubuntu)** | `install.sh` | Python 3.10+ | systemd（`service/deploy/deploy-native.sh`） | 主路径 |
| **macOS** | `install.sh` | Python 3.10+ | 手动 / launchd | 能跑，未实测 |
| **Docker** | 不适用（插件在宿主） | 镜像 `service/Dockerfile` | `restart: unless-stopped` | 可选 |

## 运行时

| 项 | 要求 | 备注 |
|---|---|---|
| Node.js | `^22.19.0 \|\| >=24` | 插件与 DSH 宿主同版本线 |
| Python | ≥ 3.10 | 只用标准库 + numpy |
| numpy | ≥ 1.26 | `service/requirements.txt` 唯一依赖 |
| DSH | 0.2.x | 开发/验证在 `0.2.1-rc.2` 与 `0.2.2-rc.1` 上 |
| 内存 | ≥ 512 MB | 1020 条语料 + numpy 很小 |
| 磁盘 | 几十 MB | 数据 = `service/data/memories.db` 单文件 |

## 功能可用性

| 功能 | 需要什么 | 不满足时 |
|---|---|---|
| 分层记忆 L0 | 只要服务在跑 | — |
| L1/L2/L3 抽取 | **LLM key** | 只存 L0；`/extract` 返回 `degraded` |
| 语义召回 | embedding（可选） | 退化成 BM25 关键词，仍可用 |
| 人格注入 | 服务 + 设置页填过人格 | 两半都空 = 整段不注入 |
| 学说话（看/查） | 默认语料随包发布 | — |
| 学说话（转正/口音） | **LLM key** | 停在候选池 |
| 表情包 | 图库目录有图（默认 `~/.dsh/media/onebot/memes`） | 工具返回空 |
| 主动消息 | **QQ 通道**（`CMEM_INJECT_PATH`）+ 主人 QQ（`CMEM_OWNER_QQ` 或 onebot 的 adminUsers） | 只写日志，不会开口 |
| 贴吧 | Node + Cookie（BDUSS） | 工具返回 `ok:false` |
| B 站 | 外部 `bili-cli`（`CMEM_BILI_DIR`） | 全部 `ok:false` |
| QQ 通道 | 第三方 `dsh-onebot-qq` + NapCat | 无 QQ 面板数据 |
| `tone_fix` | 无 | — |

> **给新用户的一句话**：装完 + 填 LLM key + 改人格，就能得到「记忆 + 人格」；贴吧/ B 站 / QQ 是加法，不是地基。

## 与 DSH 版本的关系

- 插件用 `ctx.get("systemPrompt")` / `ctx.get("tools")` 软获取服务，拿不到只降级、不拦加载；
  `inject` 只声明 `agents` / `sessions`。
- 工具注册依赖 `@deepseek-ai/dsh-tools`（`defineTool`），已写进 `peerDependencies`。
- 客户端走 `window.__ModuleLoader__.load({ id, factory })` 协议 + `sidebar.panellist` / `main` 两个 slot，属于 DSH Web 公开的注册面。
- 0.2.1-rc.x 冷启动时 `ctx.tools` 可能还没就绪：本插件在 `apply` 里同步取一次，晚到就跳过热注册（日志 `*_tools_skipped`）。
