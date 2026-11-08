# 部署：Linux / VPS（裸跑，systemd）

推荐路径。不需要 Docker；服务端只要 Python 3.10+ 和 numpy。

## 一、装插件 + 服务

```bash
git clone https://github.com/derkinL/dsh-remembers
cd dsh-remembers

# 装到 web profile（默认）；DSH_PROFILE=desktop 可换
bash install.sh
```

`install.sh` 会：装插件（`dsh plugin add file:<本目录>`，失败则手工登记）→ 建 `venv/` → 装 numpy → 写 `service/.env` → 后台起服务 → 等 `/health`。

参数：`--no-service` 只装插件、`--no-plugin` 只准备服务、`--port 8081` 换端口。

## 二、systemd（开机自启 + 崩溃重启）

```bash
sudo bash service/deploy/deploy-native.sh
```

它会建 `cmem` 用户、`service/data`、`/etc/systemd/system/dsh-remembers.service`，并启动。

不想用脚本就手写一份（关键几条）：

```ini
[Unit]
Description=dsh-remembers memory service
After=network-online.target

[Service]
User=cmem
WorkingDirectory=/opt/dsh-remembers/service
EnvironmentFile=/opt/dsh-remembers/service/.env
ExecStart=/opt/dsh-remembers/venv/bin/python server.py
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/dsh-remembers/service/data

[Install]
WantedBy=multi-user.target
```

> 服务启动时会自己读 `service/.env`（KEY=VALUE），不必依赖 systemd 注入；但用 `EnvironmentFile` 也没问题，显式 env 优先。

## 三、验证

```bash
curl -s localhost:8080/health | python3 -m json.tool
journalctl -u dsh-remembers -n 30 --no-pager
```

`llm` 段要 `enabled: true`；`embedding.enabled` 为 `false` 只代表没配向量（会退化成 BM25）。

## 四、备份（**别跳**）

```bash
sudo crontab -u cmem -e
# 每天 04:10，留 14 份
10 4 * * * cd /opt/dsh-remembers/service && /opt/dsh-remembers/venv/bin/python backup.py backup --keep 14 >> /var/log/dsh-remembers-backup.log 2>&1
```

务必用 `crontab -u cmem`：root 跑一次会在 `data/` 里留下 root 属主的 WAL 文件，之后服务就写不进去了。

## 五、更新

```bash
cd /opt/dsh-remembers
git pull
systemctl restart dsh-remembers          # 只改了 service/*.py 时够
bash install.sh --no-service             # 改了插件（index.mjs/client.js）才需要
```

| 改了什么 | 要做什么 |
|---|---|
| `service/*.py`、`schema.sql` | `systemctl restart dsh-remembers` |
| `service/requirements.txt` | `venv/bin/pip install -r service/requirements.txt` 再 restart |
| `index.mjs` / `client.js` / `config.mjs` | `bash install.sh --no-service` + 重启 DSH |
| 只改 `docs/` | 不用 |

## 六、端口 / 鉴权

- 服务默认 `127.0.0.1:8080`（`service/.env` 里 `CMEM_HOST`/`CMEM_PORT`）。
- 跨机访问：`CMEM_HOST=0.0.0.0` + `CMEM_AUTH_TOKEN=<随机串>`，插件侧配 `authToken`；或者更稳的 SSH 隧道（`ssh -N -L 8080:127.0.0.1:8080 user@vps`）。
- 改端口后，profile 的 `cordis.patch.yml` 里给 `dsh-remembers` 加 `config: { endpoint: http://127.0.0.1:<端口> }`。

## 七、多套实例（双人格）

每套要**独立数据目录 + 独立端口**：

```bash
CMEM_DATA_DIR=/opt/remembers-data/2 CMEM_PORT=8081 /opt/dsh-remembers/venv/bin/python /opt/dsh-remembers/service/server.py
```

插件侧用不同的 `endpoint` 指过去。别共用数据目录，也别共用 QQ 出口 IP（会互相拖累风控）。
