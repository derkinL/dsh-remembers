# 体检报告：dsh-remembers（2026-11-08，v1.1.2 → 1.2.0）

审的对象是仓库 **`dsh-remembers`**（会话 `session-249816e4…` 里一直在改的那套「大肥鱼」插件），不是 DSH 本体。

## 结论先说

| 问题 | 结论 |
|---|---|
| 它是 DSH 插件吗？ | **是合法的 bundle**：宿主插件 + Web 客户端 + 自带 Python 服务。但「规范」只做到一半：缺显示元数据、缺 peer 声明、打包会泄漏用户数据、装不进插件列表。 |
| 别人能直接装吗？ | **改前不能**。Windows 安装脚本生成的配置语法无效、只拷 7 个文件（漏 `tools/`，加载即崩）、服务端不读 `.env.win`、数据目录重启后跑丢。改后走 `dsh plugin add file:`，两边脚本重写。 |
| 功能都是真的吗？ | 核心是真的：分层记忆、人格注入、学说话语料库、表情包、设置、语气后处理。**B 站、QQ、主动开口、贴吧扫码** 绑在作者环境上，别人装完用不了。另有 9 个死接口、1 套已废弃的学习写路径。 |
| 文件好找吗？ | 改前 60 个文件平铺，混着个人 VPS 脚本和第三方补丁；改后按 `docs/features/*` 给每个功能一份文件树，个人脚本隔离进 `ops/`。 |

这轮**修了 16 个 bug、4 处结构**（目录 / 打包 / 安装 / 文档），剩 4 件大件没动（见文末）。

---

## 一、DSH 插件规范符合度

对照 DSH 官方 bundle 规范（`cordis-plugin-development` 技能里的 host-plugin / ui-plugin 两份 checklist）逐条核：

| # | 要求 | 改前 | 结论 |
|---|---|---|---|
| 1 | `package.json` 声明 `dsh.bundle.patch` | ✅ `./cordis.patch.yml` | 合 |
| 2 | patch 是**顶层 YAML 数组**，`insert: [{id, name}]` | ✅ 仓库里的 patch 对 | 合（但安装脚本生成的是错语法，见 B2） |
| 3 | Host 导出 `apply(ctx, config)` + 可选 `inject` | ✅ `export function apply` / `inject = ["agents","sessions"]` | 合 |
| 4 | 声明 `Config` 让宿主校验配置 | ❌ 没有导出，`resolveConfig()` 自己兜 | **缺**（不致命，配置写错不会报错） |
| 5 | 客户端：`dsh.client.platform` + `./client` 导出 + `__ModuleLoader__` 协议 | ✅ 全都有（`test_client.mjs` 验证 49 条） | 合 |
| 6 | 插件页显示元数据：`locale/*.json` 的 `meta.title/description` + 图标 | ❌ 都没有，插件页只有裸包名、默认图 | **缺 → 已补** `locale/{zh,en}.json` + `icon.png` |
| 7 | `peerDependencies` 声明用到的宿主包 | ⚠ 只有 `dsh-llm`；代码却 `import("@deepseek-ai/dsh-tools")` | **缺 → 已补** `dsh-tools` |
| 8 | 打包清单只含运行时文件 | ❌ `files: ["service"]` 把 `service/data/`、`__pycache__/`、测试库、甚至用户 `memories.db` 一起打进 tarball | **危险 → 已改** 显式白名单 |
| 9 | 装完出现在「插件」列表、有启停开关 | ❌ 只进了 `dsh.profile.bundles`，没进 `dependencies` | **缺 → 安装器改走 `dsh plugin add`** |
| 10 | 不擅自改用户 profile | ⚠ patch 会插一个 id=`custom` 的 agent preset（带一大段 plan-mode 提示词） | 保留，但文档标注「装前合并同名预设」 |

> 第 9 条的机制：插件页的「已安装」按 profile 的 `dependencies` 判定；只手拷进 `node_modules` 再挂 bundles，功能照样跑，但没有行、没有开关、没有版本信息（会话 #4028 已诊断过一次）。

## 二、可安装性（Windows / VPS）

| 路径 | 改前 | 改后 |
|---|---|---|
| **Windows** `install.ps1` | B1 生成的 `cordis.patch.yml` 是 `plugins:` + 裸字符串，Loader 不认；B2 只拷 7 个文件，`index.mjs` 的 `./tools/tone.js` 直接 `ERR_MODULE_NOT_FOUND`；B3 `.env.win` 服务端**从来不读**；B4 写 `CMEM_PORT=8081` 但插件默认连 8080；B5 数据目录只在安装进程里设了 env，任务计划重启后落到 `C:\data` | 重写：`node install.mjs`（官方 `dsh plugin add file:`，没有 dsh 命令则手工登记）→ venv → `.env.win`（服务端真读）→ 端口 8080 对齐 → 任务计划不再依赖 env |
| **Linux** `install.sh` | 同样只拷 7 个文件；只进 bundles 不进 dependencies；要求服务已手动跑起来 | 重写：`dsh plugin add file:` 或手工登记 → venv → `.env` → 起服务 → 等 `/health`；systemd 交给 `service/deploy/deploy-native.sh` |
| **Docker** | `Dockerfile` 只 `COPY` 了 5 个 py 文件，`server.py` 会 import `extractor/llm/surprisal/scheduler` → 镜像启动即崩 | `COPY schema.sql *.py seeds.json` + `static/` |
| **默认语料** | `seeds.json`（1020 条）放在被 gitignore 的 `service/data/`，clone 下来是空的，README 却说「内置」 | 移到 `service/seeds.json` 并随包发布；服务端先找 `data/`，再回落到包里 |
| **插件页** | 无行、无开关 | 安装器写进 `dependencies`，插件页可见 |
| **卸载** | 没有说明 | 补进 [Windows 部署](deploy/windows.md) 末尾 |

另外：`SERVICE/data` 默认值原来是 `/data`（Docker 路径），裸跑/Windows 会试着写 `C:\data` 或根目录 —— 现在默认 `<repo>/service/data`，Docker 仍由 `CMEM_DATA_DIR=/data` 覆盖。

## 三、哪些功能其实没作用

| 功能 / 代码 | 现状 | 证据 | 这轮怎么处理 |
|---|---|---|---|
| **B 站全链路** | 需要外部 CLI，但路径不再是硬的 | `BILI_DIR` / `NODE_BIN` 改为 `CMEM_BILI_DIR` / `CMEM_NODE_BIN`，没设时按老布局推断 | ✅ 已支持任意机器（装好 CLI 即可） |
| **主动唤醒 / 日记 / 演化提醒** | 没 QQ 通道 = 不会开口 | `scheduler._inject()`：`if not self.inject_path: _log("no CMEM_INJECT_PATH")` | 结构如此，文档写清 |
| **QQ 面板** | 依赖第三方 `dsh-onebot-qq` | 原来 6 处 `if HOME == "/home/ubuntu"` 分支 | ✅ 抽成 `_profile_patch_path()` / `_onebot_media_dir()` / `_dsh_home()`，支持 `CMEM_DSH_PATCH` / `DSH_HOME` / `DSH_PROFILE` |
| **贴吧扫码登录** | 接口在，前端不调用 | `/tieba/qr/start`、`/tieba/qr/poll` 只在 `server.py` 出现；`client.js` 只走 Cookie 粘贴 | 标为未完成路径 |
| **`slang` 学习** | 已停写，只读历史数据 | 原来 `index.mjs:848` 调 `recordSlang()` → `POST /slang`，但没有任何注入读它 | ✅ 删掉写路径、死函数和 `_unusedSlang`；`/slang` 只留读接口兼容老数据 |
| **死接口** | 有路由、无调用方 | `/bili/thought`、`/consolidate`、`/memes/seen`、`/phrases/scene`、`/public/status`、`/public/toggle`、`/qq/cmd`、`/tieba/qr/*` | 列清单，暂不删（兼容旧前端/外部调用） |
| **`tasks` 表** | 有表、无工具、无接口 | `schema.sql` 建了 `tasks`；`index.mjs` 没有 create/complete 工具（README 却写「便签/任务」） | README 已改口径为「便签」 |
| **`patches/*.js`（78KB）** | 不是本插件的代码，是第三方 `dsh-onebot-qq` 的整文件副本 | 只在 `ops/` 手工覆盖时用 | 隔离到 `ops/patches-onebot/` |
| **`scripts/deploy-both.sh`、`deploy/proactive-inject.sh`** | 写死作者 VPS 的路径、端口、QQ 号、systemd 单元 | `/home/ubuntu/...`、`3169341724`、`28582` | 隔离到 `ops/`，不进包 |
| **`service/mcp_server.py`** | 另一条「MCP 接入」老路，和插件能力重复，无文档 | 只在 `/export` 注释里提过 | 保留为备用，不再在 README 推荐 |
| **`test/test_plugin.mjs` 的工具断言** | 期望 16 个工具、`learn_word`、`create_task`，实际 21 个工具且已改名 | 本地跑 14/17 失败 | 重写：21 个真名 + 没有 `dsh-tools` 时明确跳过 |

## 四、这轮修掉的 bug（有验证）

1. **`extractor` 静默吞掉 LLM 失败**：两次调用都拿不到响应时返回 `([], [])`，`process_turn` 于是报 `ok:true, facts:0`——抽取一直失败会被当成「没什么可记」。改成返回 `None` → `degraded: "extract-failed"`，由 `test_gating.py` 锁住。
2. **Docker 镜像缺 4 个模块**（见上）。
3. **`.gitignore` 编码损坏**：前 252 字节 UTF-8、后面是 GBK，`read`/编辑器直接报 invalid UTF-8。重写为纯 UTF-8。
4. **`PLUGIN_VERSION` 写死 `1.0.0`**（包版本 1.1.2），改成从 `package.json` 读。
5. **`memeDir` 默认 `/home/ubuntu/.dsh/media/...`**，改成 `~/.dsh/media/onebot/memes`。
6. **服务端完全不读 `.env` / `.env.win`**：安装说明让人填 `.env.win`，填了没用。现在启动时读（显式 env 优先）。
7. **数据目录默认 `/data`**，Windows 裸跑会跑丢。默认改到 `service/data`。
8. **默认语料不入仓**（见上）。
9. **npm 包会把 `service/data`、`__pycache__`、测试库打进去**（`files: ["service"]`），改成显式白名单后 55 个文件、1.1MB、无用户数据。
10. **测试与文档陈旧**：工具数 16→21、页面 7→9、slang 规则（`在吗/哈哈哈` 已被入口拦掉）、VPS 绝对路径、`run_all_tests.sh` 写死 `/home/ubuntu`。
11. **默认语料一导入就把「学说话」页打崩**：`expr_import_seeds()` 的 INSERT 把 `raw` 写进了 `last_hit`，而 `/learn/stats` 对它做 `float()` → `could not convert string to float: '龙族只有前三部'`。新装必现（只要导了 seeds）。修了三处：INSERT 的 `last_hit` 改为时间戳、启动时把历史的非数字 `last_hit` 归零、`_learn_stats` 单条转换失败不再拖垮整页。
12. **`_owner_qq()` 兜底写死作者 QQ 号**：解析不到时返回 `3169341724`，别人装了会把唤醒消息发给一个陌生人。改成 `CMEM_OWNER_QQ` > onebot `adminUsers` > `wakeChats` 第一个私聊 > 0（0 就跳过并记日志）。
13. **B 站路径写死**：`BILI_DIR`/`NODE_BIN` 改成 `CMEM_BILI_DIR`/`CMEM_NODE_BIN`，没配时按老布局/`which node` 推断。
14. **QQ/profile 路径写死**：6 处 `if HOME == "/home/ubuntu"` 分支抽成 `_profile_patch_path()` / `_onebot_media_dir()` / `_dsh_home()`，支持 `CMEM_DSH_PATCH`、`DSH_HOME`、`DSH_PROFILE`；VPS 两套布局行为不变。
15. **`install.sh --port 8081` 解析错**：`for arg in "$@"` 里 `shift` 不改变循环，`8081` 会被当成未知参数退出。改成 `while` 循环。
16. **`slang` 死写路径**：删除 `recordSlang()`、调用点和 `_unusedSlang`；`/slang` 只保留读接口兼容历史数据。

## 五、验证记录

```
node --check                      17 个 js/mjs 全过
run_all_tests.ps1                 9 个套件全绿（6 python + 3 node）
tests/node/test_client.mjs        49/49（含新增的 tieba / learn 页）
tests/python/test_seeds.py        11/11（last_hit 数字 / 幂等 / 老库修复）
npm pack --dry-run                60 files / 1.14MB，无 data、无 pycache、无测试
服务端实跑（8098, 空库）          /health 200、seeds 导入 1020 条、
                                  /learn/stats 1020、/state /proactive /expressions
                                  /persona /memories /tieba/status /config /notes
                                  /diary 全部 200；POST /ingest → /search 命中
md 相对链接                       56 条，0 断链
文本编码                          全仓 UTF-8，0 个坏文件
```

**没有验证的**（诚实说明）：

- **没在跑着的 DSH profile 里真装一次**：会改用户 profile、需要重启桌面端，不适合在审阅时动。安装命令用的是官方 `dsh plugin --profile <p> add file:<dir>`。
- **Linux / systemd / Docker build 没跑**（本机是 Windows；`deploy-native.sh` 原作者也标注「未在真实 Ubuntu 上跑过」）。
- **shell 语法没做 `bash -n`**：沙箱内 Git Bash 起不来（`couldn't create signal pipe`）。4 个移动过的部署脚本只改了 `cd` 基准目录，建议首次在 VPS 上跑时盯输出。

## 六、没动的大件（结构性问题）

| 大件 | 现状 | 为什么不动 |
|---|---|---|
| `client.js` | 5300 行单文件 | DSH 前端生态就是这么发的（`dsh-meme` 的 `client.js` 也 200KB）；拆模块要引入构建链 |
| `service/server.py` | 4900 行、91 路由、一个 `Handler` 类 | 拆 router 会动所有路由，收益是「好看」，风险是线上两套实例 |
| `index.mjs` | 2300 行 | 同上；钩子和工具注册耦合在 `apply` 闭包里 |
| B 站 / QQ 写死路径 | 作者机专用 | 要改就得引入配置项 + 迁移文档，超出本轮 |
| 死接口 | 保留 | 删了怕旧前端/外部脚本 404；先在文档里点名 |

## 七、下一步（按收益排序）

1. 把 B 站的 `BILI_DIR` / `NODE_BIN` 做成 env（`CMEM_BILI_DIR`、`CMEM_NODE_BIN`）——一步就能让别人也用上。
2. 删掉 `recordSlang()` 的写路径，或把 slang 接回注入；二选一，别两套并行。
3. `server.py` 按 `memory / persona / phrases / memes / bili / tieba / qq / admin` 拆 router（有测试兜底后再动）。
4. 真机跑一遍：Windows 全新安装、Linux systemd、`docker build`。
5. 发 npm（`npm publish`）后，README 的首选命令可以简化成 `dsh plugin add dsh-remembers`。
