# dsh-onebot-qq 会话不分裂补丁

`dsh-onebot-qq` 的 `registry.js` 里有一段逻辑会让**每次重启都分裂出新会话**：

```js
// 原逻辑（registry.js ~198 行）
else if (await this.hasPersistedLog(sessionId)) {
    // 磁盘上有旧日志 → 退役它，换一个带随机后缀的新 id
    this.retireSession(sessionId);
    sessionId = this.freshSessionId(chatId);
}
```

结果：QQ 对话每重启一次，就多一个「未命名」会话，历史被切成好几段。

## 补丁

把上面那段改成「先尝试 resume，失败才退役」：

```js
else if (await this.hasPersistedLog(sessionId)) {
    // 重启后继续用旧会话（resume），而不是退役开新的。
    try {
        const resumed = await this.resumeChat(chatId, sessionId);
        if (resumed !== undefined) {
            this.deps.log('info', 'resumed persisted session ' + sessionId + ' (no split)');
            return resumed;
        }
    }
    catch (error) {
        this.deps.log('warn', 'resume of persisted session failed for ' + sessionId + ', retiring: ' + describeError(error));
    }
    this.retireSession(sessionId);
    sessionId = this.freshSessionId(chatId);
}
```

## 应用

对每个 profile 的插件副本各改一次：

```bash
# 主套
$DSH_HOME/profiles/web/node_modules/dsh-onebot-qq/lib/registry.js
# 第二套
$DSH_HOME2/profiles/qq2/node_modules/dsh-onebot-qq/lib/registry.js
```

改完重启 `dsh-web` / `dsh-web2`。

## 注意

- 会话文件（`session.v4.jsonl.zstd`）**不能直接 cp 改名**——文件头里记着原会话 id，目录名和 id 不一致会 `corrupt session log`，整个会话加载失败。
- 分裂之后想合并历史，只能改 `chat-sessions.json` 让插件 resume 指定的那个会话：

```json
{
  "private:<QQ号>": "onebot-private-<QQ号>-<后缀>"
}
```

文件位置：`$DSH_HOME/media/onebot/chat-sessions.json`（主套）、`media/onebot2/`（第二套）。
