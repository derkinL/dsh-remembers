# dsh-onebot-qq 本地补丁合集

`dsh-onebot-qq` 是外部插件，以下几处改动**不在 npm 包里**，升级插件会被覆盖。
每次升级 `dsh-onebot-qq` 之后都要重新打一遍，或者确认上游已经修了。

改完都要重启 `dsh-web` / `dsh-web2`（client 半边才生效）。

> **2026-11-06 已从 0.9.4 升到 0.9.17**，两套都升了。升级过程踩了三个坑，
> 见文末「0.9.4 → 0.9.17 升级记录」，下次升级前先读那一节。

| # | 文件 | 改了什么 | 为什么 | 上游 0.9.17 |
|---|---|---|---|---|
| 1 | `lib/tools.js` | 白名单从 15 项恢复成 127 项 | 0.9.17 安全收紧，把 qzone/发消息/点赞/头像全砍了 | ❌ 收紧了 |
| 2 | `lib/tools.js` | `send_qzone_msg` 的本地图片转 base64 | NapCat 在 Docker 里读不到宿主机文件 | ❌ 没做 |
| 3 | `lib/bridge.js` | `source.kind` 按 `synthetic` 分叉 | 系统唤醒和真人私聊要能区分 | ❌ 仍写死 |
| 4 | `lib/outbound.js` | `stripActions` 保留文字颜 | 0.9.17 把整个函数删了 | ❌ 删了 |
| — | `lib/registry.js` | ~~重启时先 resume 旧会话~~ | 0.9.4 时代需要；**0.9.17 自己会 resume，不需要了** | ✅ 自带 |

---

## 1. 白名单恢复 127 项（tools.js）

### 现象

升级到 0.9.17 后，`qq_napcat_api` 的技能大面积失效：

```
qq_napcat_api: action 不在白名单内（get_group_member_list, get_group_member_info, ...）
```

### 根因

0.9.17 把白名单从 **127 项砍到 15 项**，而且 execute 里加了硬性拦截：

```js
const NAPCAT_API_WHITELIST = [
    'get_group_member_list', 'get_group_member_info', 'get_stranger_info',
    'get_forward_msg', 'get_record', 'get_file', 'upload_group_file',
    'upload_private_file', 'get_group_root_files', 'get_group_files_by_folder',
    'get_group_file_url', 'get_private_file_url', 'ocr_image',
    'get_ai_characters', 'send_group_ai_record',
];   // 就这 15 个

execute: async (args, exec) => {
    if (!NAPCAT_API_WHITELIST.includes(a.action)) {
        throw new Error('qq_napcat_api: action 不在白名单内');
    }
```

**被砍掉的**（她每天都在用的）：

- `send_qzone_msg` 等 **10 个 qzone action**（发说说、看列表、点赞、评论、删说说）
- `send_msg` / `send_private_msg`
- `send_like`（名片点赞）
- `set_qq_avatar`（换头像）
- `set_qq_profile`（改昵称签名）
- `delete_msg`（撤回）
- `set_friend_add_request` / `set_group_add_request`（处理申请）
- `delete_friend` / `set_group_leave` / `set_group_ban`
- `set_msg_emoji_like`（贴表情）
- …剩下 100 多个

### 补丁

把 0.9.4 的完整列表（127 项）搬回来：

```bash
# 从旧版（或备份）抠出整段，替换新版的
sed -n "/const NAPCAT_API_WHITELIST = \[/,/^\];/p" \
  dsh-onebot-qq.bak-0.9.4-*/lib/tools.js    # 拷这段
```

只替换 `const NAPCAT_API_WHITELIST = [...]` 那个数组，**不要动 execute**——
execute 的 `includes` 检查会随着数组恢复自动放行。

### ⚠️ 后来做成「面板可配」时踩的坑：别做长缓存

一开始把白名单做成前端面板（7 组 / 127 项逐项开关），插件侧读取时**缓存了 30 秒**。
结果：用户在面板上关了开关、服务端和文件都改了，但她**最多还要 30 秒才认**，
中途照样能调——看起来像「前端动画，实际没生效」。

正确做法：

```js
let _napcatBackoffUntil = 0;   // 只有失败才退避，成功一律不缓存

async function allowedNapcatActions() {
    const now = Date.now();
    if (now < _napcatBackoffUntil) return null;
    try {
        const r = await fetch(napcatMemoryEndpoint() + '/napcat/tools',
                              { signal: AbortSignal.timeout(3000) });
        if (!r.ok) { _napcatBackoffUntil = now + 30000; return null; }
        const d = await r.json();
        const set = new Set();
        for (const [a, on] of Object.entries(d.actions || {})) if (on === true) set.add(a);
        return set;   // 不缓存
    }
    catch {
        _napcatBackoffUntil = now + 30000;   // 服务端挂了才退避
        return null;
    }
}
```

**成功不缓存（本地 HTTP 几毫秒，换来面板一点就生效）；失败退避 30 秒（免得每次调用都等 3 秒超时）。**

实测（改完立刻验证）：

```
单 action：关 → 立刻禁止 ✅   开 → 立刻允许 ✅
整组：    开 → 立刻允许 ✅   关 → 立刻禁止 ✅
```

### 白名单现在怎么配

不是改代码了，走前端面板：

**设置 → QQ 通道 → 工具权限**

- 7 组：只读查询 48 / 发消息 23 / QQ 空间 7 / 文件 10（默认开）
  群-好友管理 19 / 危险操作 9 / 账号与凭证 11（默认关）
- 组可展开，每个 action 一个开关；组头右上角整组全开/全关
- **界面全中文**（"获取登录信息""发说说""删除好友"…），鼠标悬停才看英文 action 名

存 `service/data/napcat_tools.json`（逐 action 的 `{action: bool}`）。

而代码里那份 `NAPCAT_API_WHITELIST` 现在只当**兜底**用（服务端拿不到配置时全开）。

### 注意

这是**故意的安全收紧**，不是 bug。上游可能觉得"全量 127 项"太危险
（能删好友、退群、改配置）。我们恢复它是因为这个 agent 需要这些能力。

如果以后只想要一部分，可以只加回必要项，别整个恢复。

---

## 2. `send_qzone_msg` 本地图片转 base64（tools.js）

### 现象

她发 QQ 空间说说带图，NapCat 报：

```
[Bridge.Action] send_qzone_msg failed:
  第 1 张图片上传失败: ENOENT: no such file or directory,
  stat '/home/ubuntu/.dsh/media/onebot/memes/xxx.jpg'
```

### 根因

`qq_napcat_api` 是**纯透传**，没有做任何路径处理。而 NapCat 的 `images`
虽然官方支持 `file://` / `http(s)://` / `base64://`（源码 `SendQzoneMsg.ts` 里
写着「自动上传」），但 **`file://` 是相对 NapCat 自己的文件系统**：

| 部署方式 | `file://` 能不能用 |
|---|---|
| **Docker**（SnowLuma） | ❌ 容器只挂了 `/app/.config`、`/app/data`、`/app/.local/share`，看不到宿主机 `~/.dsh/media` |
| **本地 / Windows 直跑** | ✅ 本来就能读 |

### 补丁

在 `qq_napcat_api` 的 execute 里，只针对 `send_qzone_msg`，把本地路径读出来转 `base64://`：

```js
if (a.action === 'send_qzone_msg' && Array.isArray(params.images) && params.images.length > 0) {
    const roots = await mediaRoots(bridge, exec);
    const cap = Number(limits?.maxImageBytes) || 8 * 1024 * 1024;
    params.images = await Promise.all(params.images.map(async (item) => {
        const raw = String(item ?? '').trim();
        if (raw === '') return raw;
        // http(s) / 已经是 base64 的，原样交给 NapCat
        if (/^https?:\/\//i.test(raw) || raw.startsWith('base64://')) return raw;
        // file:// 后面可能是 POSIX 路径、Windows 盘符、或 URL 编码过的
        let local = raw.replace(/^file:\/\//i, '');
        try { local = decodeURIComponent(local); } catch { /* 原样用 */ }
        // Windows: file:///C:/a/b.jpg → /C:/a/b.jpg，多一个斜杠
        if (/^\/[A-Za-z]:[\\/]/.test(local)) local = local.slice(1);
        return await fencedMediaFile(local, cap, roots);
    }));
}
```

复用了插件自带的 `fencedMediaFile()` → `fileToBase64()`，**自带大小上限和媒体目录白名单**，不用自己写检查。

### 为什么统一转 base64 而不是分平台判断

| 部署方式 | 改前 | 改后 |
|---|---|---|
| Docker | ❌ ENOENT | ✅ base64 通 |
| 本地 / Windows | ✅ 通 | ✅ 也通（base64 是通用格式） |

**两种部署都兼容，不需要分平台。** 代价只是本地部署时多一次读文件 + base64 编码。

### 已知限制

- `mediaRoots()` 是媒体目录白名单。图片放在白名单外的目录（比如 `/tmp`）会被拦，
  报「本地路径不在允许的媒体目录内」。这是**故意的**，别为了发一张图把白名单放开。
- 大图会变成很长的 base64 字符串。上限沿用 `limits.maxImageBytes`（默认 8 MB）。

---

## 3. `source.kind` 按 synthetic 分叉（bridge.js）

### 现象

定时唤醒注入的是**一条假的私聊消息**，下游（dsh-remembers）把它当成"老大说的话"，
写进记忆、学成口头禅、涨亲密度、甚至把自己的画像名字覆盖成「系统」。

### 根因

`bridge.js` 里建消息只有一处，`source.kind` 写死：

```js
chat.agent.followup(createUserMessage({
  content: [{ type: 'text', text: final }],
  source: { kind: 'plugin:dsh-onebot' },   // ← 真人私聊和系统唤醒盖同一个章
}));
```

### 补丁

**(a) `handleInbound` 把 `event.synthetic` 带进 round：**

```js
? runInjectRound({ traceId: newTraceId(), intercepted: 0,
                   silent: event?.silent === true,
                   synthetic: event?.synthetic === true }, run)
```

**(b) 两处建消息时按标记分叉**（`bridge.js` 里有 2 处 `source: { kind: ... }`）：

```js
source: { kind: currentInjectRound()?.synthetic === true
    ? 'system:nudge'
    : 'plugin:dsh-onebot' },
```

配合调度器侧：注入事件带 `"synthetic": true`、`"nickname": ""`。

dsh-remembers 的 `isSynthetic()` 对 `system:nudge` 返回 true → 唤醒轮不写记忆、
不学口头禅、不涨亲密度、不覆盖画像。

---

## 4. `stripActions` 恢复（outbound.js）

### 现象

0.9.17 **把整个 `stripActions` 删了**，出站只做 `stripMarkdown`，不再处理括号动作。

结果：她要是写了 `（尾巴一甩）`、`(smiles)` 这种旁白，会**原样发到 QQ**。

（人格卡里写了「不写动作/旁白」，但这是个兜底，删了就没保险了。）

### 补丁

从 0.9.4 抠回整个 `stripActions` 函数，插在 `stripBoundaryLeakage` 之前，
然后在出站调用点包一层：

```js
const plain = stripActions(stripMarkdown(clean));   // 原来是 stripMarkdown(clean)
```

函数本体（判据是"括号里含汉字或≥2个英文字母 = 动作"）：

```js
function stripActions(text) {
    const isAction = (inner) => {
        const s = String(inner == null ? '' : inner);
        return /[\u4e00-\u9fa5]/.test(s) || /[A-Za-z]{2,}/.test(s);
    };
    return text
        .replace(/（([^）]{0,120})）/g, (m, inner) => (isAction(inner) ? '' : m))
        .replace(/【([^】]{0,120})】/g, (m, inner) => (isAction(inner) ? '' : m))
        .replace(/\(([^)]{0,120})\)/g, (m, inner) => (isAction(inner) ? '' : m))
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
```

### 注意

回调必须是 `(m, inner)` —— **只有一个捕获组**。早先误写成 `(m, _open, inner)`，
`inner` 拿到 `undefined`，结果一个都没删。

---

## 0.9.4 → 0.9.17 升级记录（2026-11-06）

### 三个坑

#### 坑 ①：白名单从 127 砍到 15

见上面补丁 1。**升级后必须立刻检查白名单**，否则 `qq_napcat_api` 大面积失效。

#### 坑 ②：`retired-sessions.json` 是 append-only，resume 失败就永久拉黑 ⚠️

升级主套后发现 `chat-sessions.json` 里**主人的映射不见了**：

```json
{"group:1131874229": "...", "private:2875517235": "..."}   // 没有 private:3169341724
```

折腾半天才找到根因在 `media/onebot/retired-sessions.json`：

```json
["onebot-private-3169341724", "...mvno3ded", ..., "onebot-private-3169341724-mvp8v0i5"]
                                                          ↑ 主人的当前会话在名单里
```

`registry.js` 的 `loadMapping()` 遇到退役 id **直接 continue**，而且日志是 debug 级：

```js
if (this.retiredSessionIds.has(sessionId)) {
    this.deps.log('debug', 'skipping resume of retired session ...');
    continue;   // 既不 resume，也不写回 chat-sessions.json
}
```

**什么时候会被加进退役？** `loadMapping` 的 catch：

```js
catch (error) {
    this.retireSession(sessionId);   // ← 一次 resume 失败 = 永久退役
}
```

**这次的触发原因**：升级过程中我把 `preset-custom` 从 profile 的 `cordis.patch.yml`
删掉了（搬进插件的 bundle patch 做去重），中间某次重启 `resumeChat` 解析不到 custom
预设 → 抛错 → 会话被拉黑。

**修复步骤**：

```bash
# 1. 停服务（必须停，否则内存会覆盖文件）
sudo systemctl stop dsh-web

# 2. 从退役名单摘掉目标会话
#    编辑 media/onebot/retired-sessions.json，删掉那一行 id

# 3. 恢复映射
#    编辑 media/onebot/chat-sessions.json，加回：
#    "private:3169341724": "onebot-private-3169341724-mvp8v0i5"

# 4. 起服务，看日志
sudo systemctl start dsh-web
journalctl -u dsh-web --since '1 min ago' | grep -E 'attached session|bridge ready'
# 期望：bridge ready (3 resumed chat(s))  ← 数量对得上
```

**排查口诀**：会话莫名其妙不见了 → 先看 `retired-sessions.json`，
再看 `chat-sessions.json`，最后才怀疑会话文件本身。

#### 坑 ③：改 agent 预设会让已有会话 resume 失败

接坑 ②。主套的会话 `agentPreset: "custom"`，如果 `custom` 预设在中途消失过
（哪怕只是几秒），下一次重启 resume 就会失败，然后被永久退役。

**所以改预设位置时（profile patch ↔ 插件 bundle patch）要一次改完 + 立刻重启验证**，
不要中间留一个"预设不存在"的窗口。

### 升级流程（下次照做）

```bash
# 0. 备份
cp -a $PLUGIN_DIR $PLUGIN_DIR.bak-$(date +%Y%m%d%H%M%S)

# 1. 下载新版并对比
curl -sL $(npm view dsh-onebot-qq dist.tarball) | tar xz
diff -r old/lib new/lib | head -50

# 2. 看白名单有没有变
sed -n "/const NAPCAT_API_WHITELIST = \[/,/^\];/p" new/lib/tools.js | grep -c "'"
# 少于 100 说明被砍了，需要补丁 1

# 3. 替换
rm -rf $PLUGIN_DIR/lib && cp -a new/lib $PLUGIN_DIR/lib
cp new/package.json $PLUGIN_DIR/

# 4. 打 4 个补丁（本文档 1-4 节）

# 5. 语法检查
node --check $PLUGIN_DIR/lib/tools.js

# 6. 重启 + 验证
sudo systemctl restart dsh-web
sleep 15
journalctl -u dsh-web --since '1 min ago' | grep -E 'OneBot connected|bridge ready|resume failed'
# bridge ready 的数量要和 chat-sessions.json 里的条目数一致

# 7. 检查退役名单
cat $DSH_HOME/media/onebot/retired-sessions.json
# 如果当前在用的会话 id 出现在里面 → 按坑 ② 修复
```

---

## 应用方法

两套 profile 各改一次：

```bash
# 主套
$DSH_HOME/profiles/web/node_modules/dsh-onebot-qq/lib/

# 第二套
$DSH_HOME2/profiles/qq2/node_modules/dsh-onebot-qq/lib/
```

改完：

```bash
sudo systemctl restart dsh-web dsh-web2
# 或者本地部署：重启 dsh
```

## 升级插件之后

`dsh plugin --profile <p> add dsh-onebot-qq@latest` 之类会把这四个文件覆盖回上游版本。
**升级后按上面的行号/片段逐条核对**，缺哪条补哪条，然后重启。

```bash
cp -r lib lib.bak-before-upgrade
```

升级前备份整个 `lib/`，出问题能立刻回退。
