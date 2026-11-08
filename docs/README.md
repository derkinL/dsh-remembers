# 文档索引

先读 [架构](architecture.md)，再按功能点进 `features/`。每篇都带**该功能的文件树**，方便人和 AI 定位代码。

## 总体

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 两个进程、一次对话的数据流、完整目录树、两层配置 |
| [compatibility.md](compatibility.md) | 平台 / 依赖 / 功能可用性矩阵 |
| [audit.md](audit.md) | 2026-11 体检报告：插件规范符合度、安装硬伤、无效功能清单 |

## 功能（每个功能一份文件树）

| 功能 | 文档 | 一句话 |
|---|---|---|
| 分层记忆 | [features/memory.md](features/memory.md) | L0–L4 + BM25/向量 + 诚实出口 |
| 人格 | [features/persona.md](features/persona.md) | 每轮必带的 systemPrompt 段 |
| 学说话 | [features/phrases.md](features/phrases.md) | 语料库 / 转正 / 口音档案 |
| 表情包 | [features/memes.md](features/memes.md) | 找图、学图、频率 |
| 主动消息 | [features/proactive.md](features/proactive.md) | 调度器、动作池、注入 QQ |
| B 站 | [features/bili.md](features/bili.md) | 刷/看/评论（依赖外部 CLI） |
| 贴吧 | [features/tieba.md](features/tieba.md) | 读帖/回帖（Node CLI + Cookie） |
| QQ 通道 | [features/qq.md](features/qq.md) | 依赖第三方 onebot 插件 |
| 设置 | [features/settings.md](features/settings.md) | 模型/密钥/开关，热生效 |
| 语气后处理 | [features/tone.md](features/tone.md) | 纯规则 `tone_fix` |

## 部署

| 场景 | 文档 |
|---|---|
| Windows 本机 | [deploy/windows.md](deploy/windows.md) |
| Linux / VPS（推荐） | [deploy/linux.md](deploy/linux.md) |
| Docker（只容器化服务） | [deploy/docker.md](deploy/docker.md) |

## 其它

- [../tests/README.md](../tests/README.md)：测试怎么跑、覆盖什么
- [../ops/README.md](../ops/README.md)：个人 VPS 脚本与第三方补丁（与安装无关）
