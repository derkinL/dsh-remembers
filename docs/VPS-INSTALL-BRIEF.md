# 任务简报：在 VPS 上部署 dsh-remembers（人格 + 记忆一体插件）

> 这份是写给**执行部署的 AI 代理**看的，不是给人看的教程。照着做，每一步都跑验证，验证不过就停。

## 你要完成什么

在**本机（这台 VPS）**上：
1. 起 `companion-memory` 记忆服务（Docker，端口 8080）
2. 把 `dsh-remembers` 插件装进本机的 DSH profile
3. 灌入人格设定
4. 确认插件真的加载了、服务真的在收消息

最终效果：本机 DSH 里的 AI 每轮都带「人格段」，并且会检索长期记忆。

## 硬边界（先读，别越界）

1. **不要动防火墙、不要动云厂商安全组、不要把 8080 暴露到公网**。本机自用绑 `127.0.0.1:8080` 就够。
2. **不要删除或覆盖** `~/.dsh/profiles/*/` 下已有的其它插件。
3. **只装用户指定的那一个 profile**，不要顺手装到别的 profile。
4. **需要用户提供的东西（embedding key、私钥）停下来问**，不要编、不要填占位符冒充完成。
5. **每一步都跑验证命令**。验证不过就停下报告现状，不要跳过继续往下走。
6. 不要把记忆数据（`service/data/`）外传、打印到日志或提交到 git。

## 第 0 步：确认现状（跑完把结果记下来）

```bash
node -v
docker compose version
ls ~/.dsh/profiles/
```

把 **profile 名**记下来（通常 `web` 或 `desktop`），下文用 `<PROFILE>` 指代。

另外确认代码在不在、是不是**新版**：

```bash
ls /opt/dsh-remembers/package.json
grep -c 'remembers:persona' /opt/dsh-remembers/index.mjs
```

- `grep` 结果必须是 **≥1**。如果是 `0`，说明拿到的是**旧版本**（没有人格功能）——停下来告诉用户，让他重新传最新代码。
- 目录不存在的话：

```bash
git clone https://github.com/derkinL/dsh-remembers /opt/dsh-remembers
```

克隆完**再跑一次上面那条 grep**，同样必须 ≥1。

## 第 1 步：起记忆服务

```bash
cd /opt/dsh-remembers/service
cp -n .env.example .env
```

编辑 `.env`，填这三行（值向用户要）：

```bash
CMEM_EMBED_BASE=https://你的端点/v1
CMEM_EMBED_KEY=sk-xxxx
CMEM_EMBED_MODEL=qwen3.7-text-embedding-flash
```

然后：

```bash
chmod +x deploy.sh
./deploy.sh
```

**验证：**

```bash
curl -s localhost:8080/health | python3 -m json.tool
```

- 通过条件：`"ok": true`
- `embedding.enabled` 期望是 `true`。如果是 `false`，把 `last_error` 原文记下来继续（纯关键词检索也能用，但语义召回会失效）。

## 第 2 步：装插件

```bash
cd /opt/dsh-remembers
chmod +x install.sh
DSH_PROFILE=<PROFILE> ./install.sh --no-service
```

`--no-service` 是必须的（服务刚起好了，脚本不用再检查）。

**验证：**

```bash
grep -o 'dsh-remembers' ~/.dsh/profiles/<PROFILE>/package.json
node --check ~/.dsh/profiles/<PROFILE>/node_modules/dsh-remembers/index.mjs
echo "check_exit=$?"
```

两条都要成功。`install.sh` 会自己备份旧版本、跑一次语法检查、把插件名写进 `dsh.profile.bundles`。

## 第 3 步：重启 DSH

按本机实际方式重启（`systemctl restart dsh` / `dsh --profile <PROFILE>` / 容器重启，看你们怎么装的）。

**验证**：日志里必须出现这一行，原文照抄给用户确认：

```
[dsh-remembers] loaded {"version":"1.0.0","endpoint":"http://127.0.0.1:8080",...}
```

**没有这行 = 插件没加载。** 排查顺序：
1. `~/.dsh/profiles/<PROFILE>/package.json` 的 `dsh.profile.bundles` 里有没有 `dsh-remembers`
2. `~/.dsh/profiles/<PROFILE>/node_modules/dsh-remembers/index.mjs` 在不在
3. 启动日志里有没有插件加载报错（peer 版本、语法错误）

## 第 4 步：灌人格（**不做这步等于白装**）

人格段是「宪法区 + 自我认知区」两半，**两半都空时整段不注入**。所以装完感觉「没生效」通常不是 bug，是空着。

内容向用户要；用户没给就先停在这里，别自己编一个人格塞进去。

```bash
curl -s -X POST localhost:8080/persona \
  -H 'Content-Type: application/json' \
  -d '{"constitution":"<用户给的人格正文>","self_model":""}'
```

**验证：**

```bash
curl -s localhost:8080/persona | python3 -m json.tool
```

`constitution` 要等于刚写的内容，`chars.constitution` 应该 > 0。

生效方式：**开一个新会话**就会带上（新会话会强制刷新人格缓存，不用等 60 秒周期）。

## 第 5 步：确认服务真的在收消息

先随便跟 AI 说一句话，然后：

```bash
curl -s "localhost:8080/log?limit=5" | python3 -m json.tool
```

期望看到 `outcome` 是 `ok` 或 `no_match` 的记录。

**全是空数组 = 插件没把消息送上去**，回到第 3 步查加载。

## 第 6 步：备份（建议做，别跳）

```bash
cd /opt/dsh-remembers/service
chmod +x install-cron.sh
./install-cron.sh
```

脚本是幂等的，而且**装之前会真跑一次备份**——跑不通就不写 cron，不会给你留一个永远失败的定时任务。

手动验一次：

```bash
docker compose exec companion-memory python backup.py list
```

## 已知坑（踩到了先看这里）

| 症状 | 原因 | 解法 |
|---|---|---|
| 改了代码但行为没变 | 只 `docker compose restart`，代码在镜像里 | `docker compose up -d --build` |
| 装完「人格没生效」 | 宪法和自我认知都是空 | 跑第 4 步 |
| 插件连不上服务，日志静默 | 服务设了 `CMEM_AUTH_TOKEN`，插件没带 | 在 DSH 的运行环境里 `export CMEM_AUTH_TOKEN=<同一个值>` |
| profile 起不来 / JSON 解析错 | `package.json` 带 BOM | `install.sh` 已处理；手工改过的话去掉 BOM |
| 语义召回完全没反应 | `embedding.enabled=false` | 查 `.env` 三行，改完 `docker compose up -d --build` |
| 检索老是空 | 库还是空的，或阈值太高 | `curl localhost:8080/log?limit=20` 看 `outcome` |
| DSH 不在本机 | 插件默认连 `127.0.0.1:8080` 不通 | 走 SSH 隧道，或给插件设 `CMEM_URL` |

## 完成后，向用户报告这些（原文，不要概括）

1. `<PROFILE>` 是什么
2. `curl -s localhost:8080/health` 的完整返回
3. `curl -s localhost:8080/persona` 的完整返回
4. 日志里 `[dsh-remembers] loaded` 那一行的原文
5. `curl -s "localhost:8080/log?limit=5"` 的结果
6. 哪些步骤跳过了 / 失败了，以及原因

**不要**在报告里说「全部完成」而实际有一步没过——这套东西最怕的就是静默失败。

## 附：更新已有部署

如果这台机器已经装过旧版本，**别重装整套**，只做这三步：

```bash
cd /opt/dsh-remembers
git pull
DSH_PROFILE=<PROFILE> ./install.sh --no-service
cd service && docker compose up -d --build
```

然后重启 DSH，确认日志里 `[dsh-remembers] loaded` 还在。

三条注意：

| 项 | 说明 |
|---|---|
| 不会丢东西 | `install.sh` 先把旧版本挪成 `dsh-remembers.bak.<时间戳>`，再覆盖 |
| `--build` 不能省 | `server.py` / `extractor.py` 的改动在镜像里，只 `docker compose restart` 不生效 |
| 数据不用迁 | `persona` 和 `memory` 都在 `data/memories.db`；schema 用 `CREATE TABLE IF NOT EXISTS`，服务启动自动补表 |

更新完可以顺手验一下新端点回来了没有：

```bash
curl -s -X POST localhost:8080/episode -H 'Content-Type: application/json' \
  -d '{"turns":[{"user":"测试","assistant":"收到"}],"window":"test"}'
```

返回 `{"ok": false, "degraded": "llm-disabled"}` 也是正常的——说明端点在了，只是还没配 LLM（要配 `CMEM_LLM_*` 才会真的压缩）。返回 404 才是没更新成功。
