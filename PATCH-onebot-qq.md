# dsh-onebot-qq 本地补丁合集

`dsh-onebot-qq` 是外部插件，以下几处改动**不在 npm 包里**，升级插件会被覆盖。
每次升级 `dsh-onebot-qq` 之后都要重新打一遍，或者确认上游已经修了。

改完都要重启 `dsh-web` / `dsh-web2`（client 半边才生效）。

| # | 文件 | 改了什么 | 为什么 | 上游有没有 |
|---|---|---|---|---|
| 1 | `lib/registry.js` | 重启时先 resume 旧会话，失败才退役 | 原来每次重启都分裂新会话 | 未知 |
| 2 | `lib/outbound.js` | `stripActions` 保留文字颜 `(￣▽￣)` | 原来把所有括号内容当动作删光 | 未知 |
| 3 | `lib/bridge.js` | `source.kind` 按 `synthetic` 分叉 | 系统唤醒和真人私聊要能区分 | 未知 |
| 4 | `lib/tools.js` | `send_qzone_msg` 的本地图片转 base64 | NapCat 在 Docker 里读不到宿主机文件 | 未知 |

---

## 1. 会话不分裂（registry.js）

详版见 [PATCH-onebot-session-split.md](./PATCH-onebot-session-split.md)。

一句话：`hasPersistedLog` 那个分支从「退役 + 换新 id」改成「先 resume，失败才退役」。

---

## 2. `stripActions` 保留文字颜（outbound.js）

### 现象

她发 `(￣▽￣)`、`(๑•̀ㅂ•́)و✧` 这类文字颜，到 QQ 那边**被吃掉了**，只剩纯文字。

### 原逻辑

```js
// 把所有「括号里有点内容」的片段当动作字幕删掉
text.replace(/\(([^)]{0,120})\)/g, '')
```

副作用：颜文字也是括号包着的，一起没了。

### 补丁

`isAction(inner)` 只认「括号里有中文或 ≥2 个连续字母」的，颜文字（纯符号）保留：

```js
const isAction = (inner) => /[\u4e00-\u9fa5]|[A-Za-z]{2,}/.test(inner);
text.replace(/\(([^)]{0,120})\)/g, (m, inner) => (isAction(inner) ? '' : m));
```

### 注意

回调必须是 `(m, inner)` —— **只有一个捕获组**。早先误写成 `(m, _open, inner)`，`inner` 拿到 `undefined`，结果一个都没删。

---

## 3. `source.kind` 按 synthetic 分叉（bridge.js）

### 现象

定时唤醒注入的是**一条假的私聊消息**，下游（dsh-remembers）把它当成"老大说的话"，写进记忆、学成口头禅、涨亲密度、甚至把自己的画像名字覆盖成「系统」。

### 根因

`bridge.js` 里建消息只有一处，`source.kind` 写死：

```js
chat.agent.followup(createUserMessage({
  content: [{ type: 'text', text: final }],
  source: { kind: 'plugin:dsh-onebot' },   // ← 真人私聊和系统唤醒盖同一个章
}));
```

### 补丁

两处：

**(a) `handleInbound` 把 `event.synthetic` 带进 round：**

```js
? runInjectRound({ traceId: newTraceId(), intercepted: 0,
                   silent: event?.silent === true,
                   synthetic: event?.synthetic === true }, run)
```

**(b) 建消息时按标记分叉：**

```js
chat.agent.followup(createUserMessage({
  content: [{ type: 'text', text: final }],
  source: { kind: currentInjectRound()?.synthetic === true
      ? 'system:nudge'
      : 'plugin:dsh-onebot' },
}));
```

配合调度器侧：注入事件带 `"synthetic": true`、`"nickname": ""`。

dsh-remembers 的 `isSynthetic()` 对 `system:nudge` 返回 true → 唤醒轮不写记忆、不学口头禅、不涨亲密度、不覆盖画像。

---

## 4. `send_qzone_msg` 本地图片转 base64（tools.js）

### 现象

她发 QQ 空间说说带图，NapCat 报：

```
[Bridge.Action] send_qzone_msg failed:
  第 1 张图片上传失败: ENOENT: no such file or directory,
  stat '/home/ubuntu/.dsh/media/onebot/memes/xxx.jpg'
```

### 根因

`qq_napcat_api` 是**纯透传**，没有做任何路径处理：

```js
const params = typeof a.params === 'object' && a.params !== null ? a.params : {};
return await connection.call(a.action, params);
```

而 NapCat 的 `images` 虽然官方支持 `file://` / `http(s)://` / `base64://`（源码 `SendQzoneMsg.ts` 里写着「自动上传」），但**`file://` 是相对 NapCat 自己的文件系统**：

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

**两种部署都兼容，不需要分平台。** 代价只是本地部署时多一次读文件 + base64 编码，几 KB 到几 MB 的图可以忽略。

### 已知限制

- `mediaRoots()` 是媒体目录白名单。如果图片放在白名单外的目录（比如 `/tmp`），会被拦，报「本地路径不在允许的媒体目录内」。这是**故意的**，别为了发一张图把白名单放开。
- 大图会变成很长的 base64 字符串。上限沿用 `limits.maxImageBytes`（默认 8 MB），超了直接报错而不是硬塞。

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

一个小技巧：升级前先备份整个 `lib/` 目录：

```bash
cp -r lib lib.bak-before-upgrade
```

出问题能立刻回退。
