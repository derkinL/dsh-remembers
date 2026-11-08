# 部署：Windows（本机）

支持 Windows 10/11。要点：**插件只是 Node 代码，记忆服务是独立的 Python 进程**，两件事分别装。

## 前置

| 项 | 要求 | 检查 |
|---|---|---|
| Node.js | ≥ 22.19（或 ≥ 24） | `node -v` |
| Python | ≥ 3.10，**python.org 版**（不要 Microsoft Store 占位版） | `python -c "import sys;print(sys.version)"` |
| DSH | 已装并能启动 | 设置里能看到 profile |

## 安装

```powershell
git clone https://github.com/derkinL/dsh-remembers
cd dsh-remembers

# 装到 desktop profile（默认 web）
.\install.ps1 -Profile desktop
```

脚本做两件事：

1. **插件**：调 `install.mjs`。优先 `dsh plugin --profile <p> add "file:<本目录>"`（会写进 profile 的 `dependencies`，插件页有行、有启停开关）；PATH 里没有 `dsh` 就退回手工登记（拷运行时文件 + 改 profile 的 `package.json`）。
2. **服务**：建 `service\.venv-win`、装 numpy、写 `service\.env.win`、后台启动、注册登录自启（任务计划 `dsh-remembers`）。

参数：`-Port 8080` 换端口、`-NoService` 只装插件、`-NoPlugin` 只准备服务。

## 装完三步

1. 填 key：`service\.env.win` → `CMEM_LLM_KEY=sk-xxx`（或者启动后在「她的记忆 → 记忆服务」里填）
2. 重启 DSH
3. 左边栏「插件」下面出现 **她的记忆**；进去先看「记忆服务」是不是 `llm_enabled: true`

## 验证

```powershell
# 服务健康
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/health | Select-Object -Expand Content

# 测试
.\run_all_tests.ps1
```

## 常见问题

**`.\install.ps1` 报「禁止运行脚本」**
用 `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop`，或先 `Set-ExecutionPolicy -Scope Process Bypass`。

**服务起来了，但抽取一直是 0**
`service\.env.win` 里的 key 没填 / 填错。改完在任务管理器结束 python 进程，或 `Stop-ScheduledTask dsh-remembers; Start-ScheduledTask dsh-remembers`。

**重启后服务没起 / 数据跑到别处**
1.2.0 起服务默认数据目录是 `service\data`（不再依赖环境变量），任务计划不需要额外 env。旧版把 `CMEM_DATA_DIR` 只设在安装进程里，重启就丢——已修。

**端口冲突**
`-Port 8081` 重装，然后在 profile 的 `cordis.patch.yml` 里给 `dsh-remembers` 加 `config: { endpoint: http://127.0.0.1:8081 }`。

## 卸载

```powershell
Stop-ScheduledTask dsh-remembers -ErrorAction SilentlyContinue
Unregister-ScheduledTask dsh-remembers -Confirm:$false -ErrorAction SilentlyContinue
dsh plugin --profile desktop remove dsh-remembers
# 数据要留就留：service\data\memories.db
```
