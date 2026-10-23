# 裸跑部署（不用 Docker）—— 默认路径

> **这是默认部署方式。** 一条命令：`sudo ./deploy-native.sh`。
>
> 诚实说明：这个脚本是在 Windows 上写的，**还没在真实 Ubuntu 上跑过一遍**（开发机没有 systemd）。它是照本文的手工步骤逐条实现的，但第一次部署请盯着每一步输出，尤其「等待健康检查」那一段。出问题就照下面的手工步骤逐条对照，两边的逻辑是一致的。

Docker 只是**选项**，不是依赖。`requirements.txt` 里只有 `numpy>=1.26`，`Dockerfile` 的结尾就是 `python server.py`——没别的魔法。

## 先记住一件事：端口要对齐

服务默认 `127.0.0.1:8080`。**插件默认连的也是 8080。**

如果你把服务放到别的端口（比如为避让改成 8081），必须同时做两件事，否则插件每步召回都静默失败：

```bash
# ① 服务端口
service/.env  →  CMEM_PORT=8081

# ② 让插件知道真实地址（二选一）
export CMEM_URL=http://127.0.0.1:8081          # DSH 的运行环境里
# 或写进 profile 的 cordis.patch.yml：
#   - insert:
#       - id: dsh-remembers
#         name: 'dsh-remembers'
#         config:
#           endpoint: http://127.0.0.1:8081
```

`./install.sh` 会从 `.env` 读端口做健康检查，并在端口不是 8080 时把上面这段提示打出来。

这份清单给你在 VPS 上裸跑。原则和 Docker 版一样：**别人拿不到、开机自启、崩溃自己起、备份别跳过。**

## 什么时候值得裸跑

| 适合 | 不适合 |
|---|---|
| VPS 没装 Docker / 不想装 | 已经为别的服务装了 Docker，顺手一起管 |
| 内存紧（镜像约 200MB 常驻） | 想让服务和系统彻底隔离 |
| 更新要快（`git pull` + `restart`，不用 build） | 多人/多服务共用一台机器，想统一编排 |

裸跑最大的额外好处：**更新不用重建镜像**。Docker 那条路改一行 `server.py` 就得 `up -d --build`，裸跑只 `systemctl restart`。

## 一、装依赖

```bash
cd /opt/dsh-remembers/service
apt install -y python3 python3-venv          # Debian/Ubuntu；Alpine 用 apk add python3 py3-numpy
python3 -m venv /opt/dsh-remembers/venv
/opt/dsh-remembers/venv/bin/pip install -r requirements.txt
```

只要 numpy。装完验一下：

```bash
/opt/dsh-remembers/venv/bin/python -c "import numpy; print(numpy.__version__)"
```

## 二、目录与用户（记忆是隐私，别用 root 跑）

```bash
mkdir -p /opt/dsh-remembers/service/data
chmod 700 /opt/dsh-remembers/service/data

useradd -r -s /usr/sbin/nologin cmem 2>/dev/null || true
chown -R cmem:cmem /opt/dsh-remembers/service/data
```

## 三、配置 `.env`

```bash
cd /opt/dsh-remembers/service
cp -n .env.example .env
chmod 600 .env
nano .env      # 至少填 CMEM_EMBED_* 和 CMEM_LLM_*
```

**裸跑和 Docker 最大的差别在这里**：`server.py` **不会自动读 `.env`**（它只认 `os.environ` 和 `data/config.json`）。所以 `.env` 必须由 systemd 注入，见下一步。

## 四、systemd unit

```bash
cat > /etc/systemd/system/dsh-remembers.service <<'EOF'
[Unit]
Description=companion-memory (dsh-remembers 记忆服务)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cmem
Group=cmem
WorkingDirectory=/opt/dsh-remembers/service

# .env 在这里注入。要求 KEY=VALUE 一行一条，不支持 shell 语法。
EnvironmentFile=/opt/dsh-remembers/service/.env
Environment=CMEM_DATA_DIR=/opt/dsh-remembers/service/data
Environment=CMEM_HOST=127.0.0.1
Environment=CMEM_PORT=8080

ExecStart=/opt/dsh-remembers/venv/bin/python server.py
Restart=on-failure
RestartSec=3

# 加固：只让 data 目录可写，其余全只读
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/dsh-remembers/service/data

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now dsh-remembers
systemctl status dsh-remembers --no-pager
```

验证：

```bash
curl -s localhost:8080/health | python3 -m json.tool
journalctl -u dsh-remembers -n 30 --no-pager
```

`embedding.enabled: true` 才算 `.env` 真的进去了。如果是 `false`，先查 `journalctl` 里有没有 `config=(env only)`，再确认 `EnvironmentFile` 路径对不对。

## 五、备份（**必须改，别直接用 install-cron.sh**）

`install-cron.sh` 里写死了 `docker compose exec`，裸跑用不了。手写一条 cron：

```bash
sudo crontab -u cmem -e
```

```cron
10 4 * * * cd /opt/dsh-remembers/service && /opt/dsh-remembers/venv/bin/python backup.py backup --keep 14 >> /var/log/dsh-remembers-backup.log 2>&1
```

**关键：用 `crontab -u cmem`，不要用 root 的 cron。**

原因：SQLite 的 WAL 文件和锁会继承写入者的属主。root 跑一次备份，`data/` 里就多出 root 属主的文件，而服务是 `cmem` 在跑——下一次写入会 `database is locked` 或者干脆写不进去。这个坑排查起来很烦，一开始就别踩。

日志文件先给权限：

```bash
sudo touch /var/log/dsh-remembers-backup.log
sudo chown cmem:cmem /var/log/dsh-remembers-backup.log
```

验一次：

```bash
sudo -u cmem /opt/dsh-remembers/venv/bin/python /opt/dsh-remembers/service/backup.py list
```

## 六、更新（比 Docker 快，不用 build）

```bash
cd /opt/dsh-remembers
git pull
# 只在 requirements.txt 变过时才需要：
/opt/dsh-remembers/venv/bin/pip install -r service/requirements.txt
systemctl restart dsh-remembers
curl -s localhost:8080/health | python3 -m json.tool
```

插件侧（`index.mjs` 那些）仍然要重跑 `./install.sh --no-service` 并重启 DSH——**那部分和 Docker 无关**。

| 改了什么 | 要做什么 |
|---|---|
| `service/*.py` | `systemctl restart dsh-remembers` |
| `service/requirements.txt` | 先 `pip install` 再 restart |
| `index.mjs` / `client.js` / `config.mjs` | `./install.sh --no-service` + 重启 DSH |
| 只改 `README` / `docs` | 什么都不用做 |

## 七、迁移 / 回滚

数据就是 `service/data/` 一个目录（`memories.db` + WAL + `config.json` + `backups/`）。

- **从 Docker 换裸跑**：先 `docker compose down`，再把 `service/data/` 的属主改成 `cmem`：
  ```bash
  sudo chown -R cmem:cmem /opt/dsh-remembers/service/data
  ```
- **换回 Docker**：反过来把属主改回来，`docker compose up -d`。
- **回滚代码**：`git checkout <上一个 commit>` + `systemctl restart`，数据不受影响。

## 八、两种方式对照

| | Docker | 裸跑 |
|---|---|---|
| 部署 | `./deploy.sh` 一条 | venv + unit + 改 cron |
| 更新服务代码 | `up -d --build`（慢） | `git pull` + `restart`（快） |
| 开机自启 | `restart: unless-stopped` | systemd `enable` |
| 日志 | `docker compose logs` | `journalctl -u dsh-remembers` |
| 隔离 | 强 | 靠 systemd 加固（已给） |
| 磁盘 | 镜像约 200MB | 几 MB |
| 备份命令 | `docker compose exec ... backup.py` | `venv/bin/python backup.py` |
| 更新插件侧 | 一样：`install.sh` + 重启 DSH | 一样 |
