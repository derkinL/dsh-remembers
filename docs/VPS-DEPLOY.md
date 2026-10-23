# VPS 部署清单

记忆是**极私密**的数据。这份清单的第一原则不是「跑起来」，是「别人拿不到」。

## 0. 先确认一件事：DSH 在哪

| 场景 | 端口绑定 | 鉴权 |
|---|---|---|
| **妹妹的 DSH 和服务在同一个 VPS（推荐）** | `127.0.0.1:8080` | 可以不要 |
| DSH 在另一台机器 | `127.0.0.1:8080` + SSH 隧道 | 建议要 |
| 直接对公网开 | `0.0.0.0:8080` | **必须**，且配合防火墙白名单 |

同一个 VPS 时，`docker-compose.yml` 默认的 `127.0.0.1:8080:8080` 就是最安全的——外面根本连不上，连 token 都省了。

## 1. 前置条件

| 项 | 要求 | 怎么查 |
|---|---|---|
| Docker | ≥ 20.10 + compose v2 | `docker compose version` |
| 内存 | ≥ 512 MB（numpy 要一点） | `free -m` |
| 磁盘 | ≥ 1 GB 可用 | `df -h /` |
| Node/Python（仅 DSH 侧） | 无关，本服务自带运行时 | — |

没装 Docker：

```bash
curl -fsSL https://get.docker.com | sh          # 官方
# 国内慢的话：curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun
sudo usermod -aG docker $USER && newgrp docker
```

## 2. 从 Windows 传上去

在本地 `companion-memory` 的**上一级**目录执行：

```powershell
# 排除测试产物
scp -r .\dsh-remembers user@YOUR_VPS:/opt/
```

或者用 rsync（更省）：

```bash
rsync -avz --exclude '_tmp' --exclude '__pycache__' \
  ./dsh-remembers/ user@YOUR_VPS:/opt/dsh-remembers/
```

## 3. 部署

```bash
ssh user@YOUR_VPS
cd /opt/dsh-remembers/service
chmod +x deploy.sh
./deploy.sh
```

脚本会：检查环境 → 生成 `.env`（权限 600）→ 建 `data/`（权限 700）→ 构建 → 启动 → 等健康检查 → 打印 `/health`。

看到这段就算成了：

```json
{"ok": true, "stats": {"memories": 0}, "embedding": {"enabled": true, "model": "..."}}
```

`embedding.enabled` 是 `true` 才说明 `.env` 里的端点配好了；`false` 表示退化成纯 BM25。

## 4. 填 embedding（`.env`）

```bash
CMEM_EMBED_BASE=https://你的端点/v1     # OpenAI 兼容，末尾要带 /v1
CMEM_EMBED_KEY=sk-xxxx
CMEM_EMBED_MODEL=qwen3.7-text-embedding-flash
```

改完：

```bash
docker compose up -d          # 会重建容器读新 env
curl -s localhost:8080/health | python3 -m json.tool
```

embedding 调不通也不致命——写入会跳过向量，BM25 照常工作，`/health` 的 `last_error` 会告诉你原因。

## 5. 防火墙（只在需要跨机时）

```bash
# ufw：只放行 DSH 那台的 IP
sudo ufw allow from <DSH机器IP> to any port 8080 proto tcp
sudo ufw status
```

云厂商（阿里云/腾讯云）还要在**安全组**里加同一条，两层都要。

**别做的**：`ufw allow 8080` 裸放公网 + 空 token。历史记忆被人翻到，比丢数据库更难受。

## 6. 备份（别跳这一步）

记忆是唯一不可再生的数据。一条命令装好定时任务：

```bash
cd /opt/dsh-remembers/service
chmod +x install-cron.sh
./install-cron.sh                  # 每天 04:10，保留 14 份
# 改时间/份数：SCHEDULE="30 3 * * *" KEEP=30 ./install-cron.sh
# 卸掉：       ./install-cron.sh --remove
```

脚本是幂等的，重复跑只更新不叠加；而且**装之前会先真跑一次备份**，跑不通就不写 cron——不会装一个永远失败的定时任务。

手动验证一次：

```bash
docker compose exec companion-memory python backup.py backup
docker compose exec companion-memory python backup.py list
```

备份落在 `data/backups/`，每个都过 `PRAGMA integrity_check`。恢复：

```bash
docker compose exec companion-memory python backup.py restore memories-20261023-204729.db
docker compose restart
```

<details>
<summary>手动写 cron 的话（不用脚本）</summary>

```bash
crontab -e
10 4 * * * cd /opt/dsh-remembers/service && docker compose exec -T companion-memory python backup.py backup --keep 14 >> /var/log/cmem-backup.log 2>&1
```

</details>

**异地再备一份**（记忆丢了没法重建）：

```bash
# VPS 上导出到本地
scp user@YOUR_VPS:/opt/dsh-remembers/service/data/backups/*.db ./mem-backups/
```

## 7. 接进 DSH

MCP 配置（`mcpServers`）——服务在同机时用这个：

```json
{
  "companion-memory": {
    "command": "python3",
    "args": ["/opt/dsh-remembers/service/mcp_server.py"],
    "env": { "CMEM_URL": "http://127.0.0.1:8080" }
  }
}
```

如果 DSH 在另一台机器，用 SSH 隧道最稳（不用开防火墙）：

```bash
ssh -N -L 8080:127.0.0.1:8080 user@YOUR_VPS
# 然后本地 MCP 配 CMEM_URL=http://127.0.0.1:8080
```

## 8. 排错

| 现象 | 查什么 |
|---|---|
| 容器起不来 | `docker compose logs --tail 100` |
| `/health` 404 | 端口没通，或 `CMEM_PORT` 改了但 compose 没改 |
| `embedding.enabled=false` | `.env` 的 `BASE`/`MODEL` 有一个空；改完要 `up -d` 重建 |
| `embedding.last_error` 有值 | 端点/密钥/模型名不对，或用 urllib 连不上（代理/证书） |
| 检索老是空 | `curl localhost:8080/log?limit=20` 看 `outcome`；全是 `no_match` 说明库还空，或 `MIN_BM25_ABS` 太高 |
| 语义召回不生效 | 写入时的 `embed` 是不是被关掉了；`/stats` 的 `with_vectors` 应该是 >0 |
| 磁盘涨得快 | `search_log` 会一直长，定期 `DELETE FROM search_log WHERE ts < <半年前>` |

## 9. 上线后第一件事

别急着灌真实对话。先按 README 的「实测结果」那七条在 VPS 上重跑一遍（`python test_core.py`），确认行为和本地一致，再开始写入真实记忆。

灌数据的顺序建议：**先 L4（人格与关系约定）→ 再 L2（人物画像）→ 最后 L3/L1（事件与事实）**。L4 是地基，灌晚了每轮都缺人格。
