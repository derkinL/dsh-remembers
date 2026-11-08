# 部署：Docker（只容器化记忆服务）

插件永远装在 DSH 那台机器上（Node 侧），Docker 只用来跑 Python 服务。

> 不推荐当默认路径：镜像约 200MB，更新要 rebuild。只有「机器上已经一堆容器要统一编排」时才划算。

## 起服务

```bash
cd service
cp .env.example .env && chmod 600 .env     # 填 CMEM_LLM_* / CMEM_EMBED_*
bash deploy/deploy.sh                       # 构建 + 启动 + 等健康检查
curl -s localhost:8080/health | python3 -m json.tool
```

`docker-compose.yml` 默认只绑 `127.0.0.1:8080`，数据挂在 `service/data`。

## 插进 DSH

在 DSH 那台机器上（可以就是同一台）：

```bash
bash install.sh --no-service --port 8080
```

服务在别处时，让插件知道地址：profile 的 `cordis.patch.yml`

```yaml
- id: dsh-remembers
  config:
    endpoint: http://<host>:8080
    authToken: <和 CMEM_AUTH_TOKEN 一致>
```

跨机优先 SSH 隧道，别把 8080 裸放公网。

## 备份

```bash
docker compose exec -T companion-memory python backup.py backup --keep 14
docker compose exec -T companion-memory python backup.py list
```

定时：`bash deploy/install-cron.sh`（自动识别 Docker / 裸跑）。

## 更新

```bash
git pull
cd service && bash deploy/deploy.sh        # 会 rebuild
```

改了 `service/*.py` 必须 rebuild（代码在镜像里），只 `restart` 不生效。

## 排错

| 现象 | 查什么 |
|---|---|
| 容器起不来 | `docker compose logs --tail 100`（1.2.0 前 Dockerfile 漏拷模块，导入即崩，已修） |
| `/health` 404 | 端口没通 / `CMEM_PORT` 改过但 compose 没改 |
| `embedding.enabled=false` | `.env` 的 BASE/MODEL 有一个空；改完要 `up -d` 重建容器 |
| 检索老空 | `curl localhost:8080/log?limit=20` 看 `outcome`，全 `no_match` = 库空或阈值太高 |
